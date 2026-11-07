import { createHash, randomUUID } from "node:crypto";
import HttpError from "../models/httpError.model.js";
import { assertId, keys } from "../lib/keys.js";
import { getJson, putJson, updateJson } from "../lib/json.js";
import { FORMATS, parseFile } from "../lib/parse.js";
import { filenameMatches } from "../lib/match.js";
import { translateRows, validateTranslators } from "../lib/translate.js";
import { importReport, mergeFiles } from "../lib/dedupe.js";
import createCollection from "./collection.service.js";

function isDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(value)); }
function cleanFilename(name) {
  const base = String(name || "").split(/[\\/]/).pop().trim();
  if (!base || base.startsWith(".") || base.startsWith("$") || base.length > 200) throw new HttpError(400, "ERR-FILENAME", "filename is invalid");
  return base;
}

function validateImportsource(doc) {
  doc.name = String(doc.name || "").trim();
  if (!doc.name) throw new HttpError(400, "ERR-NAME", "name is required");
  if (!FORMATS.includes(doc.format)) throw new HttpError(400, "ERR-FORMAT", `format must be one of ${FORMATS.join(", ")}`);
  doc.options = doc.options && typeof doc.options === "object" ? doc.options : {};
  if (doc.filenameFilter && typeof doc.filenameFilter === "string") doc.filenameFilter = { type: "wildcard", pattern: doc.filenameFilter };
  if (doc.filenameFilter) {
    if (!["wildcard", "regex"].includes(doc.filenameFilter.type)) throw new HttpError(400, "ERR-FILTER", "filenameFilter.type is wildcard or regex");
    filenameMatches(doc.filenameFilter, "x");
  }
  doc.translators = validateTranslators(doc.translators);
  return doc;
}

export default function createImportService({ store, indexService, workspaceService, config, clock = () => new Date() }) {
  const importsources = createCollection({ store, indexService, clock, what: "importsource", summary: (doc) => ({ name: doc.name, format: doc.format, filenameFilter: doc.filenameFilter || null }), validate: validateImportsource });
  const folder = (tenant, ds) => keys.importsources(tenant, ds);
  const datasource = (tenant, ds) => workspaceService.get(tenant, "datasource", ds);

  async function files(tenant, ds) { return (await getJson(store, keys.filesIndex(tenant, ds), { items: [] })).items; }
  async function fileRows(tenant, ds, file) { return (await getJson(store, keys.fileRows(tenant, ds, file.id))).rows; }

  // The importsources whose filename filter matches.
  async function matchImportsource(tenant, ds, filename) {
    return (await importsources.list(folder(tenant, ds))).filter((item) => filenameMatches(item.filenameFilter, filename));
  }

  // Import sample: a file's columns and first rows, and (with an importsource or unsaved translators) the
  // normalised rows it would give, before anything is saved.
  // The sample is contentBase64, or content already read by the caller (a document: see documents_list).
  async function sample(tenant, ds, { filename, contentBase64, content, format, options, translators, importsource, limit = 20 }) {
    await datasource(tenant, ds);
    const buffer = content || Buffer.from(String(contentBase64 || ""), "base64");
    if (!buffer.length) throw new HttpError(400, "ERR-UPLOAD", "contentBase64 or documentPath is required");
    let definition = importsource ? await importsources.get(folder(tenant, ds), importsource) : null;
    const fileFormat = format || definition?.format || String(filename || "").split(".").pop().toLowerCase();
    const table = parseFile(buffer, fileFormat, options || definition?.options || {}, { maxRows: config.maxRowsPerFile });
    const result = { format: fileFormat, columns: table.columns, rowCount: table.rows.length, rows: table.rows.slice(0, limit) };
    const use = translators ? validateTranslators(translators) : definition?.translators;
    if (use) { const translated = translateRows(table.rows, use); result.normalised = translated.rows.slice(0, limit); result.rejected = translated.rejected.slice(0, limit); result.rejectedCount = translated.rejected.length; }
    return result;
  }

  // Upload a statement: the importsource is chosen by the filename filters unless named. The same filename again
  // replaces that file's rows; the same content under another name is refused as already imported.
  // Large files go straight to the bucket: the browser PUTs to a presigned URL under {ds}/$uploads/, then calls
  // upload with uploadId. Stores without presigning (local, memory) answer url null: send contentBase64 instead.
  async function uploadUrl(tenant, ds, { filename }) {
    await datasource(tenant, ds);
    const name = cleanFilename(filename);
    if (typeof store.uploadUrl !== "function") return { url: null };
    const uploadId = randomUUID();
    return { url: await store.uploadUrl(`${tenant}/${ds}/$uploads/${uploadId}/${name}`), uploadId, contentType: "application/octet-stream", expiresIn: 900 };
  }

  async function upload(tenant, ds, { filename, contentBase64, uploadId, importsource }) {
    await datasource(tenant, ds);
    const name = cleanFilename(filename);
    let buffer;
    const uploadKey = uploadId ? `${tenant}/${ds}/$uploads/${assertId(String(uploadId), "uploadId")}/${name}` : null;
    if (uploadKey) {
      try { buffer = (await store.get(uploadKey)).body; } catch (error) { if (error.statusCode === 404) throw new HttpError(400, "ERR-UPLOAD", "the uploaded file was not found; upload it again"); throw error; }
      await store.delete(uploadKey);
    } else buffer = Buffer.from(String(contentBase64 || ""), "base64");
    if (!buffer.length) throw new HttpError(400, "ERR-UPLOAD", "contentBase64 is required");
    return await importBuffer(tenant, ds, name, buffer, importsource);
  }

  // Why an importsource read no rows from a file, in words.
  function nothingRead(table, rejected) {
    if (!table.rows.length) return "the file has no data rows (check the lines to skip, the header row, the sheet or the rows path)";
    return `all ${table.rows.length} rows were rejected: ${rejected[0].errors.join("; ")}`;
  }

  // Reads a file with the importsource given, then the ones whose filename filter matches, then the datasource's
  // others, until one reads at least one row. attempts lists the ones that read nothing, and why.
  async function readWithFallback(tenant, ds, name, buffer, preferred) {
    const all = await importsources.list(folder(tenant, ds));
    if (!all.length) throw new HttpError(409, "ERR-NO-IMPORTSOURCE", "this datasource has no importsource yet: set one up (Importsources) to read its statements");
    if (preferred) await importsources.get(folder(tenant, ds), preferred);
    const order = [...new Set([preferred, ...all.filter((item) => filenameMatches(item.filenameFilter, name)).map((item) => item.id), ...all.map((item) => item.id)].filter(Boolean))];
    const attempts = [];
    for (const id of order) {
      const definition = await importsources.get(folder(tenant, ds), id);
      let table;
      try { table = parseFile(buffer, definition.format, definition.options, { maxRows: config.maxRowsPerFile }); }
      catch (error) { if (error.code === "ERR-TOO-MANY-ROWS") throw error; attempts.push({ importsource: id, name: definition.name, reason: error.message }); continue; }
      const { rows, rejected } = translateRows(table.rows, definition.translators);
      if (rows.length) return { definition, rows, rejected, attempts };
      attempts.push({ importsource: id, name: definition.name, reason: nothingRead(table, rejected) });
    }
    throw new HttpError(422, "ERR-NOTHING-READ", `Nothing was imported from ${name}: ${attempts.map((attempt) => `${attempt.name}: ${attempt.reason}`).join(". ")}`, { attempts });
  }

  // Imports a file into a datasource. When it adds nothing, reason says why.
  async function importBuffer(tenant, ds, name, buffer, importsource) {
    if (buffer.length > config.maxUploadBytes) throw new HttpError(413, "ERR-TOO-LARGE", `files are at most ${Math.round(config.maxUploadBytes / 1048576)} MB`);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const existing = await files(tenant, ds);
    const sameContent = existing.find((file) => file.sha256 === sha256 && file.filename !== name);
    if (sameContent) return { status: "already-imported", filename: name, sameAs: sameContent.filename, added: 0, alreadyPresent: sameContent.rows, reason: `the same file was already imported as ${sameContent.filename}` };
    const { definition, rows, rejected, attempts } = await readWithFallback(tenant, ds, name, buffer, importsource);
    const sourceId = definition.id;
    const previous = existing.find((file) => file.filename === name);
    const others = [];
    for (const file of existing) if (file.id !== previous?.id) others.push({ rows: await fileRows(tenant, ds, file) });
    const report = importReport(others, rows);
    const fileId = previous?.id || `${clock().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    await store.put(keys.fileOriginal(tenant, ds, fileId, name), buffer, { contentType: "application/octet-stream" });
    await putJson(store, keys.fileRows(tenant, ds, fileId), { fileId, filename: name, importsource: sourceId, rows, rejected });
    const dates = rows.map((row) => row.date).sort();
    const entry = { id: fileId, filename: name, size: buffer.length, sha256, importsource: sourceId, rows: rows.length, rejected: rejected.length, firstDate: dates[0] || null, lastDate: dates.at(-1) || null, importedAt: previous?.importedAt || clock().toISOString(), updatedAt: clock().toISOString(), status: "imported" };
    await updateJson(store, keys.filesIndex(tenant, ds), (index) => ({ items: [...index.items.filter((file) => file.id !== fileId), entry], updatedAt: clock().toISOString() }), { items: [] });
    const result = { status: previous ? "replaced" : "imported", file: entry, importsource: sourceId, importsourceName: definition.name, ...report, rejected: rejected.slice(0, 20), rejectedCount: rejected.length, ...(attempts.length ? { triedFirst: attempts } : {}) };
    if (!report.added) result.reason = report.alreadyPresent ? `all ${report.alreadyPresent} transactions are already in this datasource (from earlier statements)` : "no transactions were read";
    if (rejected.length) result.reason = `${result.reason ? `${result.reason}; ` : ""}${rejected.length} rows were rejected (first: row ${rejected[0].row}, ${rejected[0].errors.join("; ")})`;
    return result;
  }

  // The tenant's import folder ({tenant}/import/, data/{tenant}/import/ offline): files dropped there (S3 console,
  // aws s3 cp, sync:push) are listed with the datasources and importsources whose filename filters match, and
  // imported from there. An imported file moves to import/imported/{yyyy-mm-dd}/ unless keep is asked for.
  const IMPORT = (tenant) => `${tenant}/import/`;
  async function candidatesFor(tenant, filename) {
    const out = [];
    for (const item of await workspaceService.list(tenant, "datasource")) {
      for (const source of await matchImportsource(tenant, item.id, filename)) out.push({ datasource: item.id, datasourceName: item.name, importsource: source.id, importsourceName: source.name });
    }
    return out;
  }
  async function folderFiles(tenant) {
    const prefix = IMPORT(tenant);
    const paths = (await store.list(prefix)).map((key) => key.slice(prefix.length)).filter((path) => path && !path.startsWith("imported/") && !path.endsWith("/") && !path.split("/").some((part) => part.startsWith(".")));
    const items = [];
    for (const path of paths) {
      const filename = path.split("/").pop();
      items.push({ path, filename, candidates: await candidatesFor(tenant, filename) });
    }
    return items;
  }
  function folderKey(tenant, path) {
    const clean = String(path || "").replaceAll("\\", "/");
    if (!clean || clean.startsWith("/") || clean.startsWith("imported/") || clean.split("/").some((part) => !part || part === "." || part === "..")) throw new HttpError(400, "ERR-PATH", "path is a file in the import folder");
    return `${IMPORT(tenant)}${clean}`;
  }
  // Imports one file of the folder: into the datasource and importsource given, or the only ones that match.
  // Imports a stored file (the import folder or a document) into the datasource and importsource given, or the only
  // ones whose filename filters match.
  async function importStored(tenant, key, { datasource: ds, importsource, label = key } = {}) {
    const name = cleanFilename(key.split("/").pop());
    let targets = ds ? [{ datasource: ds, importsource }] : await candidatesFor(tenant, name);
    if (!targets.length) throw new HttpError(409, "ERR-IMPORTSOURCE-CHOICE", "no importsource's filename filter matches this file; choose a datasource", { candidates: [] });
    targets = targets.filter((target, i) => targets.findIndex((other) => other.datasource === target.datasource) === i);
    let object;
    try { object = await store.get(key); } catch (error) { if (error.statusCode === 404) throw new HttpError(404, "ERR-NOT-FOUND", `${label} was not found`); throw error; }
    if (object.body.length > config.maxUploadBytes) throw new HttpError(413, "ERR-TOO-LARGE", `statements are at most ${Math.round(config.maxUploadBytes / 1048576)} MB`);
    const failures = [];
    for (const target of targets) {
      await datasource(tenant, target.datasource);
      try {
        const result = await importBuffer(tenant, target.datasource, name, object.body, target.importsource);
        return { object, datasource: target.datasource, importsource: result.importsource || target.importsource, ...result };
      } catch (error) {
        if (error.code !== "ERR-NOTHING-READ" || targets.length === 1) throw error;
        failures.push(...error.data.attempts.map((attempt) => ({ ...attempt, datasource: target.datasource })));
      }
    }
    throw new HttpError(422, "ERR-NOTHING-READ", `Nothing was imported from ${name}: ${failures.map((attempt) => `${attempt.datasource}/${attempt.name}: ${attempt.reason}`).join(". ")}`, { attempts: failures });
  }

  async function importFromFolder(tenant, { path, datasource: ds, importsource, keep = false }) {
    const key = folderKey(tenant, path);
    const { object, ...result } = await importStored(tenant, key, { datasource: ds, importsource, label: `${path} in the import folder` });
    let movedTo = null;
    if (!keep) {
      movedTo = `imported/${clock().toISOString().slice(0, 10)}/${path}`;
      await store.put(`${IMPORT(tenant)}${movedTo}`, object.body, { contentType: object.contentType || "application/octet-stream" });
      await store.delete(key);
    }
    return { path, movedTo, ...result };
  }

  async function deleteFile(tenant, ds, fileId) {
    const file = (await files(tenant, ds)).find((item) => item.id === fileId);
    if (!file) throw new HttpError(404, "ERR-NOT-FOUND", `file ${fileId} was not found`);
    await updateJson(store, keys.filesIndex(tenant, ds), (index) => ({ items: index.items.filter((item) => item.id !== fileId), updatedAt: clock().toISOString() }), { items: [] });
    for (const key of [keys.fileRows(tenant, ds, fileId), keys.fileOriginal(tenant, ds, fileId, file.filename)]) {
      const object = await store.get(key).catch(() => null);
      if (object) { await store.put(`${key}.${clock().toISOString().replace(/\D/g, "").slice(0, 14)}.deleted`, object.body); await store.delete(key); }
    }
    return { deleted: fileId };
  }

  // Manual transactions (marked manual) and totals: a bank account's balance on a date, the source of truth.
  function validateManual(input) {
    if (!isDate(input.date)) throw new HttpError(400, "ERR-DATE", "date must be yyyy-mm-dd");
    const amount = Number(input.amount);
    if (!Number.isFinite(amount)) throw new HttpError(400, "ERR-AMOUNT", "amount must be a number");
    return { date: input.date, account: String(input.account || "").trim(), description: String(input.description || "").trim(), amount: Math.round(amount * 100) / 100, note: input.note ? String(input.note) : undefined };
  }
  function validateTotal(input) {
    if (!isDate(input.date)) throw new HttpError(400, "ERR-DATE", "date must be yyyy-mm-dd");
    const balance = Number(input.balance);
    if (!Number.isFinite(balance)) throw new HttpError(400, "ERR-AMOUNT", "balance must be a number");
    return { date: input.date, account: String(input.account || "").trim(), balance: Math.round(balance * 100) / 100, note: input.note ? String(input.note) : undefined };
  }
  function manualList(kind) {
    const keyFor = kind === "totals" ? keys.manualTotals : keys.manualTransactions;
    const check = kind === "totals" ? validateTotal : validateManual;
    return {
      async list(tenant, ds) { await datasource(tenant, ds); return (await getJson(store, keyFor(tenant, ds), { items: [] })).items.sort((a, b) => b.date.localeCompare(a.date)); },
      async create(tenant, ds, input) {
        await datasource(tenant, ds);
        const item = { id: randomUUID().slice(0, 12), ...check(input), createdAt: clock().toISOString() };
        await updateJson(store, keyFor(tenant, ds), (doc) => ({ items: [...doc.items, item] }), { items: [] });
        return item;
      },
      async update(tenant, ds, id, input) {
        let updated;
        await updateJson(store, keyFor(tenant, ds), (doc) => {
          const current = doc.items.find((item) => item.id === id);
          if (!current) throw new HttpError(404, "ERR-NOT-FOUND", `${id} was not found`);
          updated = { ...current, ...check({ ...current, ...input }), updatedAt: clock().toISOString() };
          return { items: doc.items.map((item) => (item.id === id ? updated : item)) };
        }, { items: [] });
        return updated;
      },
      async remove(tenant, ds, id) {
        await updateJson(store, keyFor(tenant, ds), (doc) => {
          if (!doc.items.some((item) => item.id === id)) throw new HttpError(404, "ERR-NOT-FOUND", `${id} was not found`);
          return { items: doc.items.filter((item) => item.id !== id) };
        }, { items: [] });
        return { deleted: id };
      }
    };
  }
  const manualTransactions = manualList("transactions");
  const totals = manualList("totals");

  // Every transaction of a datasource: imported rows (de-duplicated across files) and manual ones.
  async function datasourceTransactions(tenant, ds) {
    const list = (await files(tenant, ds)).sort((a, b) => a.importedAt.localeCompare(b.importedAt));
    const loaded = [];
    for (const file of list) loaded.push({ fileId: file.id, filename: file.filename, rows: await fileRows(tenant, ds, file) });
    const imported = mergeFiles(loaded).map((row) => ({ ...row, datasource: ds, source: "import" }));
    const manual = (await getJson(store, keys.manualTransactions(tenant, ds), { items: [] })).items.map((item) => ({ ...item, manualId: item.id, datasource: ds, source: "manual" }));
    return [...imported, ...manual];
  }

  // Bank accounts seen in a datasource, with their balance from the transactions and totals.
  async function bankAccounts(tenant, ds) {
    const transactions = await datasourceTransactions(tenant, ds);
    const allTotals = await totals.list(tenant, ds);
    const map = new Map();
    for (const tx of transactions) { const entry = map.get(tx.account) || { account: tx.account, transactions: 0, sum: 0, lastDate: null }; entry.transactions += 1; entry.sum = Math.round((entry.sum + tx.amount) * 100) / 100; entry.lastDate = !entry.lastDate || tx.date > entry.lastDate ? tx.date : entry.lastDate; map.set(tx.account, entry); }
    for (const total of allTotals) { const entry = map.get(total.account) || { account: total.account, transactions: 0, sum: 0, lastDate: null }; if (!entry.lastTotal || total.date > entry.lastTotal.date) entry.lastTotal = { date: total.date, balance: total.balance }; map.set(total.account, entry); }
    return [...map.values()].sort((a, b) => a.account.localeCompare(b.account));
  }

  return {
    importsources: {
      list: (tenant, ds) => importsources.list(folder(tenant, ds)),
      get: (tenant, ds, id) => importsources.get(folder(tenant, ds), id),
      async create(tenant, ds, input) { await datasource(tenant, ds); return await importsources.create(folder(tenant, ds), input); },
      update: (tenant, ds, id, input) => importsources.update(folder(tenant, ds), id, input),
      remove: (tenant, ds, id) => importsources.remove(folder(tenant, ds), id),
      async clone(tenant, ds, id, { name, targetDatasource, move } = {}) {
        const target = targetDatasource ? assertId(targetDatasource, "datasource") : ds;
        await datasource(tenant, target);
        const copy = await importsources.clone(folder(tenant, ds), id, { name, targetFolder: folder(tenant, target) });
        if (move) await importsources.remove(folder(tenant, ds), id);
        return copy;
      },
      match: matchImportsource,
      rebuild: (tenant, ds) => importsources.rebuild(folder(tenant, ds))
    },
    files, sample, upload, uploadUrl, deleteFile, folderFiles, importFromFolder, importStored, candidatesFor, manualTransactions, totals, datasourceTransactions, bankAccounts
  };
}
