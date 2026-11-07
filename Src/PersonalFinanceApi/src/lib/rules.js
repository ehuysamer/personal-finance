import HttpError from "../models/httpError.model.js";
import { compileTextCondition } from "./match.js";

export const RULE_FIELDS = ["description", "account", "filename", "datasource"];
export const UNCATEGORISED = "uncategorised";

function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }
function optionalNumber(value, what) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new HttpError(400, "ERR-RULE", `${what} must be a number`);
  return number;
}

export function validateRule(rule) {
  const name = String(rule.name || "").trim();
  if (!name) throw new HttpError(400, "ERR-NAME", "name is required");
  if (!rule.account) throw new HttpError(400, "ERR-RULE", "account is required");
  const conditions = (Array.isArray(rule.conditions) ? rule.conditions : []).map((condition, i) => {
    if (!RULE_FIELDS.includes(condition.field)) throw new HttpError(400, "ERR-RULE", `condition ${i + 1}: field must be one of ${RULE_FIELDS.join(", ")}`);
    const clean = { field: condition.field, op: condition.op };
    if (["containsall", "containsany"].includes(condition.op)) clean.values = (Array.isArray(condition.values) ? condition.values : String(condition.value || "").split(",")).map((value) => String(value).trim()).filter(Boolean);
    else clean.value = String(condition.value ?? "");
    if (condition.not) clean.not = true;
    if (condition.caseSensitive) clean.caseSensitive = true;
    compileTextCondition(clean);
    return clean;
  });
  const date = { start: rule.date?.start || null, end: rule.date?.end || null };
  if ((date.start && !isDate(date.start)) || (date.end && !isDate(date.end))) throw new HttpError(400, "ERR-RULE", "date range dates are yyyy-mm-dd");
  const amount = { min: optionalNumber(rule.amount?.min, "amount.min"), max: optionalNumber(rule.amount?.max, "amount.max") };
  if (!conditions.length && !date.start && !date.end && amount.min === null && amount.max === null) throw new HttpError(400, "ERR-RULE", "a rule needs at least one condition, date or amount limit");
  return { ...rule, name, conditions, date, amount, enabled: rule.enabled !== false, order: Number.isFinite(Number(rule.order)) ? Number(rule.order) : 0 };
}

export function compileRule(rule) {
  const tests = rule.conditions.map((condition) => ({ field: condition.field, test: compileTextCondition(condition) }));
  return (tx) => {
    if (rule.date.start && tx.date < rule.date.start) return false;
    if (rule.date.end && tx.date > rule.date.end) return false;
    if (rule.amount.min !== null && tx.amount < rule.amount.min) return false;
    if (rule.amount.max !== null && tx.amount > rule.amount.max) return false;
    return tests.every(({ field, test }) => test(tx[field]));
  };
}

// First enabled rule in order wins; nothing matching goes to Uncategorised.
export function createCategoriser(rules) {
  const compiled = rules.filter((rule) => rule.enabled !== false).sort((a, b) => a.order - b.order).map((rule) => ({ rule, matches: compileRule(rule) }));
  return (tx) => {
    for (const { rule, matches } of compiled) if (matches(tx)) return { account: rule.account, rule: rule.id };
    return { account: UNCATEGORISED, rule: null };
  };
}
