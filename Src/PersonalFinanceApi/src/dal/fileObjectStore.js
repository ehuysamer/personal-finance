import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import HttpError from "../models/httpError.model.js";

function etag(body) {
  return createHash("sha256").update(body).digest("hex");
}

export default class FileObjectStore {
  constructor({ directory }) {
    this.directory = path.resolve(directory);
    this.metadataDirectory = path.join(this.directory, ".metadata");
  }

  pathsFor(key) {
    const normalized = String(key).replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new HttpError(400, "ERR-OBJECT-KEY", "object key is invalid");
    }
    return { body: path.join(this.directory, ...normalized.split("/")), metadata: path.join(this.metadataDirectory, ...normalized.split("/")) + ".json" };
  }

  async put(key, body, options = {}) {
    const paths = this.pathsFor(key);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    let previous;
    try { previous = JSON.parse(await readFile(paths.metadata, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (options.ifMatch && previous?.etag !== options.ifMatch) throw new HttpError(409, "ERR-PRECONDITION", "object version changed");
    if (options.ifNoneMatch && previous) throw new HttpError(409, "ERR-PRECONDITION", "object already exists");
    const item = { etag: etag(buffer), version: (previous?.version || 0) + 1, contentType: options.contentType || "application/octet-stream", tags: options.tags || {} };
    await mkdir(path.dirname(paths.body), { recursive: true });
    await mkdir(path.dirname(paths.metadata), { recursive: true });
    await writeFile(paths.body, buffer);
    await writeFile(paths.metadata, JSON.stringify(item));
    return { etag: item.etag, version: String(item.version) };
  }

  async get(key) {
    const paths = this.pathsFor(key);
    try {
      const [body, metadata] = await Promise.all([readFile(paths.body), readFile(paths.metadata, "utf8")]);
      return { ...JSON.parse(metadata), body };
    } catch (error) {
      if (error.code === "ENOENT") throw new HttpError(404, "ERR-OBJECT-NOT-FOUND", "object was not found");
      throw error;
    }
  }

  async exists(key) {
    try { await stat(this.pathsFor(key).body); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  async list(prefix = "") {
    const keys = [];
    const root = this.directory;
    async function visit(directory) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      await Promise.all(entries.map(async (entry) => {
        if (entry.name === ".metadata") return;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(target);
        const key = path.relative(root, target).replaceAll("\\", "/");
        if (key.startsWith(prefix)) keys.push(key);
      }));
    }
    await visit(root);
    return keys.sort();
  }

  async listChildren(prefix = "") {
    const directory = path.join(this.directory, ...prefix.split("/").filter(Boolean));
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return { folders: [], objects: [] }; throw error; }
    const visible = entries.filter((entry) => entry.name !== ".metadata");
    return {
      folders: visible.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
      objects: visible.filter((entry) => !entry.isDirectory()).map((entry) => `${prefix}${entry.name}`).sort()
    };
  }

  async delete(key) {
    const paths = this.pathsFor(key);
    await Promise.all([rm(paths.body, { force: true }), rm(paths.metadata, { force: true })]);
  }
}
