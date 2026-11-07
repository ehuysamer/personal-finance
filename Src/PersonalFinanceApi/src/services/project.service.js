import HttpError from "../models/httpError.model.js";
import { keys } from "../lib/keys.js";
import { UNCATEGORISED, compileRule, createCategoriser, validateRule } from "../lib/rules.js";
import createCollection from "./collection.service.js";
import { validateChart } from "./chart.service.js";

const SHORT_CODE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const RESERVED = new Set(["sum", "avg", "median", "min", "max", "first", "last", "middle", "base", "g", "s", "i", "t", "age", "value", "replay"]);

// Accounts (income/expense categories of a project), rules (which transactions go into them) and saved charts.
export default function createProjectService({ store, indexService, workspaceService, clock = () => new Date() }) {
  const project = (tenant, id) => workspaceService.get(tenant, "project", id);

  async function validateAccount(doc, { tenant, projectId }) {
    doc.name = String(doc.name || "").trim();
    if (!doc.name) throw new HttpError(400, "ERR-NAME", "name is required");
    const meta = await project(tenant, projectId);
    if (!meta.categories.some((category) => category.id === doc.category)) throw new HttpError(400, "ERR-CATEGORY", `category must be one of ${meta.categories.map((category) => category.id).join(", ")}`);
    doc.shortCode = doc.shortCode ? String(doc.shortCode).trim() : null;
    if (doc.shortCode) {
      if (!SHORT_CODE.test(doc.shortCode) || RESERVED.has(doc.shortCode)) throw new HttpError(400, "ERR-SHORT-CODE", "short code is letters, digits and _ (starting with a letter or _), and not a formula word");
      const clash = (await accounts.list(keys.accounts(tenant, projectId))).find((item) => item.shortCode === doc.shortCode && item.id !== doc.id);
      if (clash) throw new HttpError(409, "ERR-SHORT-CODE", `short code ${doc.shortCode} is used by ${clash.name}`);
    }
    doc.tags = [...new Set((Array.isArray(doc.tags) ? doc.tags : String(doc.tags || "").split(",")).map((tag) => String(tag).trim()).filter(Boolean))];
    doc.description = doc.description ? String(doc.description) : "";
    return doc;
  }
  const accounts = createCollection({ store, indexService, clock, what: "account", summary: (doc) => ({ name: doc.name, shortCode: doc.shortCode, category: doc.category, tags: doc.tags, builtIn: doc.builtIn || undefined }), validate: validateAccount });

  async function validateRuleDoc(doc, { tenant, projectId }) {
    const rule = validateRule(doc);
    await accounts.get(keys.accounts(tenant, projectId), rule.account).catch(() => { throw new HttpError(400, "ERR-RULE", `account ${rule.account} was not found`); });
    return rule;
  }
  const rules = createCollection({ store, indexService, clock, what: "rule", summary: (doc) => ({ name: doc.name, account: doc.account, order: doc.order, enabled: doc.enabled }), validate: validateRuleDoc });

  // Every project has the Uncategorised account for transactions no rule matches.
  async function ensureBuiltIns(tenant, projectId) {
    const folder = keys.accounts(tenant, projectId);
    if ((await accounts.list(folder)).some((item) => item.id === UNCATEGORISED)) return;
    const meta = await project(tenant, projectId);
    const category = meta.categories.find((item) => item.type === "expense")?.id || meta.categories[0]?.id;
    if (!category) return;
    const now = clock().toISOString();
    await accounts.write(folder, { id: UNCATEGORISED, name: "Uncategorised", shortCode: "UNCAT", category, tags: [], description: "Transactions no rule matches", builtIn: true, createdAt: now, updatedAt: now });
  }

  async function usage(tenant, projectId, accountId) {
    const usedBy = { rules: [], charts: [] };
    for (const rule of await rules.list(keys.rules(tenant, projectId))) if (rule.account === accountId) usedBy.rules.push(rule.id);
    const account = await accounts.get(keys.accounts(tenant, projectId), accountId);
    for (const chart of await charts.all(keys.charts(tenant, projectId))) if ((chart.series || []).some((series) => series.type === "account" && (series.ref === accountId || series.ref === account.shortCode))) usedBy.charts.push(chart.id);
    return usedBy;
  }

  const charts = createCollection({ store, indexService, clock, what: "chart", summary: (doc) => ({ name: doc.name }), validate: (doc) => validateChart(doc) });

  return {
    accounts: {
      async list(tenant, projectId) { await ensureBuiltIns(tenant, projectId); return await accounts.list(keys.accounts(tenant, projectId)); },
      async all(tenant, projectId) { await ensureBuiltIns(tenant, projectId); return await accounts.all(keys.accounts(tenant, projectId)); },
      get: (tenant, projectId, id) => accounts.get(keys.accounts(tenant, projectId), id),
      // A write without validation (a category's accounts moving to another category).
      write: (tenant, projectId, doc) => accounts.write(keys.accounts(tenant, projectId), doc),
      async create(tenant, projectId, input) { await project(tenant, projectId); return await accounts.create(keys.accounts(tenant, projectId), input, { tenant, projectId }); },
      update: (tenant, projectId, id, input) => accounts.update(keys.accounts(tenant, projectId), id, input, { tenant, projectId }),
      // Deleting an account that rules or charts use is refused unless force; the answer lists them.
      async remove(tenant, projectId, id, { force } = {}) {
        if (id === UNCATEGORISED) throw new HttpError(400, "ERR-BUILT-IN", "Uncategorised cannot be deleted");
        const usedBy = await usage(tenant, projectId, id);
        if (!force && (usedBy.rules.length || usedBy.charts.length)) throw new HttpError(409, "ERR-IN-USE", "the account is used by rules or charts; pass force to delete it anyway", usedBy);
        return { ...(await accounts.remove(keys.accounts(tenant, projectId), id)), usedBy };
      },
      usage
    },
    rules: {
      list: (tenant, projectId) => rules.list(keys.rules(tenant, projectId)),
      all: (tenant, projectId) => rules.all(keys.rules(tenant, projectId)),
      get: (tenant, projectId, id) => rules.get(keys.rules(tenant, projectId), id),
      async create(tenant, projectId, input) {
        await project(tenant, projectId);
        const existing = await rules.list(keys.rules(tenant, projectId));
        const order = input.order ?? (existing.length ? Math.max(...existing.map((item) => item.order ?? 0)) + 1 : 0);
        return await rules.create(keys.rules(tenant, projectId), { ...input, order }, { tenant, projectId });
      },
      update: (tenant, projectId, id, input) => rules.update(keys.rules(tenant, projectId), id, input, { tenant, projectId }),
      remove: (tenant, projectId, id) => rules.remove(keys.rules(tenant, projectId), id),
      clone: (tenant, projectId, id, input = {}) => rules.clone(keys.rules(tenant, projectId), id, { name: input.name, context: { tenant, projectId } }),
      // The new order: ids first to last.
      async reorder(tenant, projectId, ids) {
        const folder = keys.rules(tenant, projectId);
        const all = await rules.all(folder);
        const position = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [id, i]));
        const sorted = [...all].sort((a, b) => (position.get(a.id) ?? 1e6 + a.order) - (position.get(b.id) ?? 1e6 + b.order));
        for (const [i, rule] of sorted.entries()) if (rule.order !== i) await rules.write(folder, { ...rule, order: i, updatedAt: clock().toISOString() });
        return await rules.list(folder);
      },
      // Test a rule (saved or not) against transactions: which it matches, and which an earlier rule takes.
      async test(transactions, allRules, candidate, limit = 50) {
        const rule = validateRule(candidate);
        const matches = compileRule(rule);
        const earlier = createCategoriser(allRules.filter((item) => item.id !== rule.id && item.order < rule.order));
        const matched = [];
        let takenEarlier = 0;
        for (const tx of transactions) {
          if (!matches(tx)) continue;
          const first = earlier(tx);
          if (first.rule) takenEarlier += 1;
          matched.push({ date: tx.date, account: tx.account, description: tx.description, amount: tx.amount, datasource: tx.datasource, takenBy: first.rule });
        }
        matched.sort((a, b) => b.date.localeCompare(a.date));
        return { count: matched.length, takenEarlier, transactions: matched.slice(0, limit) };
      }
    },
    charts: {
      list: (tenant, projectId) => charts.list(keys.charts(tenant, projectId)),
      get: (tenant, projectId, id) => charts.get(keys.charts(tenant, projectId), id),
      async create(tenant, projectId, input) { await project(tenant, projectId); return await charts.create(keys.charts(tenant, projectId), input); },
      update: (tenant, projectId, id, input) => charts.update(keys.charts(tenant, projectId), id, input),
      remove: (tenant, projectId, id) => charts.remove(keys.charts(tenant, projectId), id)
    },
    rebuild: async (tenant, projectId) => ({ accounts: await accounts.rebuild(keys.accounts(tenant, projectId)), rules: await rules.rebuild(keys.rules(tenant, projectId)), charts: await charts.rebuild(keys.charts(tenant, projectId)) })
  };
}
