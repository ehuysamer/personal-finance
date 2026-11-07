import HttpError from "../models/httpError.model.js";
import { assertId, keys, timestamp, uniqueId } from "../lib/keys.js";
import { getJson, putJson, softDelete, updateJson } from "../lib/json.js";

export const CATEGORY_TYPES = ["income", "expense", "asset", "liability"];
const DEFAULT_CATEGORIES = [
  { id: "income", name: "Income", type: "income", inflation: 0.03 },
  { id: "housing", name: "Housing", type: "expense", inflation: 0.04 },
  { id: "food", name: "Food", type: "expense", inflation: 0.03 },
  { id: "transport", name: "Transport", type: "expense", inflation: 0.03 },
  { id: "other", name: "Other", type: "expense", inflation: 0.025 }
];

function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(value)); }

function normaliseCategories(input) {
  const categories = (Array.isArray(input) ? input : []).map((category) => {
    const id = assertId(category.id || uniqueId(category.name, new Set(), "category"), "category id");
    if (!CATEGORY_TYPES.includes(category.type)) throw new HttpError(400, "ERR-CATEGORY", `category ${id}: type must be one of ${CATEGORY_TYPES.join(", ")}`);
    const inflation = category.inflation === undefined || category.inflation === null || category.inflation === "" ? 0 : Number(category.inflation);
    if (!Number.isFinite(inflation) || Math.abs(inflation) > 1) throw new HttpError(400, "ERR-CATEGORY", `category ${id}: inflation is a fraction per year (0.03 = 3%)`);
    return { id, name: String(category.name || id), type: category.type, inflation };
  });
  if (new Set(categories.map((category) => category.id)).size !== categories.length) throw new HttpError(400, "ERR-CATEGORY", "category ids must be unique");
  return categories;
}

// Projects and datasources are the folders at a tenant's root ({tenant}/{id}); their ids are unique across both
// and each $meta.json says which kind it is. {tenant}/$index.json lists them.
export default function createWorkspaceService({ store, indexService, clock = () => new Date() }) {
  const summary = (doc) => ({ id: doc.id, kind: doc.kind, name: doc.name, updatedAt: doc.updatedAt });

  async function list(tenant, kind) {
    const items = await indexService.list(keys.tenantIndex(tenant));
    return kind ? items.filter((item) => item.kind === kind) : items;
  }
  async function get(tenant, kind, id) {
    assertId(id, `${kind} id`);
    let doc;
    try { doc = await getJson(store, keys.meta(tenant, id)); }
    catch (error) { if (error.statusCode === 404) throw new HttpError(404, "ERR-NOT-FOUND", `${kind} ${id} was not found`); throw error; }
    if (doc.kind !== kind) throw new HttpError(404, "ERR-NOT-FOUND", `${id} is a ${doc.kind}, not a ${kind}`);
    return doc;
  }
  async function validate(tenant, doc) {
    doc.name = String(doc.name || "").trim();
    if (!doc.name) throw new HttpError(400, "ERR-NAME", "name is required");
    if (doc.kind === "datasource") {
      doc.currency = String(doc.currency || "NZD").toUpperCase();
    } else {
      const datasources = new Set((await list(tenant, "datasource")).map((item) => item.id));
      doc.datasources = [...new Set(Array.isArray(doc.datasources) ? doc.datasources : [])];
      const unknown = doc.datasources.filter((id) => !datasources.has(id));
      if (unknown.length) throw new HttpError(400, "ERR-DATASOURCE", `unknown datasources: ${unknown.join(", ")}`);
      if (doc.birthDate && !isDate(doc.birthDate)) throw new HttpError(400, "ERR-DATE", "birthDate must be yyyy-mm-dd");
      doc.birthDate = doc.birthDate || null;
      doc.categories = normaliseCategories(doc.categories);
    }
    return doc;
  }
  async function write(tenant, doc) {
    await putJson(store, keys.meta(tenant, doc.id), doc);
    await indexService.upsert(keys.tenantIndex(tenant), summary(doc));
    return doc;
  }
  async function create(tenant, kind, input) {
    const taken = new Set((await list(tenant)).map((item) => item.id));
    taken.add("import");
    const id = input.id ? assertId(input.id, `${kind} id`) : uniqueId(input.name, taken, kind);
    if (taken.has(id) || await store.exists(keys.meta(tenant, id))) throw new HttpError(409, "ERR-EXISTS", `${id} is already used by a project or datasource`);
    const now = clock().toISOString();
    const base = kind === "project" ? { categories: DEFAULT_CATEGORIES, datasources: [] } : {};
    return await write(tenant, await validate(tenant, { ...base, ...input, id, kind, createdAt: now, updatedAt: now }));
  }
  async function update(tenant, kind, id, input) {
    const current = await get(tenant, kind, id);
    return await write(tenant, await validate(tenant, { ...current, ...input, id, kind, createdAt: current.createdAt, updatedAt: clock().toISOString() }));
  }
  // Soft delete: the $meta.json is renamed, the data stay in the folder and the id drops out of the index.
  async function remove(tenant, kind, id) {
    await get(tenant, kind, id);
    if (kind === "datasource") {
      const users = [];
      for (const project of await list(tenant, "project")) if ((await get(tenant, "project", project.id)).datasources.includes(id)) users.push(project.id);
      if (users.length) throw new HttpError(409, "ERR-IN-USE", `datasource ${id} is used by projects: ${users.join(", ")}`, { projects: users });
    }
    await softDelete(store, keys.meta(tenant, id), timestamp(clock()));
    await indexService.remove(keys.tenantIndex(tenant), id);
    return { deleted: id };
  }

  // The active project, per user and tenant: there must always be one once the tenant has a project.
  async function preferences(tenant, email) { return await getJson(store, keys.userPrefs(tenant, email), {}); }
  async function activeProject(tenant, email) {
    const projects = await list(tenant, "project");
    const prefs = await preferences(tenant, email);
    if (projects.some((project) => project.id === prefs.activeProject)) return prefs.activeProject;
    return projects[0]?.id || null;
  }
  async function setActiveProject(tenant, email, project) {
    await get(tenant, "project", project);
    await updateJson(store, keys.userPrefs(tenant, email), (prefs) => ({ ...prefs, activeProject: project }), {});
    return { activeProject: project };
  }
  async function rebuild(tenant) {
    const { folders } = await store.listChildren(`${tenant}/`);
    const items = [];
    for (const folder of folders) {
      if (folder.startsWith("$") || folder === "import") continue;
      try { items.push(summary(await getJson(store, keys.meta(tenant, folder)))); } catch (error) { if (error.statusCode !== 404) throw error; }
    }
    await indexService.replace(keys.tenantIndex(tenant), items);
    return items;
  }
  return { list, get, create, update, remove, preferences, activeProject, setActiveProject, rebuild };
}
