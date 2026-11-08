// Stored with every analysis and forecast run.
export const BUCKETS = ["monthly", "quarterly", "yearly"];
// Charts and aggregates can also go by day or week (worked out from the transactions).
export const CHART_BUCKETS = ["daily", "weekly", ...BUCKETS];
export const MEASURES = ["sum", "running", "count", "avg", "min", "max"];

// A week is named by its Monday (ISO weeks).
function mondayOf(date) {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

export function periodOf(date, bucket) {
  if (bucket === "daily") return date.slice(0, 10);
  if (bucket === "weekly") return mondayOf(date);
  const year = date.slice(0, 4);
  if (bucket === "yearly") return year;
  const month = Number(date.slice(5, 7));
  return bucket === "quarterly" ? `${year}-Q${Math.ceil(month / 3)}` : `${year}-${date.slice(5, 7)}`;
}
export function periodStart(period) {
  if (/^\d{4}$/.test(period)) return `${period}-01-01`;
  const quarter = period.match(/^(\d{4})-Q(\d)$/);
  if (quarter) return `${quarter[1]}-${String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, "0")}-01`;
  return `${period}-01`;
}
function round(value) { return Math.round(value * 100) / 100; }

// Running totals per transaction (in date order) and, per bucket, each period's sum, running total at its end,
// count, average, minimum and maximum. Built in one pass as the transactions are written.
export function aggregate(transactions, opening = 0) {
  const result = Object.fromEntries(BUCKETS.map((bucket) => [bucket, []]));
  const current = {};
  let running = opening;
  for (const tx of transactions) {
    running = round(running + tx.amount);
    tx.running = running;
    for (const bucket of BUCKETS) {
      const period = periodOf(tx.date, bucket);
      let entry = current[bucket];
      if (!entry || entry.period !== period) { entry = { period, sum: 0, count: 0, min: tx.amount, max: tx.amount, running }; result[bucket].push(entry); current[bucket] = entry; }
      entry.sum = round(entry.sum + tx.amount);
      entry.count += 1;
      entry.min = Math.min(entry.min, tx.amount);
      entry.max = Math.max(entry.max, tx.amount);
      entry.running = running;
      entry.avg = round(entry.sum / entry.count);
    }
  }
  return { ...result, total: { count: transactions.length, sum: round(running - opening), running, first: transactions[0]?.date || null, last: transactions.at(-1)?.date || null } };
}

// Several accounts' aggregates as one (a category or tag total): sums and counts add up, min and max are taken
// over all, the running total is the sum of each account's running total carried forward.
export function combineAggregates(list, bucket) {
  const periods = [...new Set(list.flatMap((aggregates) => (aggregates[bucket] || []).map((entry) => entry.period)))].sort();
  const lastRunning = list.map(() => 0);
  const lookups = list.map((aggregates) => new Map((aggregates[bucket] || []).map((entry) => [entry.period, entry])));
  return periods.map((period) => {
    const out = { period, sum: 0, count: 0, min: null, max: null, running: 0 };
    lookups.forEach((lookup, i) => {
      const entry = lookup.get(period);
      if (entry) {
        out.sum = round(out.sum + entry.sum); out.count += entry.count;
        out.min = out.min === null ? entry.min : Math.min(out.min, entry.min);
        out.max = out.max === null ? entry.max : Math.max(out.max, entry.max);
        lastRunning[i] = entry.running;
      }
      out.running = round(out.running + lastRunning[i]);
    });
    out.avg = out.count ? round(out.sum / out.count) : null;
    return out;
  });
}

// One bucket's entries (as aggregate) from transactions in date order, for the buckets not stored (daily, weekly).
export function aggregateFor(transactions, bucket, opening = 0) {
  const entries = [];
  let current = null;
  let running = opening;
  for (const tx of transactions) {
    running = round(running + tx.amount);
    const period = periodOf(tx.date, bucket);
    if (!current || current.period !== period) { current = { period, sum: 0, count: 0, min: tx.amount, max: tx.amount, running }; entries.push(current); }
    current.sum = round(current.sum + tx.amount);
    current.count += 1;
    current.min = Math.min(current.min, tx.amount);
    current.max = Math.max(current.max, tx.amount);
    current.running = running;
    current.avg = round(current.sum / current.count);
  }
  return entries;
}
