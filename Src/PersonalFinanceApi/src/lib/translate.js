import HttpError from "../models/httpError.model.js";

export const TARGET_FIELDS = ["date", "account", "description", "amount"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const DATE_FORMATS = ["auto", "yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy", "d/M/yyyy", "M/d/yyyy", "dd-MM-yyyy", "dd.MM.yyyy", "yyyyMMdd", "yyyy/MM/dd", "dd MMM yyyy", "d MMM yyyy", "MMM d, yyyy", "dd/MM/yy", "excel"];

function pad(n) { return String(n).padStart(2, "0"); }
function iso(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

// A date as yyyy-mm-dd from text in a format: tokens yyyy, yy, MM, M, dd, d, MMM (Jan); "excel" is a serial day
// number; "auto" takes ISO dates, then day-first (NZ) d/m/y.
export function parseDate(value, format = "auto") {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && (format === "excel" || format === "auto")) return excelDate(value);
  const text = String(value).trim();
  if (!text) return null;
  if (format === "excel") return /^\d+(\.\d+)?$/.test(text) ? excelDate(Number(text)) : null;
  if (format === "auto") {
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) return iso(Number(match[1]), Number(match[2]), Number(match[3]));
    match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (match) return iso(fullYear(match[3]), Number(match[2]), Number(match[1]));
    return parseDate(text, "dd MMM yyyy") || parseDate(text, "MMM d, yyyy");
  }
  const tokens = format.match(/yyyy|yy|MMM|MM|M|dd|d|[^yMd]+/g) || [];
  let pattern = "^";
  const order = [];
  for (const token of tokens) {
    if (token === "yyyy") { pattern += "(\\d{4})"; order.push("y"); }
    else if (token === "yy") { pattern += "(\\d{2})"; order.push("y"); }
    else if (token === "MMM") { pattern += "([A-Za-z]{3})[A-Za-z]*"; order.push("mon"); }
    else if (token === "MM" || token === "M") { pattern += token === "MM" ? "(\\d{2})" : "(\\d{1,2})"; order.push("m"); }
    else if (token === "dd" || token === "d") { pattern += token === "dd" ? "(\\d{2})" : "(\\d{1,2})"; order.push("d"); }
    else pattern += token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  }
  const match = text.match(new RegExp(`${pattern}`, "i"));
  if (!match) return null;
  const parts = {};
  order.forEach((part, i) => { parts[part] = match[i + 1]; });
  const month = parts.mon ? MONTHS.indexOf(parts.mon.toLowerCase()) + 1 : Number(parts.m);
  return month ? iso(fullYear(parts.y), month, Number(parts.d)) : null;
}
function fullYear(text) { const year = Number(text); return String(text).length <= 2 ? (year < 70 ? 2000 + year : 1900 + year) : year; }
function excelDate(serial) {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return date.toISOString().slice(0, 10);
}

// An amount from text: currency symbols, spaces and thousands commas are dropped; (12.50), a trailing -, and
// "DR" mean negative, "CR" positive.
export function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let text = String(value ?? "").trim();
  if (!text) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) { sign = -1; text = text.slice(1, -1); }
  if (/\s*DR$/i.test(text)) { sign = -sign; text = text.replace(/\s*DR$/i, ""); }
  text = text.replace(/\s*CR$/i, "");
  if (/-$/.test(text)) { sign = -sign; text = text.slice(0, -1); }
  text = text.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!/^-?\d*\.?\d+$/.test(text)) return null;
  return Math.round(sign * Number(text) * 100) / 100;
}

// An importsource's translators: per target field an ordered list of parts ({ type: column, column, negate? } or
// { type: fixed, value }). Text fields join their non-empty parts with the separator (default a space), dates
// join them, then read the result in the field's format, amounts add up their parts (debit and credit columns
// become one amount; negate flips a part's sign).
export function validateTranslators(translators) {
  const result = {};
  for (const field of TARGET_FIELDS) {
    const definition = translators?.[field] || { parts: [] };
    const parts = (Array.isArray(definition.parts) ? definition.parts : []).map((part, i) => {
      if (part.type === "fixed") return { type: "fixed", value: String(part.value ?? ""), ...(part.negate ? { negate: true } : {}) };
      if (part.type === "column" && String(part.column || "")) return { type: "column", column: String(part.column), ...(part.negate ? { negate: true } : {}) };
      throw new HttpError(400, "ERR-TRANSLATOR", `${field} part ${i + 1}: type is column (with a column) or fixed (with a value)`);
    });
    if (field !== "account" && !parts.length) throw new HttpError(400, "ERR-TRANSLATOR", `${field} needs at least one part`);
    const entry = { parts };
    if (definition.separator !== undefined) entry.separator = String(definition.separator);
    if (field === "date") {
      entry.format = definition.format || "auto";
      if (!DATE_FORMATS.includes(entry.format) && !/[yMd]/.test(entry.format)) throw new HttpError(400, "ERR-TRANSLATOR", "date format is not recognised");
    }
    result[field] = entry;
  }
  return result;
}

function partValue(part, row) { return part.type === "fixed" ? part.value : row[part.column]; }

export function translateRow(row, translators) {
  const out = {};
  const errors = [];
  for (const field of ["account", "description"]) {
    const { parts = [], separator = " " } = translators[field] || {};
    out[field] = parts.map((part) => String(partValue(part, row) ?? "").trim()).filter(Boolean).join(separator);
  }
  const date = translators.date;
  const raw = date.parts.length === 1 ? partValue(date.parts[0], row) : date.parts.map((part) => String(partValue(part, row) ?? "").trim()).filter(Boolean).join(date.separator ?? " ");
  out.date = parseDate(raw, date.format);
  if (!out.date) errors.push(`date "${raw ?? ""}" does not read as ${date.format}`);
  let amount = null;
  for (const part of translators.amount.parts) {
    const value = part.type === "fixed" ? parseAmount(part.value) : parseAmount(row[part.column]);
    if (value === null) continue;
    amount = Math.round(((amount ?? 0) + (part.negate ? -value : value)) * 100) / 100;
  }
  out.amount = amount;
  if (amount === null) errors.push("amount is empty or not a number");
  return { row: out, errors };
}

export function translateRows(rows, translators) {
  const valid = [];
  const rejected = [];
  rows.forEach((source, index) => {
    const { row, errors } = translateRow(source, translators);
    if (errors.length) rejected.push({ row: index + 1, errors, source });
    else valid.push({ ...row, row: index + 1 });
  });
  return { rows: valid, rejected };
}
