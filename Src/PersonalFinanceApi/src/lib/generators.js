import HttpError from "../models/httpError.model.js";
import { parseFrequency, resolveWhen, schedule, daysBetween, yearsBetween } from "./frequency.js";

export const GENERATOR_TYPES = ["random", "sine", "linear", "minimum", "maximum"];

function number(value, what, fallback) {
  if (value === undefined || value === null || value === "") { if (fallback !== undefined) return fallback; throw new HttpError(400, "ERR-GENERATOR", `${what} is required`); }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, "ERR-GENERATOR", `${what} must be a number`);
  return n;
}

// Generators add to (or take from) an account's forecast: random (min, max), sine (amplitude, periodDays, phase,
// offset), linear (from, then to at the end or slopePerYear), each at its own frequency between start and end
// (dates or { age }); minimum and maximum are a floor and a cap on the account's value in each period.
export function validateGenerator(input, index) {
  const name = String(input.name || `generator ${index + 1}`);
  if (!GENERATOR_TYPES.includes(input.type)) throw new HttpError(400, "ERR-GENERATOR", `${name}: type must be one of ${GENERATOR_TYPES.join(", ")}`);
  if (!input.account) throw new HttpError(400, "ERR-GENERATOR", `${name}: account is required`);
  const out = { name, type: input.type, account: input.account, enabled: input.enabled !== false, start: input.start || null, end: input.end || null };
  if (input.frequency) { parseFrequency(input.frequency); out.frequency = input.frequency; }
  if (input.type === "random") { out.min = number(input.min, `${name}: min`); out.max = number(input.max, `${name}: max`); }
  if (input.type === "sine") { out.amplitude = number(input.amplitude, `${name}: amplitude`); out.periodDays = number(input.periodDays, `${name}: periodDays`, 365); out.phase = number(input.phase, `${name}: phase`, 0); out.offset = number(input.offset, `${name}: offset`, 0); if (out.periodDays <= 0) throw new HttpError(400, "ERR-GENERATOR", `${name}: periodDays must be above 0`); }
  if (input.type === "linear") { out.from = number(input.from, `${name}: from`); if (input.to !== undefined && input.to !== "" && input.to !== null) out.to = number(input.to, `${name}: to`); else out.slopePerYear = number(input.slopePerYear, `${name}: slopePerYear`, 0); }
  if (input.type === "minimum" || input.type === "maximum") out.value = number(input.value, `${name}: value`);
  return out;
}

// The additive generator's transactions in [start, end).
export function generatorTransactions(generator, { start, end, birthDate, frequency, random }) {
  if (!generator.enabled || generator.type === "minimum" || generator.type === "maximum") return [];
  const from = resolveWhen(generator.start, birthDate) || start;
  const until = resolveWhen(generator.end, birthDate) || end;
  const first = from > start ? from : start;
  const last = until < end ? until : end;
  if (first >= last) return [];
  const dates = schedule(first, last, generator.frequency ? parseFrequency(generator.frequency) : frequency, 2000000);
  const span = Math.max(1, daysBetween(first, last));
  return dates.map((date) => {
    let amount;
    if (generator.type === "random") amount = generator.min + (generator.max - generator.min) * random();
    else if (generator.type === "sine") amount = generator.amplitude * Math.sin((2 * Math.PI * daysBetween(from, date)) / generator.periodDays + generator.phase) + generator.offset;
    else amount = generator.to !== undefined ? generator.from + (generator.to - generator.from) * (daysBetween(first, date) / span) : generator.from + generator.slopePerYear * yearsBetween(from, date);
    return { date, description: `Generator: ${generator.name}`, amount: Math.round(amount * 100) / 100, source: "generator", generator: generator.name };
  });
}

export function limitsFor(generators, period, birthDate) {
  let floor = null;
  let cap = null;
  for (const generator of generators) {
    if (!generator.enabled || (generator.type !== "minimum" && generator.type !== "maximum")) continue;
    const from = resolveWhen(generator.start, birthDate);
    const until = resolveWhen(generator.end, birthDate);
    if ((from && period < from) || (until && period >= until)) continue;
    if (generator.type === "minimum") floor = floor === null ? generator.value : Math.max(floor, generator.value);
    else cap = cap === null ? generator.value : Math.min(cap, generator.value);
  }
  return { floor, cap };
}
