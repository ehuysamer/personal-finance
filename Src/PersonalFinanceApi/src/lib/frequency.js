import HttpError from "../models/httpError.model.js";

// Frequencies are {n}{unit}: d day, w week, m month, q quarter, y year (1d, 1w, 2w, 6m, 1y).
export function parseFrequency(text) {
  const match = String(text || "").trim().match(/^(\d{1,3})([dwmqy])$/);
  if (!match || Number(match[1]) < 1) throw new HttpError(400, "ERR-FREQUENCY", "frequency is a number and a unit: d, w, m, q or y (e.g. 1d, 1w, 6m)");
  const n = Number(match[1]);
  const unit = match[2];
  return unit === "w" ? { n: n * 7, unit: "d", text } : unit === "q" ? { n: n * 3, unit: "m", text } : unit === "y" ? { n: n * 12, unit: "m", text } : { n, unit, text };
}

export function toDate(text) { return new Date(`${text}T00:00:00Z`); }
export function fromDate(date) { return date.toISOString().slice(0, 10); }
export function addDays(text, days) { const date = toDate(text); date.setUTCDate(date.getUTCDate() + days); return fromDate(date); }
// Months are added keeping the day, clamped to the month's end (31 Jan + 1m = 28/29 Feb).
export function addMonths(text, months, day = Number(text.slice(8, 10))) {
  const date = toDate(text);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return fromDate(target);
}
export function step(text, frequency, k = 1, anchorDay) { return frequency.unit === "d" ? addDays(text, frequency.n * k) : addMonths(text, frequency.n * k, anchorDay); }
export function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000); }
export function yearsBetween(a, b) { return daysBetween(a, b) / 365.25; }
export function daysInMonth(text) { const date = toDate(text); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); }

// The dates start, start + f, start + 2f, ... before end (the anchor day keeps month steps on the same day).
export function schedule(start, end, frequency, limit = Infinity) {
  const dates = [];
  const anchor = Number(start.slice(8, 10));
  for (let k = 0; ; k += 1) {
    const date = step(start, frequency, k, anchor);
    if (date >= end) break;
    if (dates.length >= limit) throw new HttpError(422, "ERR-FORECAST-LIMIT", `the forecast would have more than ${limit} periods`);
    dates.push(date);
  }
  return dates;
}

// Where a forecast ends: { type: duration, value: "90d" | "10y" }, { type: date, value }, or { type: age, value }
// (from the project's birth date). Never beyond maxYears from the start.
export function resolveHorizon(start, horizon, birthDate, maxYears = 100) {
  let end;
  if (horizon?.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(horizon.value))) throw new HttpError(400, "ERR-HORIZON", "the horizon date is yyyy-mm-dd");
    end = horizon.value;
  } else if (horizon?.type === "age") {
    if (!birthDate) throw new HttpError(400, "ERR-HORIZON", "set the project's birth date to forecast until an age");
    const age = Number(horizon.value);
    if (!Number.isFinite(age) || age <= 0) throw new HttpError(400, "ERR-HORIZON", "the horizon age is a number");
    end = addMonths(birthDate, Math.round(age * 12));
  } else {
    const match = String(horizon?.value || "").match(/^(\d{1,5})([dwmy])$/);
    if (!match) throw new HttpError(400, "ERR-HORIZON", "a duration is a number of days, weeks, months or years (90d, 10y)");
    const n = Number(match[1]);
    end = match[2] === "d" ? addDays(start, n) : match[2] === "w" ? addDays(start, n * 7) : addMonths(start, match[2] === "y" ? n * 12 : n);
  }
  if (end <= start) throw new HttpError(400, "ERR-HORIZON", "the horizon ends before the forecast starts");
  if (yearsBetween(start, end) > maxYears) throw new HttpError(400, "ERR-HORIZON", `a forecast is at most ${maxYears} years`);
  return end;
}

// A point in time given as a date or { age } (from the birth date).
export function resolveWhen(value, birthDate) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value.age !== undefined && birthDate) return addMonths(birthDate, Math.round(Number(value.age) * 12));
  if (value.date) return value.date;
  return null;
}
