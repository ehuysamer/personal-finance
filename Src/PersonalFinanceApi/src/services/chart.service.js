import HttpError from "../models/httpError.model.js";
import { BUCKETS, CHART_BUCKETS, MEASURES, aggregateFor, combineAggregates, periodOf } from "../lib/aggregate.js";
import { evaluateExpression, expressionReferences, isLineName, parseExpression } from "../lib/chartExpression.js";

export const SERIES_TYPES = ["account", "accounts", "category", "categories", "categoryTypes", "tag", "calculate"];
export { CATEGORY_TYPES } from "./workspace.service.js";
import { CATEGORY_TYPES } from "./workspace.service.js";
export const AXES = ["left", "right", "virtual"];

// Charts: named per project; each series is an account (by short code or id), the sum of several accounts (refs), a
// category total, the total of several categories (refs), the total of every category of some types (refs: income,
// expense, asset, liability), a tag total, or a calculation over other series (the Timeseries expression language). Each series has a
// label and an axis: left, right, or virtual (its own scale over the chart's height, no axis drawn); the chart may
// title its axes (leftLabel, rightLabel). Calculated by the API: per bucket (daily, weekly, monthly, quarterly,
// yearly), the series' measure, separately for actuals (analysis) and for a forecast.
export function validateChart(chart) {
  const out = { ...chart, name: String(chart.name || "").trim() };
  if (!out.name) throw new HttpError(400, "ERR-NAME", "name is required");
  out.bucket = chart.bucket || "monthly";
  if (!CHART_BUCKETS.includes(out.bucket)) throw new HttpError(400, "ERR-CHART", `bucket must be one of ${CHART_BUCKETS.join(", ")}`);
  out.leftLabel = chart.leftLabel ? String(chart.leftLabel) : null;
  out.rightLabel = chart.rightLabel ? String(chart.rightLabel) : null;
  out.includeActuals = chart.includeActuals !== false;
  out.forecast = chart.forecast || null;
  const series = Array.isArray(chart.series) ? chart.series : [];
  if (!series.length) throw new HttpError(400, "ERR-CHART", "a chart needs at least one series");
  const names = new Set();
  out.series = series.map((item, i) => {
    const name = String(item.name || "").trim();
    if (!isLineName(name)) throw new HttpError(400, "ERR-CHART", `series ${i + 1}: name is letters, digits and _ (used in formulas)`);
    if (names.has(name)) throw new HttpError(400, "ERR-CHART", `series name ${name} is used twice`);
    names.add(name);
    if (!SERIES_TYPES.includes(item.type)) throw new HttpError(400, "ERR-CHART", `${name}: type must be one of ${SERIES_TYPES.join(", ")}`);
    if (item.axis && !AXES.includes(item.axis)) throw new HttpError(400, "ERR-CHART", `${name}: axis must be one of ${AXES.join(", ")}`);
    const clean = { name, type: item.type, color: item.color || null, axis: item.axis || "left", hidden: item.hidden === true, label: item.label ? String(item.label) : null };
    if (item.type === "calculate") {
      const tree = parseExpression(String(item.expression || ""));
      if (expressionReferences(tree).aggregated.length) throw new HttpError(400, "ERR-CHART", `${name}: chart formulas use series values, not aggregates`);
      clean.expression = String(item.expression);
    } else {
      if (["accounts", "categories", "categoryTypes"].includes(item.type)) {
        clean.refs = [...new Set((Array.isArray(item.refs) ? item.refs : []).map(String).filter(Boolean))];
        const what = { accounts: "the accounts", categories: "the categories", categoryTypes: "the category types" }[item.type];
        if (!clean.refs.length) throw new HttpError(400, "ERR-CHART", `${name}: refs (${what} to add up) are required`);
        if (item.type === "categoryTypes" && clean.refs.some((ref) => !CATEGORY_TYPES.includes(ref))) throw new HttpError(400, "ERR-CHART", `${name}: category types are ${CATEGORY_TYPES.join(", ")}`);
      } else {
        if (!item.ref) throw new HttpError(400, "ERR-CHART", `${name}: ref (the account, category or tag) is required`);
        clean.ref = String(item.ref);
      }
      clean.measure = item.measure || "running";
      if (!MEASURES.includes(clean.measure)) throw new HttpError(400, "ERR-CHART", `${name}: measure must be one of ${MEASURES.join(", ")}`);
    }
    return clean;
  });
  // Calculations may use each other in any order, not in a loop.
  const calc = new Map(out.series.filter((item) => item.type === "calculate").map((item) => [item.name, expressionReferences(parseExpression(item.expression)).lines]));
  for (const [name, refs] of calc) for (const ref of refs) if (!names.has(ref)) throw new HttpError(400, "ERR-CHART", `${name}: ${ref} is not a series of this chart`);
  const visiting = new Set(); const done = new Set();
  const visit = (name) => { if (done.has(name) || !calc.has(name)) return; if (visiting.has(name)) throw new HttpError(400, "ERR-CHART", `series ${name} refers to itself through other series`); visiting.add(name); calc.get(name).forEach(visit); visiting.delete(name); done.add(name); };
  [...calc.keys()].forEach(visit);
  return out;
}

export default function createChartService({ workspaceService, projectService, resultsService, forecastService }) {
  function accountsFor(tenant, project, series, accounts, categories = []) {
    const find = (ref) => {
      const account = accounts.find((item) => item.shortCode === ref || item.id === ref);
      if (!account) throw new HttpError(400, "ERR-CHART", `${series.name}: account ${ref} was not found`);
      return account.id;
    };
    if (series.type === "account") return [find(series.ref)];
    if (series.type === "accounts") return [...new Set(series.refs.map(find))];
    if (series.type === "category") return accounts.filter((item) => item.category === series.ref).map((item) => item.id);
    if (series.type === "categories") return accounts.filter((item) => series.refs.includes(item.category)).map((item) => item.id);
    if (series.type === "categoryTypes") {
      const wanted = new Set(categories.filter((category) => series.refs.includes(category.type)).map((category) => category.id));
      return accounts.filter((item) => wanted.has(item.category)).map((item) => item.id);
    }
    return accounts.filter((item) => (item.tags || []).includes(series.ref)).map((item) => item.id);
  }

  async function data(tenant, project, input) {
    const chart = validateChart(input);
    const accounts = await projectService.accounts.list(tenant, project);
    const { categories } = await workspaceService.get(tenant, "project", project);
    const scopes = [];
    if (chart.includeActuals || !chart.forecast) scopes.push({ kind: "actual", scope: "analysis" });
    if (chart.forecast) { await forecastService.get(tenant, project, chart.forecast); scopes.push({ kind: "forecast", scope: forecastService.scope(chart.forecast) }); }
    const bySeries = {};
    const periods = new Set();
    const cache = new Map();
    const aggregatesOf = async (scope, id) => { const key = `${scope}|${id}`; if (!cache.has(key)) cache.set(key, await resultsService.aggregates(tenant, project, scope, id)); return cache.get(key); };
    // Daily and weekly entries are worked out from an account's transactions (in the same shape as the stored ones).
    const bucketOf = async (scope, id) => {
      const stored = await aggregatesOf(scope, id);
      if (!stored || BUCKETS.includes(chart.bucket)) return stored;
      const key = `${scope}|${id}|${chart.bucket}`;
      if (!cache.has(key)) {
        const transactions = (await resultsService.all(tenant, project, scope, id)).sort((a, b) => a.date.localeCompare(b.date) || (a.seq ?? 0) - (b.seq ?? 0));
        cache.set(key, { [chart.bucket]: aggregateFor(transactions, chart.bucket, stored.opening || 0) });
      }
      return cache.get(key);
    };
    const currencyOf = await projectService.accounts.currencies(tenant, project);
    const currencies = {};
    for (const series of chart.series.filter((item) => item.type !== "calculate")) {
      const ids = accountsFor(tenant, project, series, accounts, categories);
      const codes = [...new Set(ids.map(currencyOf))];
      currencies[series.name] = codes.length === 1 ? codes[0] : null;
      bySeries[series.name] = {};
      for (const { kind, scope } of scopes) {
        const list = (await Promise.all(ids.map((id) => bucketOf(scope, id)))).filter(Boolean);
        const combined = combineAggregates(list, chart.bucket);
        const map = new Map(combined.map((entry) => [entry.period, entry[series.measure] ?? null]));
        bySeries[series.name][kind] = map;
        combined.forEach((entry) => periods.add(entry.period));
      }
    }
    let buckets = [...periods].sort();
    if (chart.start) buckets = buckets.filter((period) => period >= chart.start.slice(0, period.length));
    if (chart.end) buckets = buckets.filter((period) => period <= chart.end.slice(0, period.length));
    // Calculations per bucket and kind, in dependency order.
    const calc = chart.series.filter((item) => item.type === "calculate").map((item) => ({ ...item, tree: parseExpression(item.expression) }));
    const pending = [...calc];
    while (pending.length) {
      const index = pending.findIndex((item) => expressionReferences(item.tree).lines.every((name) => bySeries[name]));
      const item = pending.splice(index, 1)[0];
      bySeries[item.name] = {};
      for (const { kind } of scopes) {
        const map = new Map();
        for (const period of buckets) {
          const inputs = expressionReferences(item.tree).lines.map((name) => bySeries[name][kind]?.get(period));
          if (inputs.some((value) => value === undefined || value === null)) continue;
          map.set(period, evaluateExpression(item.tree, { line: (name) => bySeries[name][kind]?.get(period) ?? null, aggregate: () => null }));
        }
        bySeries[item.name][kind] = map;
      }
    }
    return {
      name: chart.name, bucket: chart.bucket, forecast: chart.forecast, buckets, leftLabel: chart.leftLabel, rightLabel: chart.rightLabel,
      series: chart.series.filter((item) => !item.hidden).map((item) => ({
        name: item.name, label: item.label || item.name, color: item.color, axis: item.axis, currency: currencies[item.name] || null,
        actual: bySeries[item.name].actual ? buckets.map((period) => bySeries[item.name].actual.get(period) ?? null) : null,
        forecast: bySeries[item.name].forecast ? buckets.map((period) => bySeries[item.name].forecast.get(period) ?? null) : null
      }))
    };
  }

  // The transactions behind a chart: every account of its series (a calculated series stands for the series it
  // uses), each tagged with its series and kind (actual or forecast); with period, only those in that bucket (the
  // items behind one row of the aggregates); with series, only that series'. Paged as account history is.
  async function transactions(tenant, project, input, paging = {}) {
    const chart = validateChart(input);
    const accounts = await projectService.accounts.list(tenant, project);
    const { categories } = await workspaceService.get(tenant, "project", project);
    const names = new Map(accounts.map((account) => [account.id, account.name]));
    const currencyOf = await projectService.accounts.currencies(tenant, project);
    const byName = new Map(chart.series.map((item) => [item.name, item]));
    const sources = (name, seen = new Set()) => {
      if (seen.has(name)) return [];
      seen.add(name);
      const item = byName.get(name);
      if (!item) throw new HttpError(400, "ERR-CHART", `${name} is not a series of this chart`);
      return item.type === "calculate" ? expressionReferences(parseExpression(item.expression)).lines.flatMap((ref) => sources(ref, seen)) : [item];
    };
    const wanted = paging.series ? sources(paging.series) : chart.series.filter((item) => item.type !== "calculate");
    const scopes = [];
    if (chart.includeActuals || !chart.forecast) scopes.push({ kind: "actual", scope: "analysis" });
    if (chart.forecast) { await forecastService.get(tenant, project, chart.forecast); scopes.push({ kind: "forecast", scope: forecastService.scope(chart.forecast) }); }
    const cache = new Map();
    const index = new Map();
    const list = [];
    for (const series of wanted) {
      for (const id of accountsFor(tenant, project, series, accounts, categories)) {
        for (const { kind, scope } of scopes) {
          const key = `${scope}|${id}`;
          if (!cache.has(key)) cache.set(key, await resultsService.all(tenant, project, scope, id));
          for (const tx of cache.get(key)) {
            if (paging.period && periodOf(tx.date, chart.bucket) !== paging.period) continue;
            if (chart.start && tx.date < chart.start) continue;
            if (chart.end && tx.date > chart.end) continue;
            // A transaction in several series (an account in two of them) is listed once, with all its series.
            const seen = `${scope}|${id}|${tx.date}|${tx.seq ?? ""}|${tx.description}|${tx.amount}`;
            const label = series.label || series.name;
            const known = index.get(seen);
            if (known) { if (!known.seriesNames.includes(series.name)) { known.seriesNames.push(series.name); known.seriesLabel += `, ${label}`; } continue; }
            const entry = { ...tx, kind: tx.kind || kind, accountId: id, accountName: names.get(id) || id, currency: currencyOf(id), series: series.name, seriesNames: [series.name], seriesLabel: label };
            index.set(seen, entry);
            list.push(entry);
          }
        }
      }
    }
    return resultsService.page(list, paging);
  }

  return { data, transactions, validate: validateChart };
}
