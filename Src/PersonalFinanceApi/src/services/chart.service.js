import HttpError from "../models/httpError.model.js";
import { BUCKETS, MEASURES, combineAggregates } from "../lib/aggregate.js";
import { evaluateExpression, expressionReferences, isLineName, parseExpression } from "../lib/chartExpression.js";

export const SERIES_TYPES = ["account", "category", "tag", "calculate"];

// Charts: named per project; each series is an account (by short code or id), a category or tag total, or a
// calculation over other series (the Timeseries expression language). Calculated by the API: per bucket
// (monthly, quarterly, yearly), the series' measure, separately for actuals (analysis) and for a forecast.
export function validateChart(chart) {
  const out = { ...chart, name: String(chart.name || "").trim() };
  if (!out.name) throw new HttpError(400, "ERR-NAME", "name is required");
  out.bucket = chart.bucket || "monthly";
  if (!BUCKETS.includes(out.bucket)) throw new HttpError(400, "ERR-CHART", `bucket must be one of ${BUCKETS.join(", ")}`);
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
    const clean = { name, type: item.type, color: item.color || null, axis: item.axis === "right" ? "right" : "left", hidden: item.hidden === true, label: item.label || null };
    if (item.type === "calculate") {
      const tree = parseExpression(String(item.expression || ""));
      if (expressionReferences(tree).aggregated.length) throw new HttpError(400, "ERR-CHART", `${name}: chart formulas use series values, not aggregates`);
      clean.expression = String(item.expression);
    } else {
      if (!item.ref) throw new HttpError(400, "ERR-CHART", `${name}: ref (the account, category or tag) is required`);
      clean.ref = String(item.ref);
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
  async function accountsFor(tenant, project, series, accounts) {
    if (series.type === "account") {
      const account = accounts.find((item) => item.shortCode === series.ref || item.id === series.ref);
      if (!account) throw new HttpError(400, "ERR-CHART", `${series.name}: account ${series.ref} was not found`);
      return [account.id];
    }
    if (series.type === "category") return accounts.filter((item) => item.category === series.ref).map((item) => item.id);
    return accounts.filter((item) => (item.tags || []).includes(series.ref)).map((item) => item.id);
  }

  async function data(tenant, project, input) {
    const chart = validateChart(input);
    const accounts = await projectService.accounts.list(tenant, project);
    const scopes = [];
    if (chart.includeActuals || !chart.forecast) scopes.push({ kind: "actual", scope: "analysis" });
    if (chart.forecast) { await forecastService.get(tenant, project, chart.forecast); scopes.push({ kind: "forecast", scope: forecastService.scope(chart.forecast) }); }
    const bySeries = {};
    const periods = new Set();
    const cache = new Map();
    const aggregatesOf = async (scope, id) => { const key = `${scope}|${id}`; if (!cache.has(key)) cache.set(key, await resultsService.aggregates(tenant, project, scope, id)); return cache.get(key); };
    for (const series of chart.series.filter((item) => item.type !== "calculate")) {
      const ids = await accountsFor(tenant, project, series, accounts);
      bySeries[series.name] = {};
      for (const { kind, scope } of scopes) {
        const list = (await Promise.all(ids.map((id) => aggregatesOf(scope, id)))).filter(Boolean);
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
      name: chart.name, bucket: chart.bucket, forecast: chart.forecast, buckets,
      series: chart.series.filter((item) => !item.hidden).map((item) => ({
        name: item.name, label: item.label || item.name, color: item.color, axis: item.axis,
        actual: bySeries[item.name].actual ? buckets.map((period) => bySeries[item.name].actual.get(period) ?? null) : null,
        forecast: bySeries[item.name].forecast ? buckets.map((period) => bySeries[item.name].forecast.get(period) ?? null) : null
      }))
    };
  }

  return { data, validate: validateChart };
}
