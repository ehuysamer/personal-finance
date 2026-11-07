import { createHash } from "node:crypto";
import HttpError from "../models/httpError.model.js";
import { getJson, updateJson } from "../lib/json.js";
import { timestamp } from "../lib/keys.js";

const CONTENT_TYPES = { pdf: "application/pdf", csv: "text/csv", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", heic: "image/heic", gif: "image/gif", webp: "image/webp", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip: "application/zip" };

// Documents: any files the user keeps, in folders, at {tenant}/documents/{path}; documents/$index.json lists them
// (path, size, type, sha256, uploadedAt). Statements among them can be imported into a datasource, and stay here.
// Large files go straight to the bucket with a presigned URL, then are registered.
export default function createDocumentsService({ store, importService, config, clock = () => new Date() }) {
  const root = (tenant) => `${tenant}/documents/`;
  const indexKey = (tenant) => `${root(tenant)}$index.json`;
  const contentType = (path) => CONTENT_TYPES[String(path).split(".").pop().toLowerCase()] || "application/octet-stream";

  function cleanPath(path) {
    const clean = String(path || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
    const parts = clean.split("/");
    if (!clean || clean.length > 400 || parts.some((part) => !part || part === "." || part === ".." || part.startsWith("$") || part.startsWith(".") || part.length > 200 || /[\u0000-\u001f]/.test(part))) throw new HttpError(400, "ERR-PATH", "a document path is folder/name, without . or $ at the start of a part");
    return clean;
  }
  const keyOf = (tenant, path) => `${root(tenant)}${cleanPath(path)}`;
  async function all(tenant) { return (await getJson(store, indexKey(tenant), { items: [] })).items; }
  async function register(tenant, path, body, previous) {
    const entry = { id: path, path, name: path.split("/").pop(), size: body.length, contentType: contentType(path), sha256: createHash("sha256").update(body).digest("hex"), uploadedAt: previous?.uploadedAt || clock().toISOString(), updatedAt: clock().toISOString() };
    await updateJson(store, indexKey(tenant), (index) => ({ items: [...index.items.filter((item) => item.path !== path), entry].sort((a, b) => a.path.localeCompare(b.path)) }), { items: [] });
    return entry;
  }

  // A folder's sub-folders and files (folders exist while they hold a file).
  async function list(tenant, folder = "") {
    const prefix = folder ? `${cleanPath(folder)}/` : "";
    const items = await all(tenant);
    const folders = new Set();
    const files = [];
    for (const item of items) {
      if (!item.path.startsWith(prefix)) continue;
      const rest = item.path.slice(prefix.length);
      if (rest.includes("/")) folders.add(rest.split("/")[0]); else files.push(item);
    }
    return { folder: prefix.replace(/\/$/, ""), folders: [...folders].sort(), files, total: items.length };
  }
  async function search(tenant, q = "") {
    const text = String(q).toLowerCase();
    return (await all(tenant)).filter((item) => !text || item.path.toLowerCase().includes(text));
  }

  async function upload(tenant, { path, contentBase64, uploaded }) {
    const clean = cleanPath(path);
    const key = keyOf(tenant, clean);
    let body;
    if (uploaded) {
      try { body = (await store.get(key)).body; } catch (error) { if (error.statusCode === 404) throw new HttpError(400, "ERR-UPLOAD", "the uploaded file was not found; upload it again"); throw error; }
    } else {
      body = Buffer.from(String(contentBase64 || ""), "base64");
      if (!body.length) throw new HttpError(400, "ERR-UPLOAD", "contentBase64 is required");
    }
    if (body.length > config.maxDocumentBytes) {
      if (uploaded) await store.delete(key);
      throw new HttpError(413, "ERR-TOO-LARGE", `documents are at most ${Math.round(config.maxDocumentBytes / 1048576)} MB`);
    }
    const previous = (await all(tenant)).find((item) => item.path === clean);
    if (!uploaded) await store.put(key, body, { contentType: contentType(clean) });
    return { ...(await register(tenant, clean, body, previous)), replaced: Boolean(previous) };
  }
  async function uploadUrl(tenant, { path }) {
    const key = keyOf(tenant, path);
    if (typeof store.uploadUrl !== "function") return { url: null };
    return { url: await store.uploadUrl(key, { contentType: contentType(path) }), contentType: contentType(path), expiresIn: 900 };
  }
  async function download(tenant, { path }) {
    const clean = cleanPath(path);
    if (!(await all(tenant)).some((item) => item.path === clean)) throw new HttpError(404, "ERR-NOT-FOUND", `${clean} was not found`);
    const key = keyOf(tenant, clean);
    if (typeof store.downloadUrl === "function") return { url: await store.downloadUrl(key, { filename: clean.split("/").pop() }), contentType: contentType(clean) };
    return { url: null, contentType: contentType(clean), contentBase64: (await store.get(key)).body.toString("base64") };
  }
  async function move(tenant, { path, to }) {
    const from = cleanPath(path);
    const target = cleanPath(to);
    const items = await all(tenant);
    const entry = items.find((item) => item.path === from);
    if (!entry) throw new HttpError(404, "ERR-NOT-FOUND", `${from} was not found`);
    if (items.some((item) => item.path === target)) throw new HttpError(409, "ERR-EXISTS", `${target} already exists`);
    const object = await store.get(keyOf(tenant, from));
    await store.put(keyOf(tenant, target), object.body, { contentType: contentType(target) });
    await store.delete(keyOf(tenant, from));
    await updateJson(store, indexKey(tenant), (index) => ({ items: index.items.map((item) => (item.path === from ? { ...item, id: target, path: target, name: target.split("/").pop(), contentType: contentType(target), updatedAt: clock().toISOString() } : item)).sort((a, b) => a.path.localeCompare(b.path)) }), { items: [] });
    return { from, to: target };
  }
  // Soft delete: the file is renamed .{timestamp}.deleted and leaves the index.
  async function remove(tenant, { path }) {
    const clean = cleanPath(path);
    const key = keyOf(tenant, clean);
    const object = await store.get(key).catch(() => null);
    if (object) { await store.put(`${key}.${timestamp(clock())}.deleted`, object.body); await store.delete(key); }
    await updateJson(store, indexKey(tenant), (index) => ({ items: index.items.filter((item) => item.path !== clean) }), { items: [] });
    return { deleted: clean };
  }
  // Rebuild the index from the files in documents/ (e.g. after files were copied in with aws s3 cp).
  async function rebuild(tenant) {
    const items = [];
    for (const key of await store.list(root(tenant))) {
      const path = key.slice(root(tenant).length);
      if (path === "$index.json" || path.endsWith(".deleted") || path.split("/").some((part) => part.startsWith("$") || part.startsWith("."))) continue;
      const body = (await store.get(key)).body;
      items.push({ id: path, path, name: path.split("/").pop(), size: body.length, contentType: contentType(path), sha256: createHash("sha256").update(body).digest("hex"), uploadedAt: clock().toISOString(), updatedAt: clock().toISOString() });
    }
    await updateJson(store, indexKey(tenant), () => ({ items }), { items: [] });
    return items.length;
  }

  // Import: the datasources and importsources whose filename filters match, then import (the document stays).
  async function candidates(tenant, { path }) { return { path: cleanPath(path), candidates: await importService.candidatesFor(tenant, cleanPath(path).split("/").pop()) }; }
  async function importDocument(tenant, { path, datasource, importsource }) {
    const clean = cleanPath(path);
    if (!(await all(tenant)).some((item) => item.path === clean)) throw new HttpError(404, "ERR-NOT-FOUND", `${clean} was not found`);
    const { object: _object, ...result } = await importService.importStored(tenant, keyOf(tenant, clean), { datasource, importsource, label: clean });
    return { path: clean, ...result };
  }

  return { list, search, upload, uploadUrl, download, move, remove, rebuild, candidates, importDocument, cleanPath };
}
