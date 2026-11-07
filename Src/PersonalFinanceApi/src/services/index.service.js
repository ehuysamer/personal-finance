import { getJson, updateJson } from "../lib/json.js";

// $index.json files: lists of things (tenants, projects, datasources, accounts, rules, ...) so nothing needs an S3
// list call to show them. Each is { items: [{ id, ...summary }], updatedAt }, kept in step by every write.
export default function createIndexService({ store, clock = () => new Date() }) {
  const empty = () => ({ items: [], updatedAt: null });
  return {
    async list(key) { return (await getJson(store, key, empty)).items; },
    async upsert(key, entry) {
      return await updateJson(store, key, (index) => {
        const items = index.items.filter((item) => item.id !== entry.id);
        const previous = index.items.find((item) => item.id === entry.id);
        items.push({ ...previous, ...entry });
        items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
        return { items, updatedAt: clock().toISOString() };
      }, empty);
    },
    async remove(key, id) {
      return await updateJson(store, key, (index) => index.items.some((item) => item.id === id) ? { items: index.items.filter((item) => item.id !== id), updatedAt: clock().toISOString() } : undefined, empty);
    },
    async replace(key, items) {
      return await updateJson(store, key, () => ({ items, updatedAt: clock().toISOString() }), empty);
    }
  };
}
