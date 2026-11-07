import HttpError from "../models/httpError.model.js";
import { assertId, keys, uniqueId } from "../lib/keys.js";
import { getJson, putJson } from "../lib/json.js";

// Who belongs to which tenant. Today: tenant files in the bucket ($tenants/) and the allow-list of emails in config.
// To move to the Subscription system later, replace this module only (same functions): the rest of the API asks
// it for a user's tenants and for membership checks and never reads $tenants/ itself.
export default function createTenantDirectory({ store, indexService, config, clock = () => new Date() }) {
  const normalise = (email) => String(email || "").trim().toLowerCase();
  function summary(tenant) { return { id: tenant.id, name: tenant.name, members: tenant.members.map((member) => member.email) }; }
  function isAllowed(email) { return config.allowedEmails.includes(normalise(email)); }

  async function get(tenantId) {
    assertId(tenantId, "tenant");
    try { return await getJson(store, keys.tenant(tenantId)); }
    catch (error) { if (error.statusCode === 404) throw new HttpError(404, "ERR-TENANT-NOT-FOUND", `tenant ${tenantId} was not found`); throw error; }
  }
  async function write(tenant) {
    await putJson(store, keys.tenant(tenant.id), tenant);
    await indexService.upsert(keys.tenantsIndex(), summary(tenant));
    return tenant;
  }
  async function tenantsFor(email) {
    const address = normalise(email);
    return (await indexService.list(keys.tenantsIndex())).filter((tenant) => tenant.members.includes(address)).map(({ id, name }) => ({ id, name }));
  }
  async function create(email, { id, name }) {
    const taken = new Set((await indexService.list(keys.tenantsIndex())).map((tenant) => tenant.id));
    const tenantId = id ? assertId(id, "tenant") : uniqueId(name, taken, "tenant");
    if (taken.has(tenantId)) throw new HttpError(409, "ERR-EXISTS", `tenant ${tenantId} already exists`);
    const now = clock().toISOString();
    return await write({ id: tenantId, name: String(name || tenantId), members: [{ email: normalise(email), role: "owner" }], createdAt: now, updatedAt: now });
  }
  // The user's tenants; a first tenant is created for an allowed user who has none.
  async function ensureTenants(user) {
    const tenants = await tenantsFor(user.email);
    if (tenants.length || user.source === "api-key") return tenants;
    const tenant = await create(user.email, { name: "Personal" });
    return [{ id: tenant.id, name: tenant.name }];
  }
  async function membership(user, tenantId) {
    if (user.source === "api-key") {
      if (user.tenant !== tenantId) throw new HttpError(403, "ERR-TENANT-FORBIDDEN", "this API key is for another tenant");
      return { tenant: await get(tenantId), role: "member" };
    }
    const tenant = await get(tenantId);
    const member = tenant.members.find((entry) => entry.email === normalise(user.email));
    if (!member) throw new HttpError(403, "ERR-TENANT-FORBIDDEN", "you are not a member of this tenant");
    return { tenant, role: member.role };
  }
  async function update(user, tenantId, input) {
    const { tenant, role } = await membership(user, tenantId);
    if (role !== "owner") throw new HttpError(403, "ERR-TENANT-OWNER", "only owners can change the tenant");
    const next = { ...tenant, updatedAt: clock().toISOString() };
    if (input.name !== undefined) next.name = String(input.name).trim() || tenant.name;
    if (input.members !== undefined) {
      const members = (Array.isArray(input.members) ? input.members : []).map((member) => ({ email: normalise(member.email), role: member.role === "owner" ? "owner" : "member" })).filter((member) => member.email.includes("@"));
      if (!members.some((member) => member.role === "owner")) throw new HttpError(400, "ERR-TENANT-OWNER", "a tenant needs at least one owner");
      next.members = members;
    }
    return await write(next);
  }
  return { isAllowed, tenantsFor, ensureTenants, membership, create, get, update };
}
