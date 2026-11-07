import { addDays, addMonths, daysBetween, daysInMonth, yearsBetween } from "./frequency.js";
import { gaussian } from "./random.js";

export const METHODS = ["replay+trend", "trend", "average", "last", "fixed", "none"];
// Recurring transaction cadences: days between occurrences and the step to replay them with.
const CADENCES = [
  { name: "weekly", min: 6, max: 8, step: { unit: "d", n: 7 } },
  { name: "fortnightly", min: 13, max: 15, step: { unit: "d", n: 14 } },
  { name: "monthly", min: 26, max: 35, step: { unit: "m", n: 1 } },
  { name: "quarterly", min: 84, max: 98, step: { unit: "m", n: 3 } },
  { name: "half-yearly", min: 175, max: 190, step: { unit: "m", n: 6 } },
  { name: "yearly", min: 355, max: 375, step: { unit: "m", n: 12 } }
];

const round = (value) => Math.round(value * 100) / 100;
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
function median(values) { const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function regression(points) {
  if (points.length < 2) return { a: mean(points.map((p) => p.y)), b: 0 };
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  const sxx = points.reduce((sum, p) => sum + (p.x - mx) ** 2, 0);
  const b = sxx ? points.reduce((sum, p) => sum + (p.x - mx) * (p.y - my), 0) / sxx : 0;
  return { a: my - b * mx, b };
}
export function descriptionKey(text) { return String(text || "").toLowerCase().replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim(); }
const monthOf = (date) => date.slice(0, 7);
function step(date, cadence, k) { return cadence.unit === "d" ? addDays(date, cadence.n * k) : addMonths(date, cadence.n * k); }

// Recurring transactions: the same description (digits ignored) at least 3 times in the lookback, at a regular
// interval (70% of the gaps within a cadence's range) and still going (the last one within two intervals).
export function findRecurring(transactions, asOf) {
  const groups = new Map();
  for (const tx of transactions) { const key = descriptionKey(tx.description); if (!key) continue; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(tx); }
  const recurring = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = sorted.slice(1).map((tx, i) => daysBetween(sorted[i].date, tx.date)).filter((gap) => gap > 0);
    if (gaps.length < 2) continue;
    const typical = median(gaps);
    const cadence = CADENCES.find((candidate) => typical >= candidate.min && typical <= candidate.max);
    if (!cadence) continue;
    if (gaps.filter((gap) => gap >= cadence.min && gap <= cadence.max).length / gaps.length < 0.7) continue;
    const last = sorted.at(-1);
    if (daysBetween(last.date, asOf) > cadence.max * 2) continue;
    recurring.push({ key, description: last.description, cadence: cadence.name, step: cadence.step, lastDate: last.date, amount: round(mean(sorted.slice(-3).map((tx) => tx.amount))), count: sorted.length });
  }
  return recurring.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

// The model terms of one account from its history up to asOf (see doc/requirements.md, Forecast model):
// deflate by the category's inflation, linear trend of real values (base, growth g per year), a seasonal factor
// per calendar month (with 2+ years), the spread of residuals (sigma) and the min/max band's own trends.
export function fitModel(transactions, { asOf, lookbackYears = 3, inflation = 0, method = "replay+trend", settings = {} }) {
  const from = addMonths(asOf, -Math.round(lookbackYears * 12));
  const window = transactions.filter((tx) => tx.date > from && tx.date <= asOf);
  const useReplay = method === "replay+trend" && settings.replay !== false;
  const recurring = useReplay ? findRecurring(window, asOf) : [];
  const recurringKeys = new Set(recurring.map((item) => item.key));
  const residual = window.filter((tx) => !recurringKeys.has(descriptionKey(tx.description)));
  // Whole months from the first in the window to asOf's month (empty months count as 0).
  const months = [];
  if (window.length) for (let month = monthOf(window.reduce((min, tx) => (tx.date < min ? tx.date : min), asOf)) + "-01"; monthOf(month) <= monthOf(asOf); month = addMonths(month, 1, 1)) months.push(monthOf(month));
  const sums = new Map(months.map((month) => [month, 0]));
  for (const tx of residual) sums.set(monthOf(tx.date), (sums.get(monthOf(tx.date)) || 0) + tx.amount);
  const points = months.map((month) => {
    const x = -yearsBetween(`${month}-15`, asOf);
    const nominal = sums.get(month);
    return { month, x, nominal, y: nominal * (1 + inflation) ** -x };
  });
  const terms = { method, inflation, lookbackYears, months: points.length, recurring, base: 0, g: 0, seasonality: null, sigma: 0, band: null, lastMonth: points.at(-1)?.nominal ?? 0 };
  if (!points.length || method === "none") return terms;
  if (method === "fixed") { terms.base = Number(settings.value || 0); return terms; }
  if (method === "average") { terms.base = mean(points.map((p) => p.y)); }
  else if (method === "last") { terms.base = points.at(-1).y; }
  else {
    const { a, b } = regression(points);
    terms.base = points.length >= 3 ? a : mean(points.map((p) => p.y));
    const maxGrowth = settings.maxGrowth ?? 0.25;
    terms.g = points.length >= 6 && Math.abs(terms.base) > 0.01 ? Math.max(-maxGrowth, Math.min(maxGrowth, b / terms.base)) : 0;
    if (settings.growth !== undefined && settings.growth !== null && settings.growth !== "") terms.g = Number(settings.growth);
    const fitted = (p) => terms.base * (1 + terms.g) ** p.x;
    if (points.length >= 24 && settings.seasonality !== false) {
      const ratios = Array.from({ length: 12 }, () => []);
      for (const p of points) { const f = fitted(p); if (Math.abs(f) > 0.01) ratios[Number(p.month.slice(5, 7)) - 1].push(p.y / f); }
      const raw = ratios.map((list) => (list.length ? Math.max(0, Math.min(3, mean(list))) : 1));
      const average = mean(raw) || 1;
      terms.seasonality = raw.map((value) => value / average);
    }
    const season = (p) => (terms.seasonality ? terms.seasonality[Number(p.month.slice(5, 7)) - 1] : 1);
    const residuals = points.map((p) => p.y - fitted(p) * season(p));
    terms.sigma = Math.sqrt(mean(residuals.map((r) => r * r)));
    // The band: the lowest and highest month of each year, each with its own trend, so the gap can widen or narrow.
    const years = new Map();
    for (const p of points) { const year = Math.floor(p.x); if (!years.has(year)) years.set(year, []); years.get(year).push(p); }
    if (years.size >= 2) {
      const mins = [...years].map(([, list]) => ({ x: mean(list.map((p) => p.x)), y: Math.min(...list.map((p) => p.y)) }));
      const maxs = [...years].map(([, list]) => ({ x: mean(list.map((p) => p.x)), y: Math.max(...list.map((p) => p.y)) }));
      const low = regression(mins); const high = regression(maxs);
      terms.band = { min: { a: low.a, b: low.b }, max: { a: high.a, b: high.b } };
    }
  }
  return terms;
}

// The model's value for a period [start, end): each month it overlaps adds its monthly value times the share of
// the month covered. Monthly value at t years ahead = base x (1 + g)^t x s(month) x (1 + i)^t.
export function modelValue(terms, start, end, asOf) {
  if (terms.method === "none" || !terms.months) return 0;
  let total = 0;
  let cursor = start;
  while (cursor < end) {
    const monthEnd = addMonths(`${cursor.slice(0, 7)}-01`, 1, 1);
    const until = end < monthEnd ? end : monthEnd;
    const share = daysBetween(cursor, until) / daysInMonth(cursor);
    const t = yearsBetween(asOf, cursor);
    const season = terms.seasonality ? terms.seasonality[Number(cursor.slice(5, 7)) - 1] : 1;
    const growth = terms.method === "fixed" ? 1 : (1 + terms.g) ** t;
    const inflation = terms.method === "fixed" ? 1 : (1 + terms.inflation) ** t;
    total += terms.base * growth * season * inflation * share;
    cursor = until;
  }
  return total;
}

// Noise within the band (monthly sigma scaled to the period), clamped to the min/max band's trend at t.
export function withNoise(terms, value, start, end, asOf, random) {
  if (!terms.sigma) return value;
  const months = daysBetween(start, end) / 30.44;
  const t = yearsBetween(asOf, start);
  const inflation = (1 + terms.inflation) ** t;
  let next = value + gaussian(random) * terms.sigma * Math.sqrt(Math.max(months, 0.03)) * inflation;
  if (terms.band) {
    const low = (terms.band.min.a + terms.band.min.b * t) * months * inflation;
    const high = (terms.band.max.a + terms.band.max.b * t) * months * inflation;
    next = Math.max(Math.min(low, high), Math.min(Math.max(low, high), next));
  }
  return next;
}

// Recurring transactions replayed at their own cadence after asOf, until end, with inflation.
export function replay(terms, asOf, end) {
  const out = [];
  for (const item of terms.recurring) {
    for (let k = 1; ; k += 1) {
      const date = step(item.lastDate, item.step, k);
      if (date <= asOf) continue;
      if (date >= end) break;
      out.push({ date, description: item.description, amount: round(item.amount * (1 + terms.inflation) ** yearsBetween(asOf, date)), source: "replay", cadence: item.cadence });
      if (out.length > 1000000) break;
    }
  }
  return out;
}
