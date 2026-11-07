import HttpError from "../models/httpError.model.js";
import { assertId, keys, timestamp, uniqueId } from "../lib/keys.js";
import { getJson, putJson, softDelete } from "../lib/json.js";
import { addDays, parseFrequency, resolveHorizon, resolveWhen, schedule, yearsBetween } from "../lib/frequency.js";
import { METHODS, fitModel, modelValue, replay, withNoise } from "../lib/forecastModel.js";
import { generatorTransactions, limitsFor, validateGenerator } from "../lib/generators.js";
import { evaluateExpression, expressionReferences, parseExpression } from "../lib/chartExpression.js";
import { resolveSeed, seedFor, seededRandom } from "../lib/random.js";

const ACCOUNTS_PER_STEP = 10;
const FORMULA_TERMS = ["value", "replay", "base", "g", "s", "i", "t", "age"];
const round = (value) => Math.round(value * 100) / 100;
// The period a date falls in (the last one starting on or before it).
function periodIndex(periods, date) {
  let low = 0;
  let high = periods.length - 1;
  while (low < high) { const mid = (low + high + 1) >> 1; if (periods[mid] <= date) low = mid; else high = mid - 1; }
  return low;
}

// Forecasts: a named definition per project ({project}/forecasts/{id}/$meta.json) with its results below it in the
// analysis layout. A run reads the analysis results, fits each account's model, projects it at the forecast's
// frequency to the horizon, and writes forecast transactions (replayed, model and generator ones).
export default function createForecastService({ store, indexService, workspaceService, projectService, resultsService, config, clock = () => new Date() }) {
  const indexKey = (tenant, project) => `${keys.forecasts(tenant, project)}$index.json`;
  const defKey = (tenant, project, id) => `${keys.forecastFolder(tenant, project, id)}$meta.json`;
  const scope = (id) => `forecasts/${id}`;
  const summary = (doc) => ({ id: doc.id, name: doc.name, frequency: doc.frequency, horizon: doc.horizon, updatedAt: doc.updatedAt });

  function validate(doc) {
    doc.name = String(doc.name || "").trim();
    if (!doc.name) throw new HttpError(400, "ERR-NAME", "name is required");
    doc.frequency = doc.frequency || "1m";
    parseFrequency(doc.frequency);
    doc.horizon = doc.horizon || { type: "duration", value: "10y" };
    if (!["duration", "date", "age"].includes(doc.horizon.type)) throw new HttpError(400, "ERR-HORIZON", "horizon.type is duration, date or age");
    doc.lookbackYears = Number(doc.lookbackYears ?? 3);
    if (!(doc.lookbackYears > 0 && doc.lookbackYears <= 50)) throw new HttpError(400, "ERR-FORECAST", "lookbackYears is between 0 and 50");
    doc.settings = { replay: true, seasonality: true, noise: false, maxGrowth: 0.25, ...(doc.settings || {}) };
    doc.seed = doc.seed?.mode ? doc.seed : { mode: "time", value: Date.now() % 4294967296 };
    doc.inflation = Object.fromEntries(Object.entries(doc.inflation || {}).map(([category, rate]) => {
      const value = Number(rate);
      if (!Number.isFinite(value) || Math.abs(value) > 1) throw new HttpError(400, "ERR-FORECAST", `inflation for ${category} is a fraction per year (0.03 = 3%)`);
      return [category, value];
    }));
    doc.accounts = Object.fromEntries(Object.entries(doc.accounts || {}).map(([account, settings]) => {
      const clean = { ...settings };
      if (clean.method && !METHODS.includes(clean.method)) throw new HttpError(400, "ERR-FORECAST", `${account}: method must be one of ${METHODS.join(", ")}`);
      if (clean.formula) {
        const tree = parseExpression(String(clean.formula));
        if (expressionReferences(tree).aggregated.length) throw new HttpError(400, "ERR-FORECAST", `${account}: formulas cannot use aggregates`);
      }
      return [account, clean];
    }));
    doc.generators = (Array.isArray(doc.generators) ? doc.generators : []).map(validateGenerator);
    return doc;
  }

  async function list(tenant, project) { return await indexService.list(indexKey(tenant, project)); }
  async function get(tenant, project, id) {
    assertId(id, "forecast id");
    try { return await getJson(store, defKey(tenant, project, id)); }
    catch (error) { if (error.statusCode === 404) throw new HttpError(404, "ERR-NOT-FOUND", `forecast ${id} was not found`); throw error; }
  }
  async function write(tenant, project, doc) {
    await putJson(store, defKey(tenant, project, doc.id), doc);
    await indexService.upsert(indexKey(tenant, project), summary(doc));
    return doc;
  }
  async function create(tenant, project, input) {
    await workspaceService.get(tenant, "project", project);
    const taken = new Set((await list(tenant, project)).map((item) => item.id));
    const id = input.id ? assertId(input.id, "forecast id") : uniqueId(input.name, taken, "forecast");
    if (taken.has(id)) throw new HttpError(409, "ERR-EXISTS", `forecast ${id} already exists`);
    const now = clock().toISOString();
    return await write(tenant, project, validate({ ...input, id, createdAt: now, updatedAt: now }));
  }
  async function update(tenant, project, id, input) {
    const current = await get(tenant, project, id);
    return await write(tenant, project, validate({ ...current, ...input, id, createdAt: current.createdAt, updatedAt: clock().toISOString() }));
  }
  async function clone(tenant, project, id, { name } = {}) {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = await get(tenant, project, id);
    return await create(tenant, project, { ...rest, name: name || `${rest.name} (copy)` });
  }
  async function remove(tenant, project, id) {
    await get(tenant, project, id);
    await softDelete(store, defKey(tenant, project, id), timestamp(clock()));
    await indexService.remove(indexKey(tenant, project), id);
    return { deleted: id };
  }

  // The plan of a run: start (the day after the last actual), end, periods and every account's settings.
  async function context(tenant, project, forecast) {
    const meta = await workspaceService.get(tenant, "project", project);
    const analysis = await resultsService.meta(tenant, project, "analysis");
    if (!analysis?.lastDate) throw new HttpError(409, "ERR-NO-ANALYSIS", "run the analysis first: a forecast starts after the last actual transaction");
    const asOf = analysis.lastDate;
    const start = addDays(asOf, 1);
    const end = resolveHorizon(start, forecast.horizon, meta.birthDate, config.maxForecastYears);
    const accounts = await projectService.accounts.all(tenant, project);
    const periods = schedule(start, end, parseFrequency(forecast.frequency), config.maxForecastPoints);
    if (periods.length * accounts.length > config.maxForecastPoints) throw new HttpError(422, "ERR-FORECAST-LIMIT", `${periods.length} periods x ${accounts.length} accounts is more than ${config.maxForecastPoints} points; use a longer frequency or a shorter horizon`);
    return { meta, asOf, start, end, accounts, periods };
  }

  function settingsFor(forecast, meta, account) {
    const category = meta.categories.find((item) => item.id === account.category);
    const own = forecast.accounts[account.id] || forecast.accounts[account.shortCode] || {};
    const inflation = own.inflation ?? forecast.inflation[account.category] ?? category?.inflation ?? 0;
    return { ...own, method: own.method || "replay+trend", inflation: Number(inflation) };
  }

  const handler = {
    async plan(job) {
      const forecast = await get(job.tenant, job.project, job.params.forecast);
      const { asOf, start, end, accounts, periods } = await context(job.tenant, job.project, forecast);
      job.state = { phase: "model", asOf, start, end, accounts: accounts.map((account) => account.id), index: 0, written: [], periods: periods.length };
      job.progress = { message: "starting", done: 0, total: accounts.length * 2 };
    },
    async step(job, ctx) {
      const state = job.state;
      const forecast = await get(job.tenant, job.project, job.params.forecast);
      const meta = await workspaceService.get(job.tenant, "project", job.project);
      const accounts = await projectService.accounts.all(job.tenant, job.project);
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const frequency = parseFrequency(forecast.frequency);
      const periods = schedule(state.start, state.end, frequency, config.maxForecastPoints);
      const seed = resolveSeed(forecast.seed);
      if (state.phase === "model") {
        // Per account: fit the model and project it; values per period go to a work file for the next phase.
        for (const id of state.accounts.slice(state.index, state.index + ACCOUNTS_PER_STEP)) {
          const account = byId.get(id);
          if (!account) continue;
          const settings = settingsFor(forecast, meta, account);
          const transactions = await resultsService.all(job.tenant, job.project, "analysis", id);
          const terms = fitModel(transactions.filter((tx) => tx.kind !== "forecast"), { asOf: state.asOf, lookbackYears: forecast.lookbackYears, inflation: settings.inflation, method: settings.method, settings: { ...forecast.settings, ...settings } });
          const random = seededRandom(seedFor(seed, id));
          const replayed = replay(terms, state.asOf, state.end);
          const values = periods.map((date, i) => {
            const until = periods[i + 1] || state.end;
            let value = modelValue(terms, date, until, state.asOf);
            if (forecast.settings.noise) value = withNoise(terms, value, date, until, state.asOf, random);
            return round(value);
          });
          const aggregates = await resultsService.aggregates(job.tenant, job.project, "analysis", id);
          await putJson(store, ctx.workKey(`acc-${id}`), { id, terms, values, replayed, opening: aggregates?.total?.running || 0 });
        }
        state.index += ACCOUNTS_PER_STEP;
        ctx.progress("fitting models", Math.min(state.index, state.accounts.length), state.accounts.length * 2);
        if (state.index >= state.accounts.length) { state.phase = "write"; state.index = 0; }
        return false;
      }
      if (state.phase === "write") {
        const cache = new Map();
        const work = async (id) => { if (!cache.has(id)) cache.set(id, await getJson(store, ctx.workKey(`acc-${id}`), null)); return cache.get(id); };
        const byCode = new Map(accounts.filter((account) => account.shortCode).map((account) => [account.shortCode, account.id]));
        for (const id of state.accounts.slice(state.index, state.index + ACCOUNTS_PER_STEP)) {
          const account = byId.get(id);
          const data = await work(id);
          if (!account || !data) continue;
          const settings = settingsFor(forecast, meta, account);
          const activeFrom = resolveWhen(settings.start, meta.birthDate);
          const activeUntil = resolveWhen(settings.end, meta.birthDate);
          const active = (date) => (!activeFrom || date >= activeFrom) && (!activeUntil || date < activeUntil);
          const formula = settings.formula ? parseExpression(String(settings.formula)) : null;
          const others = formula ? expressionReferences(formula).lines.filter((name) => !FORMULA_TERMS.includes(name)) : [];
          const otherValues = {};
          for (const name of others) {
            const otherId = byCode.get(name) || (byId.has(name) ? name : null);
            if (!otherId) throw new HttpError(400, "ERR-FORECAST", `${account.name}: the formula uses ${name}, which is not an account short code`);
            otherValues[name] = (await work(otherId))?.values || [];
          }
          const generators = forecast.generators.filter((generator) => generator.account === id || generator.account === account.shortCode);
          const transactions = [];
          // Replayed transactions and generator ones, then one model transaction per period.
          const replayByPeriod = new Map();
          for (const tx of data.replayed) {
            const p = periodIndex(periods, tx.date);
            replayByPeriod.set(p, (replayByPeriod.get(p) || 0) + tx.amount);
            if (active(tx.date)) transactions.push({ ...tx, kind: "forecast" });
          }
          const random = seededRandom(seedFor(seed, `${id}:generators`));
          for (const generator of generators) for (const tx of generatorTransactions(generator, { start: state.start, end: state.end, birthDate: meta.birthDate, frequency, random })) if (active(tx.date)) transactions.push({ ...tx, kind: "forecast" });
          const periodTotals = new Map();
          for (const tx of transactions) {
            const index = periodIndex(periods, tx.date);
            periodTotals.set(index, (periodTotals.get(index) || 0) + tx.amount);
          }
          periods.forEach((date, i) => {
            if (!active(date)) return;
            let value = data.values[i];
            if (formula) {
              const t = yearsBetween(state.asOf, date);
              const terms = { value, replay: replayByPeriod.get(i) || 0, base: data.terms.base, g: data.terms.g, s: data.terms.seasonality ? data.terms.seasonality[Number(date.slice(5, 7)) - 1] : 1, i: data.terms.inflation, t, age: meta.birthDate ? yearsBetween(meta.birthDate, date) : 0 };
              // The formula gives the period's total; replayed transactions are already in it, so the model
              // transaction is the rest.
              const total = evaluateExpression(formula, { line: (name) => (name in terms ? terms[name] : otherValues[name]?.[i] ?? 0), aggregate: () => null });
              value = (total ?? 0) - terms.replay;
            }
            let periodTotal = (periodTotals.get(i) || 0) + value;
            const { floor, cap } = limitsFor(generators, date, meta.birthDate);
            if (floor !== null && periodTotal < floor) { value += floor - periodTotal; periodTotal = floor; }
            if (cap !== null && periodTotal > cap) { value -= periodTotal - cap; periodTotal = cap; }
            if (Math.abs(value) >= 0.005) transactions.push({ date, description: "Forecast", amount: round(value), source: "model", kind: "forecast" });
          });
          transactions.forEach((tx, seq) => { tx.seq = seq; });
          const { written } = await resultsService.writeAccount(job.tenant, job.project, scope(forecast.id), id, transactions, { opening: data.opening, extra: { model: data.terms } });
          state.written.push(...written);
        }
        state.index += ACCOUNTS_PER_STEP;
        ctx.progress("writing accounts", state.accounts.length + Math.min(state.index, state.accounts.length), state.accounts.length * 2);
        if (state.index >= state.accounts.length) state.phase = "finish";
        return false;
      }
      await resultsService.removeStale(job.tenant, job.project, scope(forecast.id), state.written);
      const models = {};
      for (const id of state.accounts) { const data = await getJson(store, ctx.workKey(`acc-${id}`), null); if (data) models[id] = data.terms; }
      await putJson(store, `${keys.forecastFolder(job.tenant, job.project, forecast.id)}model.json`, { asOf: state.asOf, accounts: models });
      await resultsService.writeMeta(job.tenant, job.project, scope(forecast.id), { status: "complete", jobId: job.id, finishedAt: clock().toISOString(), asOf: state.asOf, start: state.start, end: state.end, periods: state.periods, frequency: forecast.frequency, definitionUpdatedAt: forecast.updatedAt });
      return true;
    }
  };

  return {
    list, get, create, update, clone, remove, handler, scope,
    model: (tenant, project, id) => getJson(store, `${keys.forecastFolder(tenant, project, id)}model.json`, null),
    meta: (tenant, project, id) => resultsService.meta(tenant, project, scope(id))
  };
}
