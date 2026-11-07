import HttpError from "../models/httpError.model.js";
import { assertId, timestamp, uniqueId } from "../lib/keys.js";
import { getJson, putJson, softDelete } from "../lib/json.js";

// A folder of JSON documents ({folder}{id}.json) with its $index.json: importsources, accounts, rules, charts.
// summary(doc) is what the index keeps of each document; validate(doc, context) checks and normalises a write.
export default function createCollection({ store, indexService, clock = () => new Date(), what, summary, validate = (doc) => doc }) {
  const indexKey = (folder) => `${folder}$index.json`;
  const docKey = (folder, id) => `${folder}${id}.json`;
  async function get(folder, id) {
    assertId(id, `${what} id`);
    try { return await getJson(store, docKey(folder, id)); }
    catch (error) { if (error.statusCode === 404) throw new HttpError(404, "ERR-NOT-FOUND", `${what} ${id} was not found`); throw error; }
  }
  async function write(folder, doc) {
    await putJson(store, docKey(folder, doc.id), doc);
    await indexService.upsert(indexKey(folder), { id: doc.id, ...summary(doc) });
    return doc;
  }
  async function create(folder, input, context) {
    const taken = new Set((await indexService.list(indexKey(folder))).map((item) => item.id));
    const id = input.id ? assertId(input.id, `${what} id`) : uniqueId(input.name, taken, what);
    if (taken.has(id) || await store.exists(docKey(folder, id))) throw new HttpError(409, "ERR-EXISTS", `${what} ${id} already exists`);
    const now = clock().toISOString();
    return await write(folder, await validate({ ...input, id, createdAt: now, updatedAt: now }, context));
  }
  async function update(folder, id, input, context) {
    const current = await get(folder, id);
    return await write(folder, await validate({ ...current, ...input, id, createdAt: current.createdAt, updatedAt: clock().toISOString() }, context));
  }
  async function remove(folder, id) {
    await get(folder, id);
    await softDelete(store, docKey(folder, id), timestamp(clock()));
    await indexService.remove(indexKey(folder), id);
    return { deleted: id };
  }
  // Clone into this folder or another one (another datasource's importsources); move = clone, then delete.
  async function clone(folder, id, { name, targetFolder = folder, context } = {}) {
    const source = await get(folder, id);
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = source;
    return await create(targetFolder, { ...rest, name: name || (targetFolder === folder ? `${source.name} (copy)` : source.name) }, context);
  }
  async function list(folder) { return await indexService.list(indexKey(folder)); }
  async function all(folder) { return await Promise.all((await list(folder)).map((item) => get(folder, item.id))); }
  // Rebuild the index from the documents in the folder (repair).
  async function rebuild(folder) {
    const { objects } = await store.listChildren(folder);
    const docs = [];
    for (const key of objects) {
      const name = key.slice(folder.length);
      if (!name.endsWith(".json") || name.startsWith("$")) continue;
      docs.push(await getJson(store, key));
    }
    await indexService.replace(indexKey(folder), docs.map((doc) => ({ id: doc.id, ...summary(doc) })));
    return docs.length;
  }
  return { get, create, update, remove, clone, list, all, write, rebuild };
}
