import { createHash } from "node:crypto";
import HttpError from "../models/httpError.model.js";

// Ids are slugs: lower-case letters, digits and -, so they are safe as S3 key segments and never start with $
// (the $-prefixed names are the system's own files and folders).
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isId(value) { return ID_PATTERN.test(String(value || "")); }
export function assertId(value, what = "id") {
  if (!isId(value)) throw new HttpError(400, "ERR-ID", `${what} must be lower-case letters, digits and - (at most 63), starting with a letter or digit`);
  return value;
}
export function slugify(text, fallback = "item") {
  const slug = String(text || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
  return slug || fallback;
}
// A free id from a name: "groceries", then "groceries-2", ... (taken is a Set of ids in use).
export function uniqueId(name, taken, fallback) {
  const base = slugify(name, fallback).slice(0, 58);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
export function userKey(email) { return createHash("sha256").update(String(email).toLowerCase()).digest("hex").slice(0, 24); }

export const keys = {
  tenantsIndex: () => "$tenants/$index.json",
  tenant: (tenant) => `$tenants/${tenant}.json`,
  tenantIndex: (tenant) => `${tenant}/$index.json`,
  userPrefs: (tenant, email) => `${tenant}/$users/${userKey(email)}.json`,
  meta: (tenant, id) => `${tenant}/${id}/$meta.json`,
  folder: (tenant, id) => `${tenant}/${id}/`,
  // Datasources
  importsources: (tenant, ds) => `${tenant}/${ds}/importsources/`,
  filesIndex: (tenant, ds) => `${tenant}/${ds}/files/$index.json`,
  fileOriginal: (tenant, ds, fileId, filename) => `${tenant}/${ds}/files/${fileId}/${filename}`,
  fileRows: (tenant, ds, fileId) => `${tenant}/${ds}/files/${fileId}/rows.json`,
  manualTransactions: (tenant, ds) => `${tenant}/${ds}/manual/transactions.json`,
  manualTotals: (tenant, ds) => `${tenant}/${ds}/manual/totals.json`,
  // Projects
  accounts: (tenant, project) => `${tenant}/${project}/accounts/`,
  rules: (tenant, project) => `${tenant}/${project}/rules/`,
  charts: (tenant, project) => `${tenant}/${project}/charts/`,
  forecasts: (tenant, project) => `${tenant}/${project}/forecasts/`,
  forecastFolder: (tenant, project, forecast) => `${tenant}/${project}/forecasts/${forecast}/`,
  // Results of analysis (scope "analysis") or of a forecast (scope "forecasts/{name}") share one layout.
  resultsFolder: (tenant, project, scope) => `${tenant}/${project}/${scope}/`,
  // $results.json: a forecast's own $meta.json is its definition.
  resultsMeta: (tenant, project, scope) => `${tenant}/${project}/${scope}/$results.json`,
  accountYear: (tenant, project, scope, account, year) => `${tenant}/${project}/${scope}/accounts/${account}/transactions/${year}.json`,
  accountAggregates: (tenant, project, scope, account) => `${tenant}/${project}/${scope}/accounts/${account}/aggregates.json`,
  job: (tenant, project, jobId) => `${tenant}/${project}/jobs/${jobId}.json`,
  jobWork: (tenant, project, jobId, name) => `${tenant}/${project}/jobs/${jobId}/${name}.json`
};

export function timestamp(date = new Date()) { return date.toISOString().replace(/[-:T]/g, "").slice(0, 14); }
