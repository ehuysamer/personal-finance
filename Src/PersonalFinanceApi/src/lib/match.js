import HttpError from "../models/httpError.model.js";

export const TEXT_OPERATORS = ["wildcard", "regex", "exact", "startswith", "endswith", "contains", "containsall", "containsany"];
const MAX_REGEX_INPUT = 2000;
const MAX_PATTERN = 500;

function escape(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Wildcards: * is any run of characters, ? exactly one ("ASB-*-????.csv").
export function wildcardRegex(pattern, flags = "i") {
  return new RegExp(`^${String(pattern).split("").map((char) => (char === "*" ? ".*" : char === "?" ? "." : escape(char))).join("")}$`, flags);
}

// Regexes from users are bounded: the pattern's length, no nested quantifiers (the usual catastrophic
// backtracking shape such as (a+)+), and the input is cut to MAX_REGEX_INPUT characters.
export function safeRegex(pattern, flags = "i") {
  const text = String(pattern || "");
  if (text.length > MAX_PATTERN) throw new HttpError(400, "ERR-REGEX", `a regex is at most ${MAX_PATTERN} characters`);
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(text)) throw new HttpError(400, "ERR-REGEX", "nested quantifiers such as (a+)+ are not allowed");
  try { return new RegExp(text, flags); } catch (error) { throw new HttpError(400, "ERR-REGEX", `regex is invalid: ${error.message}`); }
}

// A text condition: { op, value } or { op: containsall|containsany, values: [...] }, optional not and caseSensitive.
export function compileTextCondition(condition) {
  const op = condition.op;
  if (!TEXT_OPERATORS.includes(op)) throw new HttpError(400, "ERR-CONDITION", `op must be one of ${TEXT_OPERATORS.join(", ")}`);
  const sensitive = condition.caseSensitive === true;
  const fold = (text) => (sensitive ? String(text ?? "") : String(text ?? "").toLowerCase());
  const values = (Array.isArray(condition.values) ? condition.values : [condition.value]).map((value) => String(value ?? "")).filter((value) => value !== "");
  if (!values.length) throw new HttpError(400, "ERR-CONDITION", `${op} needs a value`);
  let test;
  if (op === "wildcard") { const regex = wildcardRegex(values[0], sensitive ? "" : "i"); test = (text) => regex.test(String(text ?? "")); }
  else if (op === "regex") { const regex = safeRegex(values[0], sensitive ? "" : "i"); test = (text) => regex.test(String(text ?? "").slice(0, MAX_REGEX_INPUT)); }
  else {
    const wanted = values.map(fold);
    if (op === "exact") test = (text) => fold(text) === wanted[0];
    else if (op === "startswith") test = (text) => fold(text).startsWith(wanted[0]);
    else if (op === "endswith") test = (text) => fold(text).endsWith(wanted[0]);
    else if (op === "contains") test = (text) => fold(text).includes(wanted[0]);
    else if (op === "containsall") test = (text) => { const value = fold(text); return wanted.every((part) => value.includes(part)); };
    else test = (text) => { const value = fold(text); return wanted.some((part) => value.includes(part)); };
  }
  return condition.not === true ? (text) => !test(text) : test;
}

// An importsource's filename filter: { type: wildcard|regex, pattern }; a bare string is a wildcard.
export function filenameMatches(filter, filename) {
  if (!filter) return false;
  const { type = "wildcard", pattern } = typeof filter === "string" ? { pattern: filter } : filter;
  if (!pattern) return false;
  return type === "regex" ? safeRegex(pattern).test(String(filename).slice(0, MAX_REGEX_INPUT)) : wildcardRegex(pattern).test(String(filename));
}
