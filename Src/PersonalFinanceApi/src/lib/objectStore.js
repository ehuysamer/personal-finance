import { createHash } from "node:crypto";
import HttpError from "../models/httpError.model.js";

function etag(body) {
  return createHash("sha256").update(body).digest("hex");
}

// Splits keys below a "/"-terminated prefix into immediate sub-folder names and direct object keys.
export function childrenFromKeys(keys, prefix) {
  const folders = new Set();
  const objects = [];
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) objects.push(key);
    else folders.add(rest.slice(0, slash));
  }
  return { folders: [...folders].sort(), objects: objects.sort() };
}

export class MemoryObjectStore {
  constructor() { this.objects = new Map(); }
  async put(key, body, options = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const previous = this.objects.get(key);
    if (options.ifMatch && previous?.etag !== options.ifMatch) throw new HttpError(409, "ERR-PRECONDITION", "object version changed");
    if (options.ifNoneMatch && previous) throw new HttpError(409, "ERR-PRECONDITION", "object already exists");
    const item = { body: buffer, etag: etag(buffer), version: (previous?.version || 0) + 1, contentType: options.contentType || "application/octet-stream", tags: options.tags || {} };
    this.objects.set(key, item);
    return { etag: item.etag, version: String(item.version) };
  }
  async get(key) {
    const item = this.objects.get(key);
    if (!item) throw new HttpError(404, "ERR-OBJECT-NOT-FOUND", "object was not found");
    return { ...item, body: Buffer.from(item.body) };
  }
  async exists(key) { return this.objects.has(key); }
  async list(prefix = "") { return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(); }
  async listChildren(prefix = "") { return childrenFromKeys(await this.list(prefix), prefix); }
  async delete(key) { this.objects.delete(key); }
}
