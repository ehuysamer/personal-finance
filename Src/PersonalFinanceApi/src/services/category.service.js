import HttpError from "../models/httpError.model.js";
import { keys, uniqueId } from "../lib/keys.js";

// A project's categories, edited one at a time. Accounts, charts and forecasts refer to a category by its id, so a
// rename (name, type, inflation) applies everywhere at once; a delete moves the category's accounts to another
// category and repoints the charts and forecasts that named it.
export default function createCategoryService({ store, workspaceService, projectService, forecastService, clock = () => new Date() }) {
  const project = (tenant, projectId) => workspaceService.get(tenant, "project", projectId);

  async function create(tenant, projectId, input) {
    const meta = await project(tenant, projectId);
    const id = input.id || uniqueId(input.name, new Set(meta.categories.map((category) => category.id)), "category");
    if (meta.categories.some((category) => category.id === id)) throw new HttpError(409, "ERR-EXISTS", `category ${id} already exists`);
    const updated = await workspaceService.update(tenant, "project", projectId, { categories: [...meta.categories, { id, name: input.name, type: input.type || "expense", inflation: input.inflation ?? 0 }] });
    return updated.categories.find((category) => category.id === id);
  }

  async function update(tenant, projectId, categoryId, input) {
    const meta = await project(tenant, projectId);
    if (!meta.categories.some((category) => category.id === categoryId)) throw new HttpError(404, "ERR-NOT-FOUND", `category ${categoryId} was not found`);
    const categories = meta.categories.map((category) => (category.id === categoryId ? { ...category, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.type !== undefined ? { type: input.type } : {}), ...(input.inflation !== undefined ? { inflation: input.inflation } : {}) } : category));
    const updated = await workspaceService.update(tenant, "project", projectId, { categories });
    return updated.categories.find((category) => category.id === categoryId);
  }

  async function remove(tenant, projectId, categoryId, { moveTo } = {}) {
    const meta = await project(tenant, projectId);
    if (!meta.categories.some((category) => category.id === categoryId)) throw new HttpError(404, "ERR-NOT-FOUND", `category ${categoryId} was not found`);
    const rest = meta.categories.filter((category) => category.id !== categoryId);
    if (!rest.length) throw new HttpError(409, "ERR-LAST-CATEGORY", "a project needs at least one category");
    const target = moveTo || rest[0].id;
    if (!rest.some((category) => category.id === target)) throw new HttpError(400, "ERR-CATEGORY", `moveTo must be another category of the project: ${rest.map((category) => category.id).join(", ")}`);
    const now = clock().toISOString();
    // Accounts in the category move to the target.
    const moved = [];
    for (const account of await projectService.accounts.all(tenant, projectId)) {
      if (account.category !== categoryId) continue;
      await projectService.accounts.write(tenant, projectId, { ...account, category: target, updatedAt: now });
      moved.push(account.id);
    }
    // Chart series that totalled the category now total the target.
    const charts = [];
    for (const item of await projectService.charts.list(tenant, projectId)) {
      const chart = await projectService.charts.get(tenant, projectId, item.id);
      if (!(chart.series || []).some((series) => series.type === "category" && series.ref === categoryId)) continue;
      await projectService.charts.update(tenant, projectId, chart.id, { series: chart.series.map((series) => (series.type === "category" && series.ref === categoryId ? { ...series, ref: target } : series)) });
      charts.push(chart.id);
    }
    // Forecasts drop their inflation override for the category.
    const forecasts = [];
    for (const item of await forecastService.list(tenant, projectId)) {
      const forecast = await forecastService.get(tenant, projectId, item.id);
      if (forecast.inflation?.[categoryId] === undefined) continue;
      const { [categoryId]: _gone, ...inflation } = forecast.inflation;
      await forecastService.update(tenant, projectId, forecast.id, { inflation });
      forecasts.push(forecast.id);
    }
    await workspaceService.update(tenant, "project", projectId, { categories: rest });
    return { deleted: categoryId, movedTo: target, accounts: moved, charts, forecasts };
  }

  // Clone a project: its settings, accounts, rules, charts and forecast definitions (not analysis or forecast
  // results, jobs or deleted files: run Analyse on the copy).
  async function cloneProject(tenant, projectId, { name, id } = {}, user = {}) {
    const meta = await project(tenant, projectId);
    const { id: _id, createdAt: _c, updatedAt: _u, kind: _k, ...settings } = meta;
    const copy = await workspaceService.create(tenant, "project", { ...settings, ...(id ? { id } : {}), name: name || `${meta.name} (copy)` });
    const from = keys.folder(tenant, projectId);
    const to = keys.folder(tenant, copy.id);
    const skip = (rest) => rest === "$meta.json" || rest.startsWith("analysis/") || rest.startsWith("jobs/") || rest.endsWith(".deleted") || /^forecasts\/[^/]+\/(accounts\/|\$results\.json$|model\.json$)/.test(rest);
    let copied = 0;
    for (const key of await store.list(from)) {
      const rest = key.slice(from.length);
      if (skip(rest)) continue;
      const object = await store.get(key);
      await store.put(`${to}${rest}`, object.body, { contentType: object.contentType || "application/json" });
      copied += 1;
    }
    if (user.email) await workspaceService.setActiveProject(tenant, user.email, copy.id);
    return { ...copy, copied };
  }

  return { create, update, remove, cloneProject };
}
