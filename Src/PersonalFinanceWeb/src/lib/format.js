const money = new Intl.NumberFormat("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-NZ", { notation: "compact", maximumFractionDigits: 1 });

// Dollar currencies get a prefix (NZ$, US$, A$...); other currencies show their code (EUR 12.00).
const DOLLARS = { NZD: "NZ$", USD: "US$", AUD: "A$", CAD: "CA$", HKD: "HK$", SGD: "S$", FJD: "FJ$", TWD: "NT$", MXN: "MX$" };
export const CURRENCIES = ["NZD", "AUD", "USD", "EUR", "GBP", "CAD", "SGD", "HKD", "JPY", "CHF", "CNY", "FJD", "ZAR", "INR"];
export function currencyLabel(code) { return code ? DOLLARS[code] || code : ""; }
export function formatMoney(value, currency) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  const number = money.format(Math.abs(Number(value)));
  const sign = Number(value) < 0 ? "-" : "";
  if (!currency) return `${sign}${number}`;
  return DOLLARS[currency] ? `${sign}${DOLLARS[currency]}${number}` : `${currency} ${sign}${number}`;
}
export function formatCompact(value) { return value === null || value === undefined ? "" : compact.format(Number(value)); }
export function formatDate(text) {
  if (!text) return "";
  const date = new Date(`${String(text).slice(0, 10)}T00:00:00Z`);
  return date.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
export function formatPercent(value, digits = 1) { return value === null || value === undefined ? "" : `${(Number(value) * 100).toFixed(digits)}%`; }

// Frequencies {n}{d|w|m|q|y} in words (1w -> "weekly", 6m -> "every 6 months").
export function describeFrequency(text) {
  const match = String(text || "").match(/^(\d+)([dwmqy])$/);
  if (!match) return text || "";
  const n = Number(match[1]);
  const words = { d: ["daily", "days"], w: ["weekly", "weeks"], m: ["monthly", "months"], q: ["quarterly", "quarters"], y: ["yearly", "years"] }[match[2]];
  return n === 1 ? words[0] : `every ${n} ${words[1]}`;
}
export function isFrequency(text) { return /^[1-9]\d{0,2}[dwmqy]$/.test(String(text || "").trim()); }

export function slugHint(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63); }

// An import's outcome in words: how many were added, which importsource read it (and which read nothing first),
// and, when nothing was added, why.
export function describeImport(result, { into } = {}) {
  if (result.status === "already-imported") return `nothing imported: ${result.reason || `already imported as ${result.sameAs}`}`;
  const verb = result.status === "replaced" ? "imported again" : "imported";
  let text = `${verb}${into ? ` into ${into}` : ""}: ${result.added} added, ${result.alreadyPresent} already there`;
  if (result.importsourceName) text += ` (read by ${result.importsourceName}${result.triedFirst?.length ? ` after ${result.triedFirst.map((attempt) => attempt.name).join(", ")} read nothing` : ""})`;
  if (!result.added && result.reason) text += `. Nothing new: ${result.reason}`;
  else if (result.rejectedCount) text += `. ${result.rejectedCount} rows rejected`;
  return text;
}

// Transaction dates: yyyy/mm/dd, and the weekday shown under it.
export function formatTxDate(text) { return text ? String(text).slice(0, 10).replaceAll("-", "/") : ""; }
export function weekday(text) { return text ? new Date(`${String(text).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-NZ", { weekday: "long", timeZone: "UTC" }) : ""; }
