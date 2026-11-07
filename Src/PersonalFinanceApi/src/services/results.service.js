import { keys } from "../lib/keys.js";
import { getJson, putJson } from "../lib/json.js";
import { aggregate } from "../lib/aggregate.js";
import HttpError from "../models/httpError.model.js";

// Analysis and forecasts write the same layout below their scope ("analysis" or "forecasts/{name}"):
// accounts/{account}/transactions/{yyyy}.json and accounts/{account}/aggregates.json, then $meta.json last.
export default function createResultsService({ store }) {
  async function writeAccount(tenant, project, scope, account, transactions, { opening = 0, extra = {} } = {}) {
    const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || (a.seq ?? 0) - (b.seq ?? 0));
    const aggregates = aggregate(sorted, opening);
    const years = new Map();
    for (const tx of sorted) { const year = tx.date.slice(0, 4); if (!years.has(year)) years.set(year, []); years.get(year).push(tx); }
    const written = [];
    for (const [year, list] of years) {
      const key = keys.accountYear(tenant, project, scope, account, year);
      await putJson(store, key, { account, year, transactions: list });
      written.push(key);
    }
    const aggregatesKey = keys.accountAggregates(tenant, project, scope, account);
    await putJson(store, aggregatesKey, { account, years: [...years.keys()], opening, ...extra, ...aggregates });
    written.push(aggregatesKey);
    return { written, total: aggregates.total };
  }

  async function aggregates(tenant, project, scope, account) {
    return await getJson(store, keys.accountAggregates(tenant, project, scope, account), null);
  }
  async function meta(tenant, project, scope) { return await getJson(store, keys.resultsMeta(tenant, project, scope), null); }
  async function writeMeta(tenant, project, scope, value) { await putJson(store, keys.resultsMeta(tenant, project, scope), value); }

  // Files under the scope that this run did not write (accounts or years that are gone) are removed.
  async function removeStale(tenant, project, scope, keep) {
    const keepSet = new Set(keep);
    const prefix = `${keys.resultsFolder(tenant, project, scope)}accounts/`;
    let removed = 0;
    for (const key of await store.list(prefix)) if (!keepSet.has(key)) { await store.delete(key); removed += 1; }
    return removed;
  }

  // An account's transactions, paged: newest first by default; sort by date or amount; date range and text filter.
  async function history(tenant, project, scope, account, { page = 1, pageSize = 50, sort = "date", order = "desc", from, to, q } = {}) {
    const summary = await aggregates(tenant, project, scope, account);
    if (!summary) return { items: [], total: 0, page: 1, pageSize, pages: 0 };
    const size = Math.min(500, Math.max(1, Number(pageSize) || 50));
    const wanted = Math.max(1, Number(page) || 1);
    const text = String(q || "").trim().toLowerCase();
    if (!["date", "amount"].includes(sort)) throw new HttpError(400, "ERR-SORT", "sort is date or amount");
    const years = summary.years.filter((year) => (!from || year >= from.slice(0, 4)) && (!to || year <= to.slice(0, 4)));
    const filter = (tx) => (!from || tx.date >= from) && (!to || tx.date <= to) && (!text || `${tx.description} ${tx.account} ${tx.filename || ""}`.toLowerCase().includes(text));
    if (sort === "date" && !text && !from && !to) {
      // Only the years the page needs are read.
      const counts = summary.yearly.reduce((map, entry) => map.set(entry.period, entry.count), new Map());
      const ordered = order === "asc" ? years : [...years].reverse();
      const total = ordered.reduce((sum, year) => sum + (counts.get(year) || 0), 0);
      let skip = (wanted - 1) * size;
      const items = [];
      for (const year of ordered) {
        const count = counts.get(year) || 0;
        if (skip >= count) { skip -= count; continue; }
        const list = (await getJson(store, keys.accountYear(tenant, project, scope, account, year))).transactions;
        const sorted = order === "asc" ? list : [...list].reverse();
        items.push(...sorted.slice(skip, skip + size - items.length));
        skip = 0;
        if (items.length >= size) break;
      }
      return { items, total, page: wanted, pageSize: size, pages: Math.ceil(total / size) };
    }
    const all = [];
    for (const year of years) all.push(...(await getJson(store, keys.accountYear(tenant, project, scope, account, year))).transactions.filter(filter));
    const direction = order === "asc" ? 1 : -1;
    all.sort((a, b) => direction * (sort === "amount" ? a.amount - b.amount : a.date.localeCompare(b.date) || (a.seq ?? 0) - (b.seq ?? 0)));
    return { items: all.slice((wanted - 1) * size, wanted * size), total: all.length, page: wanted, pageSize: size, pages: Math.ceil(all.length / size) };
  }

  // Every transaction of an account in a scope (for lists combining actuals and a forecast).
  async function all(tenant, project, scope, account) {
    const summary = await aggregates(tenant, project, scope, account);
    const list = [];
    for (const year of summary?.years || []) list.push(...(await getJson(store, keys.accountYear(tenant, project, scope, account, year))).transactions);
    return list;
  }
  function page(list, { page: wanted = 1, pageSize = 50, sort = "date", order = "desc", from, to, q } = {}) {
    const text = String(q || "").trim().toLowerCase();
    const filtered = list.filter((tx) => (!from || tx.date >= from) && (!to || tx.date <= to) && (!text || `${tx.description} ${tx.bankAccount || ""} ${tx.filename || ""}`.toLowerCase().includes(text)));
    const direction = order === "asc" ? 1 : -1;
    filtered.sort((a, b) => direction * (sort === "amount" ? a.amount - b.amount : a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "actual" ? -1 : 1)));
    const size = Math.min(500, Math.max(1, Number(pageSize) || 50));
    const current = Math.max(1, Number(wanted) || 1);
    return { items: filtered.slice((current - 1) * size, current * size), total: filtered.length, page: current, pageSize: size, pages: Math.ceil(filtered.length / size) };
  }

  return { writeAccount, aggregates, meta, writeMeta, removeStale, history, all, page };
}
