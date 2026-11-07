import HttpError from "../models/httpError.model.js";

export async function readJson(store, key, fallback) {
  try {
    const object = await store.get(key);
    return { value: JSON.parse(object.body.toString("utf8")), etag: object.etag };
  } catch (error) {
    if (error.statusCode === 404 && fallback !== undefined) return { value: typeof fallback === "function" ? fallback() : structuredClone(fallback), etag: null };
    throw error;
  }
}

export async function getJson(store, key, fallback) { return (await readJson(store, key, fallback)).value; }

export async function putJson(store, key, value, options = {}) {
  return await store.put(key, JSON.stringify(value), { contentType: "application/json", ...options });
}

// Read-change-write with a conditional write, retried when another writer got there first, so two writes never
// lose each other's change (S3 If-Match / If-None-Match; the file and memory stores do the same).
export async function updateJson(store, key, change, fallback, attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const { value, etag } = await readJson(store, key, fallback);
    const next = await change(value);
    if (next === undefined) return value;
    try {
      await putJson(store, key, next, etag ? { ifMatch: etag } : { ifNoneMatch: true });
      return next;
    } catch (error) {
      if (error.statusCode !== 409 || attempt >= attempts) throw error.statusCode === 409 ? new HttpError(409, "ERR-CONFLICT", `${key} kept changing; try again`) : error;
    }
  }
}

export async function softDelete(store, key, stamp) {
  const object = await store.get(key);
  await store.put(`${key}.${stamp}.deleted`, object.body, { contentType: object.contentType });
  await store.delete(key);
}
