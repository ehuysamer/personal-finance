import HttpError from "../models/httpError.model.js";
import { EXPRESSION_HELP } from "../lib/chartExpression.js";
import { DATE_FORMATS, TARGET_FIELDS } from "../lib/translate.js";
import { TEXT_OPERATORS } from "../lib/match.js";
import { RULE_FIELDS, UNCATEGORISED, suggestRule } from "../lib/rules.js";
import { METHODS } from "../lib/forecastModel.js";
import { GENERATOR_TYPES } from "../lib/generators.js";
import { withCurrency } from "../lib/currency.js";

// Every operation is defined once: its REST route and its MCP tool come from this table, so MCP covers
// everything REST does. scope: "user" (no tenant), "tenant" (path /v1/tenants/:tenant), "project"
// (/v1/tenants/:tenant/projects/:project; MCP may leave project out to use the active one).
// Inputs: path parameters, then the query (GET/DELETE) or the JSON body; MCP passes them all as arguments.
const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };
const O = { type: "object" };
const A = { type: "array" };
const TP = "/v1/tenants/:tenant";
const PP = `${TP}/projects/:project`;

const IMPORTSOURCE = `{ name, format: csv|json|xlsx, options?: { delimiter?, encoding?, skipRows?, hasHeader? (default true), sheet? (xlsx), rowsPath? (json) }, filenameFilter?: { type: wildcard|regex, pattern } (picks this importsource for uploads), translators: { ${TARGET_FIELDS.join(", ")}: { parts: [{ type: column, column, negate? } | { type: fixed, value }] (in order), separator? (text fields, default space), format? (date: ${DATE_FORMATS.join(", ")} or a pattern of yyyy MM dd MMM) } } }. Several parts of a text field are joined; amount parts are added (debit + credit columns, negate flips the sign)`;
const RULE = `{ name, account (account id), enabled?, order?, conditions: [{ field: ${RULE_FIELDS.join("|")}, op: ${TEXT_OPERATORS.join("|")}, value (or values: [] for containsall/containsany), not?, caseSensitive? }] (all must match), date?: { start?, end? }, amount?: { min?, max? } }. First matching rule in order wins; no match goes to the uncategorised account`;
const CHART = "{ name, bucket: daily|weekly|monthly|quarterly|yearly, start?, end?, leftLabel?, rightLabel? (axis titles), forecast? (forecast id), includeActuals? (default true), series: [{ name (letters, digits, _), label?, type: account|accounts|category|tag|calculate, ref (account short code or id, category id, or tag), refs? (accounts: several accounts added up), measure?: running|sum|count|avg|min|max (default running), expression? (calculate: e.g. INC + EXP, other series' names), color?, axis?: left|right|virtual (virtual: its own scale over the chart's height, no axis), hidden? }] }";
const FORECAST = `{ name, frequency: {n}{d|w|m|q|y} (1d, 1w, 6m), horizon: { type: duration, value: 10y|90d } | { type: date, value } | { type: age, value: 65 }, lookbackYears? (3), settings?: { replay?, seasonality?, noise?, maxGrowth? }, seed?: { mode: time|number|codeword, value }, inflation?: { categoryId: 0.03 }, accounts?: { accountIdOrShortCode: { method?: ${METHODS.join("|")}, inflation?, growth?, value? (fixed), formula? (period total, names: value, replay, base, g, s, i, t, age and other accounts' short codes), start?, end? (date or { age }) } }, generators?: [{ name, type: ${GENERATOR_TYPES.join("|")}, account, frequency?, start?, end?, min/max (random), amplitude/periodDays/phase/offset (sine), from/to or slopePerYear (linear), value (minimum/maximum) }] }`;

export const operations = [
  { name: "me", method: "get", path: "/v1/me", scope: "user", description: "The signed-in user and the tenants they can open", run: async ({ user, deps }) => ({ email: user.email, tenants: await deps.tenantDirectory.ensureTenants(user) }) },
  { name: "expression_help", method: "get", path: "/v1/expression-help", scope: "user", description: "The formula language of chart calculations and forecast formulas", run: async () => EXPRESSION_HELP },
  { name: "tenant_get", method: "get", path: TP, scope: "tenant", description: "A tenant and its members", run: async ({ tenant, deps, user }) => (await deps.tenantDirectory.membership(user, tenant)).tenant },
  { name: "tenant_update", method: "put", path: TP, scope: "tenant", description: "Rename a tenant or set its members ([{ email, role: owner|member }]; owners only)", input: { name: S, members: A }, run: ({ tenant, deps, user, args }) => deps.tenantDirectory.update(user, tenant, args) },
  { name: "indexes_rebuild", method: "post", path: `${TP}/indexes/rebuild`, scope: "tenant", description: "Rebuild a tenant's $index.json lists from its folders (repair)", run: async ({ tenant, deps }) => {
    const items = await deps.workspaceService.rebuild(tenant);
    const result = { workspace: items.length, documents: await deps.documentsService.rebuild(tenant), datasources: {}, projects: {} };
    for (const item of items) {
      if (item.kind === "datasource") result.datasources[item.id] = await deps.importService.importsources.rebuild(tenant, item.id);
      else result.projects[item.id] = await deps.projectService.rebuild(tenant, item.id);
    }
    return result;
  } },
  { name: "workspace_list", method: "get", path: `${TP}/workspace`, scope: "tenant", description: "The tenant's projects and datasources, and the user's active project", run: async ({ tenant, deps, user }) => ({ items: await deps.workspaceService.list(tenant), activeProject: await deps.workspaceService.activeProject(tenant, user.email) }) },
  { name: "active_project_set", method: "put", path: `${TP}/active-project`, scope: "tenant", description: "Choose the active project", input: { project: S }, required: ["project"], run: ({ tenant, deps, user, args }) => deps.workspaceService.setActiveProject(tenant, user.email, args.project) },

  // Datasources and import
  { name: "datasource_list", method: "get", path: `${TP}/datasources`, scope: "tenant", description: "List datasources", run: async ({ tenant, deps }) => ({ items: await deps.workspaceService.list(tenant, "datasource") }) },
  { name: "datasource_get", method: "get", path: `${TP}/datasources/:datasource`, scope: "tenant", description: "Get a datasource", run: ({ tenant, deps, args }) => deps.workspaceService.get(tenant, "datasource", args.datasource) },
  { name: "datasource_create", method: "post", path: `${TP}/datasources`, scope: "tenant", status: 201, description: "Create a datasource: a normalised place where data to import lives ({ name, description?, currency? })", input: { id: S, name: S, description: S, currency: S }, required: ["name"], run: ({ tenant, deps, args }) => deps.workspaceService.create(tenant, "datasource", args) },
  { name: "datasource_update", method: "put", path: `${TP}/datasources/:datasource`, scope: "tenant", description: "Update a datasource", input: { name: S, description: S, currency: S }, run: ({ tenant, deps, args }) => { const { datasource, ...rest } = args; return deps.workspaceService.update(tenant, "datasource", datasource, rest); } },
  { name: "datasource_delete", method: "delete", path: `${TP}/datasources/:datasource`, scope: "tenant", description: "Delete a datasource (refused while a project uses it)", run: ({ tenant, deps, args }) => deps.workspaceService.remove(tenant, "datasource", args.datasource) },
  { name: "importsource_list", method: "get", path: `${TP}/datasources/:datasource/importsources`, scope: "tenant", description: "List a datasource's importsources", run: async ({ tenant, deps, args }) => ({ items: await deps.importService.importsources.list(tenant, args.datasource) }) },
  { name: "importsource_get", method: "get", path: `${TP}/datasources/:datasource/importsources/:importsource`, scope: "tenant", description: "Get an importsource", run: ({ tenant, deps, args }) => deps.importService.importsources.get(tenant, args.datasource, args.importsource) },
  { name: "importsource_create", method: "post", path: `${TP}/datasources/:datasource/importsources`, scope: "tenant", status: 201, description: `Create an importsource: ${IMPORTSOURCE}`, input: { id: S, name: S, format: S, options: O, filenameFilter: O, translators: O }, required: ["name", "format", "translators"], run: ({ tenant, deps, args }) => { const { datasource, ...rest } = args; return deps.importService.importsources.create(tenant, datasource, rest); } },
  { name: "importsource_update", method: "put", path: `${TP}/datasources/:datasource/importsources/:importsource`, scope: "tenant", description: `Update an importsource: ${IMPORTSOURCE}`, input: { name: S, format: S, options: O, filenameFilter: O, translators: O }, run: ({ tenant, deps, args }) => { const { datasource, importsource, ...rest } = args; return deps.importService.importsources.update(tenant, datasource, importsource, rest); } },
  { name: "importsource_delete", method: "delete", path: `${TP}/datasources/:datasource/importsources/:importsource`, scope: "tenant", description: "Delete an importsource", run: ({ tenant, deps, args }) => deps.importService.importsources.remove(tenant, args.datasource, args.importsource) },
  { name: "importsource_clone", method: "post", path: `${TP}/datasources/:datasource/importsources/:importsource/clone`, scope: "tenant", status: 201, description: "Clone an importsource, into this datasource or targetDatasource; move: true also deletes the original", input: { name: S, targetDatasource: S, move: B }, run: ({ tenant, deps, args }) => deps.importService.importsources.clone(tenant, args.datasource, args.importsource, args) },
  { name: "import_sample", method: "post", path: `${TP}/datasources/:datasource/sample`, scope: "tenant", description: "Import sample: a file's columns and first rows, and the normalised rows from an importsource or unsaved translators, without saving anything. The file is contentBase64 (with filename) or documentPath, a document in Documents", input: { filename: S, contentBase64: S, documentPath: S, format: S, options: O, translators: O, importsource: S, limit: N }, run: async ({ tenant, deps, args }) => {
    if (!args.documentPath) return deps.importService.sample(tenant, args.datasource, args);
    const document = await deps.documentsService.read(tenant, { path: args.documentPath });
    return { filename: document.name, ...(await deps.importService.sample(tenant, args.datasource, { ...args, filename: document.name, content: document.content })) };
  } },
  { name: "import_folder_list", method: "get", path: `${TP}/import-folder`, scope: "tenant", description: "Files waiting in the tenant's import folder ({tenant}/import/ in the bucket), each with the datasources and importsources whose filename filters match", run: async ({ tenant, deps }) => ({ folder: `${tenant}/import/`, items: await deps.importService.folderFiles(tenant) }) },
  { name: "import_folder_import", method: "post", path: `${TP}/import-folder/import`, scope: "tenant", status: 201, description: "Import a file from the tenant's import folder (path relative to it). datasource and importsource default to the only match; afterwards it moves to import/imported/{date}/ unless keep is true", input: { path: S, datasource: S, importsource: S, keep: B }, required: ["path"], run: ({ tenant, deps, args }) => deps.importService.importFromFolder(tenant, args) },
  // Documents
  { name: "documents_list", method: "get", path: `${TP}/documents`, scope: "tenant", description: "A documents folder's sub-folders and files (folder: e.g. statements/2026; empty for the top); with q, or recursive: true, every document (whose path contains q)", input: { folder: S, q: S, recursive: B }, run: async ({ tenant, deps, args }) => (args.q || args.recursive === true || args.recursive === "true" ? { files: await deps.documentsService.search(tenant, args.q || "") } : deps.documentsService.list(tenant, args.folder || "")) },
  { name: "document_upload_url", method: "post", path: `${TP}/documents/upload-url`, scope: "tenant", description: "For documents too large to send as base64: a presigned URL to PUT the file to at path, then call document_upload with uploaded: true. url is null when running locally", input: { path: S }, required: ["path"], run: ({ tenant, deps, args }) => deps.documentsService.uploadUrl(tenant, args) },
  { name: "document_upload", method: "post", path: `${TP}/documents`, scope: "tenant", status: 201, description: "Store a document at path (folder/name): contentBase64, or uploaded: true after document_upload_url. The same path again replaces it", input: { path: S, contentBase64: S, uploaded: B }, required: ["path"], run: ({ tenant, deps, args }) => deps.documentsService.upload(tenant, args) },
  { name: "document_download", method: "get", path: `${TP}/documents/download`, scope: "tenant", description: "A short-lived download link for a document (locally: its content as base64)", input: { path: S }, required: ["path"], run: ({ tenant, deps, args }) => deps.documentsService.download(tenant, args) },
  { name: "document_move", method: "put", path: `${TP}/documents/move`, scope: "tenant", description: "Move or rename a document", input: { path: S, to: S }, required: ["path", "to"], run: ({ tenant, deps, args }) => deps.documentsService.move(tenant, args) },
  { name: "document_delete", method: "delete", path: `${TP}/documents`, scope: "tenant", description: "Delete a document", input: { path: S }, required: ["path"], run: ({ tenant, deps, args }) => deps.documentsService.remove(tenant, args) },
  { name: "document_import_candidates", method: "get", path: `${TP}/documents/candidates`, scope: "tenant", description: "The datasources and importsources whose filename filters match a document", input: { path: S }, required: ["path"], run: ({ tenant, deps, args }) => deps.documentsService.candidates(tenant, args) },
  { name: "document_import", method: "post", path: `${TP}/documents/import`, scope: "tenant", status: 201, description: "Import a document (a statement) into a datasource; datasource and importsource default to the only match. The document stays in documents", input: { path: S, datasource: S, importsource: S }, required: ["path"], run: ({ tenant, deps, args }) => deps.documentsService.importDocument(tenant, args) },
  { name: "file_list", method: "get", path: `${TP}/datasources/:datasource/files`, scope: "tenant", description: "Files imported into a datasource", run: async ({ tenant, deps, args }) => ({ items: await deps.importService.files(tenant, args.datasource) }) },
  { name: "file_upload_url", method: "post", path: `${TP}/datasources/:datasource/upload-url`, scope: "tenant", description: "For files too large to send as base64 (Lambda takes about 4 MB): a presigned URL to PUT the file to, then call file_upload with uploadId. url is null when running locally", input: { filename: S }, required: ["filename"], run: ({ tenant, deps, args }) => deps.importService.uploadUrl(tenant, args.datasource, args) },
  { name: "file_upload", method: "post", path: `${TP}/datasources/:datasource/files`, scope: "tenant", status: 201, description: "Import a statement file (contentBase64, or uploadId after file_upload_url). The importsource is picked by filename filters unless given; the same filename again replaces its rows; duplicates across statements are not added", input: { filename: S, contentBase64: S, uploadId: S, importsource: S }, required: ["filename"], run: ({ tenant, deps, args }) => deps.importService.upload(tenant, args.datasource, args) },
  { name: "file_delete", method: "delete", path: `${TP}/datasources/:datasource/files/:file`, scope: "tenant", description: "Remove an imported file and its rows", run: ({ tenant, deps, args }) => deps.importService.deleteFile(tenant, args.datasource, args.file) },
  { name: "bank_accounts", method: "get", path: `${TP}/datasources/:datasource/bank-accounts`, scope: "tenant", description: "The bank accounts in a datasource with their sums and latest totals", run: async ({ tenant, deps, args }) => ({ items: await deps.importService.bankAccounts(tenant, args.datasource) }) },
  { name: "datasource_transactions", method: "get", path: `${TP}/datasources/:datasource/transactions`, scope: "tenant", description: "A datasource's transactions (imported, de-duplicated, and manual), newest first, paged", input: { page: N, pageSize: N, q: S }, run: async ({ tenant, deps, args }) => {
    const text = String(args.q || "").toLowerCase();
    const all = (await deps.importService.datasourceTransactions(tenant, args.datasource)).filter((tx) => !text || `${tx.description} ${tx.account}`.toLowerCase().includes(text)).sort((a, b) => b.date.localeCompare(a.date));
    const size = Math.min(500, Number(args.pageSize) || 50); const page = Math.max(1, Number(args.page) || 1);
    const { currency } = await deps.workspaceService.get(tenant, "datasource", args.datasource);
    return { items: withCurrency(all.slice((page - 1) * size, page * size), () => currency), total: all.length, page, pageSize: size, pages: Math.ceil(all.length / size) };
  } },
  ...["transaction", "total"].flatMap((kind) => {
    const list = kind === "total" ? "totals" : "manualTransactions";
    const base = `${TP}/datasources/:datasource/${kind === "total" ? "totals" : "manual-transactions"}`;
    const fields = kind === "total" ? { date: S, account: S, balance: N, note: S } : { date: S, account: S, description: S, amount: N, note: S };
    const what = kind === "total" ? "a total (a bank account's balance on a date; the source of truth: analysis adds a balance adjustment for any difference)" : "a manual transaction";
    return [
      { name: `${kind === "total" ? "total" : "manual_transaction"}_list`, method: "get", path: base, scope: "tenant", description: `List ${kind === "total" ? "totals" : "manual transactions"} (with the datasource's currency)`, run: async ({ tenant, deps, args }) => { const { currency } = await deps.workspaceService.get(tenant, "datasource", args.datasource); return { items: withCurrency(await deps.importService[list].list(tenant, args.datasource), () => currency) }; } },
      { name: `${kind === "total" ? "total" : "manual_transaction"}_create`, method: "post", path: base, scope: "tenant", status: 201, description: `Add ${what}`, input: fields, required: ["date", kind === "total" ? "balance" : "amount"], run: ({ tenant, deps, args }) => deps.importService[list].create(tenant, args.datasource, args) },
      { name: `${kind === "total" ? "total" : "manual_transaction"}_update`, method: "put", path: `${base}/:id`, scope: "tenant", description: `Change ${what}`, input: fields, run: ({ tenant, deps, args }) => deps.importService[list].update(tenant, args.datasource, args.id, args) },
      { name: `${kind === "total" ? "total" : "manual_transaction"}_delete`, method: "delete", path: `${base}/:id`, scope: "tenant", description: `Delete ${what}`, run: ({ tenant, deps, args }) => deps.importService[list].remove(tenant, args.datasource, args.id) }
    ];
  }),

  // Projects and accounts
  { name: "project_list", method: "get", path: `${TP}/projects`, scope: "tenant", description: "List projects", run: async ({ tenant, deps }) => ({ items: await deps.workspaceService.list(tenant, "project") }) },
  { name: "project_get", method: "get", path: PP, scope: "project", description: "Get a project (datasources, birth date, categories)", run: ({ tenant, project, deps }) => deps.workspaceService.get(tenant, "project", project) },
  { name: "project_create", method: "post", path: `${TP}/projects`, scope: "tenant", status: 201, description: "Create a project: { name, description?, datasources: [ids], birthDate? (yyyy-mm-dd, a person's or company's), currency? (the accounts' default, NZD), categories?: [{ id, name, type: income|expense|asset|liability, inflation (0.03 = 3%) }] }", input: { id: S, name: S, description: S, datasources: A, birthDate: S, currency: S, categories: A }, required: ["name"], run: async ({ tenant, deps, user, args }) => {
    const project = await deps.workspaceService.create(tenant, "project", args);
    if (!(await deps.workspaceService.preferences(tenant, user.email)).activeProject) await deps.workspaceService.setActiveProject(tenant, user.email, project.id);
    return project;
  } },
  { name: "project_update", method: "put", path: PP, scope: "project", description: "Update a project", input: { name: S, description: S, datasources: A, birthDate: S, currency: S, categories: A }, run: ({ tenant, project, deps, args }) => { const { project: _p, ...rest } = args; return deps.workspaceService.update(tenant, "project", project, rest); } },
  { name: "project_delete", method: "delete", path: PP, scope: "project", description: "Delete a project", run: ({ tenant, project, deps }) => deps.workspaceService.remove(tenant, "project", project) },
  { name: "project_clone", method: "post", path: `${PP}/clone`, scope: "project", status: 201, description: "Clone a project: its settings, categories, accounts, rules, charts and forecast definitions (not analysis or forecast results); the copy becomes the active project. Run analysis_run on it", input: { name: S, id: S }, run: ({ tenant, project, deps, user, args }) => deps.categoryService.cloneProject(tenant, project, args, user) },
  { name: "category_create", method: "post", path: `${PP}/categories`, scope: "project", status: 201, description: "Add a category to the project: { name, type: income|expense|asset|liability, inflation (0.03 = 3% a year) }", input: { id: S, name: S, type: S, inflation: N }, required: ["name"], run: ({ tenant, project, deps, args }) => deps.categoryService.create(tenant, project, args) },
  { name: "category_update", method: "put", path: `${PP}/categories/:category`, scope: "project", description: "Rename a category or change its type or inflation; accounts, charts and forecasts refer to it by id, so the change applies everywhere", input: { name: S, type: S, inflation: N }, run: ({ tenant, project, deps, args }) => deps.categoryService.update(tenant, project, args.category, args) },
  { name: "category_delete", method: "delete", path: `${PP}/categories/:category`, scope: "project", description: "Delete a category: its accounts move to moveTo (default: the first other category), chart series that totalled it total moveTo, and forecasts drop its inflation override", input: { moveTo: S }, run: ({ tenant, project, deps, args }) => deps.categoryService.remove(tenant, project, args.category, args) },
  { name: "account_list", method: "get", path: `${PP}/accounts`, scope: "project", description: "List a project's accounts", run: async ({ tenant, project, deps }) => ({ items: await deps.projectService.accounts.list(tenant, project) }) },
  { name: "account_get", method: "get", path: `${PP}/accounts/:account`, scope: "project", description: "Get an account", run: ({ tenant, project, deps, args }) => deps.projectService.accounts.get(tenant, project, args.account) },
  { name: "account_create", method: "post", path: `${PP}/accounts`, scope: "project", status: 201, description: "Create an account: { name, category (category id), currency? (NZD, USD, EUR...; default the project's), shortCode? (for charts and formulas), tags?: [], description? }", input: { id: S, name: S, category: S, currency: S, shortCode: S, tags: A, description: S }, required: ["name", "category"], run: ({ tenant, project, deps, args }) => { const { project: _p, ...rest } = args; return deps.projectService.accounts.create(tenant, project, rest); } },
  { name: "account_update", method: "put", path: `${PP}/accounts/:account`, scope: "project", description: "Update an account", input: { name: S, category: S, currency: S, shortCode: S, tags: A, description: S }, run: ({ tenant, project, deps, args }) => { const { project: _p, account, ...rest } = args; return deps.projectService.accounts.update(tenant, project, account, rest); } },
  { name: "account_delete", method: "delete", path: `${PP}/accounts/:account`, scope: "project", description: "Delete an account; refused while rules or charts use it unless force", input: { force: B }, run: ({ tenant, project, deps, args }) => deps.projectService.accounts.remove(tenant, project, args.account, { force: args.force === true || args.force === "true" }) },

  // Analysis
  { name: "rule_list", method: "get", path: `${PP}/rules`, scope: "project", description: "List rules in order", run: async ({ tenant, project, deps }) => ({ items: await deps.projectService.rules.list(tenant, project) }) },
  { name: "rule_get", method: "get", path: `${PP}/rules/:rule`, scope: "project", description: "Get a rule", run: ({ tenant, project, deps, args }) => deps.projectService.rules.get(tenant, project, args.rule) },
  { name: "rule_create", method: "post", path: `${PP}/rules`, scope: "project", status: 201, description: `Create a rule: ${RULE}`, input: { id: S, name: S, account: S, enabled: B, order: N, conditions: A, date: O, amount: O }, required: ["name", "account"], run: ({ tenant, project, deps, args }) => { const { project: _p, ...rest } = args; return deps.projectService.rules.create(tenant, project, rest); } },
  { name: "rule_update", method: "put", path: `${PP}/rules/:rule`, scope: "project", description: `Update a rule: ${RULE}`, input: { name: S, account: S, enabled: B, order: N, conditions: A, date: O, amount: O }, run: ({ tenant, project, deps, args }) => { const { project: _p, rule, ...rest } = args; return deps.projectService.rules.update(tenant, project, rule, rest); } },
  { name: "rule_delete", method: "delete", path: `${PP}/rules/:rule`, scope: "project", description: "Delete a rule", run: ({ tenant, project, deps, args }) => deps.projectService.rules.remove(tenant, project, args.rule) },
  { name: "rule_clone", method: "post", path: `${PP}/rules/:rule/clone`, scope: "project", status: 201, description: "Clone a rule", input: { name: S }, run: ({ tenant, project, deps, args }) => deps.projectService.rules.clone(tenant, project, args.rule, args) },
  { name: "rules_reorder", method: "put", path: `${PP}/rules-order`, scope: "project", description: "Set the rules' order: ids first to last", input: { ids: A }, required: ["ids"], run: async ({ tenant, project, deps, args }) => ({ items: await deps.projectService.rules.reorder(tenant, project, args.ids) }) },
  { name: "rule_test", method: "post", path: `${PP}/rules-test`, scope: "project", description: `Which transactions a rule (saved or not) matches, and how many an earlier rule takes: ${RULE}`, input: { rule: O, limit: N }, required: ["rule"], run: async ({ tenant, project, deps, args }) => {
    const meta = await deps.workspaceService.get(tenant, "project", project);
    const transactions = [];
    for (const datasource of meta.datasources) transactions.push(...(await deps.importService.datasourceTransactions(tenant, datasource)).map((tx) => ({ ...tx, datasource })));
    const rules = await deps.projectService.rules.all(tenant, project);
    const candidate = { order: Number.MAX_SAFE_INTEGER, ...(args.rule.id ? rules.find((rule) => rule.id === args.rule.id) : {}), ...args.rule };
    const currencies = new Map();
    for (const datasource of meta.datasources) currencies.set(datasource, (await deps.workspaceService.get(tenant, "datasource", datasource)).currency);
    const result = await deps.projectService.rules.test(transactions, rules, candidate, Number(args.limit) || 50);
    return { ...result, transactions: withCurrency(result.transactions, (tx) => currencies.get(tx.datasource)) };
  } },
  { name: "unmatched_transactions", method: "get", path: `${PP}/unmatched`, scope: "project", description: "After analysis: the transactions no rule matched (the uncategorised account), paged, newest first, each with a suggested rule (name and a description condition) to fill in and save with rule_create", input: { page: N, pageSize: N, q: S, sort: S, order: S }, run: async ({ tenant, project, deps, args }) => {
    const page = await deps.resultsService.history(tenant, project, "analysis", UNCATEGORISED, args);
    const currencyOf = await deps.projectService.accounts.currencies(tenant, project);
    return { ...page, items: withCurrency(page.items, () => currencyOf(UNCATEGORISED)).map((tx) => ({ ...tx, suggestedRule: suggestRule(tx) })) };
  } },
  { name: "rule_suggest", method: "post", path: `${PP}/rules-suggest`, scope: "project", description: "A suggested rule for a transaction ({ description, bankAccount?, date?, amount? }): its beneficiary words as a description condition", input: { transaction: O }, required: ["transaction"], run: async ({ args }) => suggestRule(args.transaction || {}) },
  { name: "analysis_run", method: "post", path: `${PP}/analysis`, scope: "project", status: 202, description: "Analyse: put the project's transactions into accounts by the rules and build running totals and aggregates. Runs as a job; follow it with job_get", run: ({ tenant, project, deps, user }) => deps.jobService.start(tenant, project, "analysis", {}, user) },
  { name: "analysis_status", method: "get", path: `${PP}/analysis`, scope: "project", description: "The last analysis: when, counts per account, last date, warnings", run: async ({ tenant, project, deps }) => (await deps.analysisService.meta(tenant, project)) || { status: "none" } },
  { name: "account_aggregates", method: "get", path: `${PP}/accounts/:account/aggregates`, scope: "project", description: "An account's monthly, quarterly and yearly sum, running total, count, average, min and max (analysis, or a forecast)", input: { forecast: S }, run: async ({ tenant, project, deps, args }) => (await deps.resultsService.aggregates(tenant, project, args.forecast ? deps.forecastService.scope(args.forecast) : "analysis", args.account)) || { account: args.account, monthly: [], quarterly: [], yearly: [] } },
  { name: "account_history", method: "get", path: `${PP}/accounts/:account/transactions`, scope: "project", description: "An account's transactions, paged, newest first by default (sort: date|amount, order: desc|asc, from, to, q). With forecast: that forecast's transactions, and with includeActuals also the actual ones (kind: actual|forecast)", input: { page: N, pageSize: N, sort: S, order: S, from: S, to: S, q: S, forecast: S, includeActuals: B }, run: async ({ tenant, project, deps, args }) => {
    const currency = (await deps.projectService.accounts.currencies(tenant, project))(args.account);
    const priced = (page) => ({ ...page, items: withCurrency(page.items, () => currency) });
    if (!args.forecast) return priced(await deps.resultsService.history(tenant, project, "analysis", args.account, args));
    const scope = deps.forecastService.scope(args.forecast);
    if (!(args.includeActuals === true || args.includeActuals === "true")) return priced(await deps.resultsService.history(tenant, project, scope, args.account, args));
    const all = [...await deps.resultsService.all(tenant, project, "analysis", args.account), ...await deps.resultsService.all(tenant, project, scope, args.account)];
    return priced(deps.resultsService.page(all, args));
  } },
  { name: "chart_list", method: "get", path: `${PP}/charts`, scope: "project", description: "List saved charts", run: async ({ tenant, project, deps }) => ({ items: await deps.projectService.charts.list(tenant, project) }) },
  { name: "chart_get", method: "get", path: `${PP}/charts/:chart`, scope: "project", description: "Get a saved chart", run: ({ tenant, project, deps, args }) => deps.projectService.charts.get(tenant, project, args.chart) },
  { name: "chart_create", method: "post", path: `${PP}/charts`, scope: "project", status: 201, description: `Save a chart by name: ${CHART}`, input: { id: S, name: S, bucket: S, start: S, end: S, forecast: S, includeActuals: B, series: A }, required: ["name", "series"], run: ({ tenant, project, deps, args }) => { const { project: _p, ...rest } = args; return deps.projectService.charts.create(tenant, project, rest); } },
  { name: "chart_update", method: "put", path: `${PP}/charts/:chart`, scope: "project", description: `Update a chart: ${CHART}`, input: { name: S, bucket: S, start: S, end: S, forecast: S, includeActuals: B, series: A }, run: ({ tenant, project, deps, args }) => { const { project: _p, chart, ...rest } = args; return deps.projectService.charts.update(tenant, project, chart, rest); } },
  { name: "chart_delete", method: "delete", path: `${PP}/charts/:chart`, scope: "project", description: "Delete a chart", run: ({ tenant, project, deps, args }) => deps.projectService.charts.remove(tenant, project, args.chart) },
  { name: "chart_transactions", method: "post", path: `${PP}/chart-transactions`, scope: "project", description: "The transactions behind a saved chart (id) or an unsaved one (chart): every account of its series, tagged with series and kind; period (a bucket such as 2026-03, 2026-Q1, 2026, a week's Monday or a day) gives the items behind one aggregate, series one series' only. Paged: page, pageSize, sort, order, q", input: { id: S, chart: O, forecast: S, includeActuals: B, bucket: S, period: S, series: S, page: N, pageSize: N, sort: S, order: S, q: S }, run: async ({ tenant, project, deps, args }) => {
    const chart = args.chart || await deps.projectService.charts.get(tenant, project, args.id);
    return deps.chartService.transactions(tenant, project, { ...chart, ...(args.forecast !== undefined ? { forecast: args.forecast || null } : {}), ...(args.includeActuals !== undefined ? { includeActuals: args.includeActuals } : {}), ...(args.bucket ? { bucket: args.bucket } : {}) }, args);
  } },
  { name: "chart_data", method: "post", path: `${PP}/chart-data`, scope: "project", description: `Calculate a saved chart (id) or an unsaved one (chart: ${CHART}); actual and forecast values are separate arrays per series, aligned to buckets`, input: { id: S, chart: O, forecast: S, includeActuals: B, bucket: S, start: S, end: S }, run: async ({ tenant, project, deps, args }) => {
    const chart = args.chart || await deps.projectService.charts.get(tenant, project, args.id);
    return deps.chartService.data(tenant, project, { ...chart, ...(args.forecast !== undefined ? { forecast: args.forecast || null } : {}), ...(args.includeActuals !== undefined ? { includeActuals: args.includeActuals } : {}), ...(args.bucket ? { bucket: args.bucket } : {}), ...(args.start !== undefined ? { start: args.start || null } : {}), ...(args.end !== undefined ? { end: args.end || null } : {}) });
  } },

  // Forecasts
  { name: "forecast_list", method: "get", path: `${PP}/forecasts`, scope: "project", description: "List forecasts", run: async ({ tenant, project, deps }) => ({ items: await deps.forecastService.list(tenant, project) }) },
  { name: "forecast_get", method: "get", path: `${PP}/forecasts/:forecast`, scope: "project", description: "Get a forecast definition", run: ({ tenant, project, deps, args }) => deps.forecastService.get(tenant, project, args.forecast) },
  { name: "forecast_create", method: "post", path: `${PP}/forecasts`, scope: "project", status: 201, description: `Create a forecast: ${FORECAST}`, input: { id: S, name: S, frequency: S, horizon: O, lookbackYears: N, settings: O, seed: O, inflation: O, accounts: O, generators: A }, required: ["name"], run: ({ tenant, project, deps, args }) => { const { project: _p, ...rest } = args; return deps.forecastService.create(tenant, project, rest); } },
  { name: "forecast_update", method: "put", path: `${PP}/forecasts/:forecast`, scope: "project", description: `Update a forecast: ${FORECAST}`, input: { name: S, frequency: S, horizon: O, lookbackYears: N, settings: O, seed: O, inflation: O, accounts: O, generators: A }, run: ({ tenant, project, deps, args }) => { const { project: _p, forecast, ...rest } = args; return deps.forecastService.update(tenant, project, forecast, rest); } },
  { name: "forecast_delete", method: "delete", path: `${PP}/forecasts/:forecast`, scope: "project", description: "Delete a forecast", run: ({ tenant, project, deps, args }) => deps.forecastService.remove(tenant, project, args.forecast) },
  { name: "forecast_clone", method: "post", path: `${PP}/forecasts/:forecast/clone`, scope: "project", status: 201, description: "Clone a forecast", input: { name: S }, run: ({ tenant, project, deps, args }) => deps.forecastService.clone(tenant, project, args.forecast, args) },
  { name: "forecast_run", method: "post", path: `${PP}/forecasts/:forecast/run`, scope: "project", status: 202, description: "Run a forecast (after analysis). Runs as a job; follow it with job_get", run: async ({ tenant, project, deps, user, args }) => { await deps.forecastService.get(tenant, project, args.forecast); return deps.jobService.start(tenant, project, "forecast", { forecast: args.forecast }, user); } },
  { name: "forecast_results", method: "get", path: `${PP}/forecasts/:forecast/results`, scope: "project", description: "A forecast's last run (start, end, periods) and the model terms found per account", run: async ({ tenant, project, deps, args }) => ({ run: (await deps.forecastService.meta(tenant, project, args.forecast)) || { status: "none" }, model: await deps.forecastService.model(tenant, project, args.forecast) }) },

  // Jobs
  { name: "job_list", method: "get", path: `${PP}/jobs`, scope: "project", description: "Recent jobs of a project", run: async ({ tenant, project, deps }) => ({ items: await deps.jobService.list(tenant, project) }) },
  { name: "job_get", method: "get", path: `${PP}/jobs/:job`, scope: "project", description: "A job's status and progress", run: async ({ tenant, project, deps, args }) => { const { state: _s, lease: _l, ...job } = await deps.jobService.get(tenant, project, args.job); return job; } },
  { name: "job_cancel", method: "post", path: `${PP}/jobs/:job/cancel`, scope: "project", description: "Cancel a running job", run: ({ tenant, project, deps, args }) => deps.jobService.cancel(tenant, project, args.job) }
];

export function pathParams(path) { return [...path.matchAll(/:([a-z]+)/g)].map((match) => match[1]); }

// The MCP tool's input schema: path parameters (project optional), then the operation's inputs.
export function toolSchema(operation) {
  const params = pathParams(operation.path);
  const properties = Object.fromEntries(params.map((name) => [name, { type: "string", ...(name === "project" ? { description: "Project id; the active project when left out" } : {}) }]));
  Object.assign(properties, operation.input || {});
  return { type: "object", properties, required: [...params.filter((name) => name !== "project"), ...(operation.required || [])] };
}

// Runs an operation for a user: checks tenant membership and resolves the project.
export async function runOperation(operation, user, args, deps) {
  const context = { user, deps, args: { ...args } };
  if (operation.scope !== "user") {
    if (!args.tenant) throw new HttpError(400, "ERR-TENANT", "tenant is required");
    await deps.tenantDirectory.membership(user, args.tenant);
    context.tenant = args.tenant;
  }
  if (operation.scope === "project") {
    const project = args.project || await deps.workspaceService.activeProject(args.tenant, user.email);
    if (!project) throw new HttpError(409, "ERR-NO-PROJECT", "create a project first");
    await deps.workspaceService.get(args.tenant, "project", project);
    context.project = project;
    context.args.project = project;
  }
  return await operation.run(context);
}
