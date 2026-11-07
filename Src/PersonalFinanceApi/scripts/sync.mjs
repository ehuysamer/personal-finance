// Copies a tenant between the bucket and the local data/ folder, for working offline.
//   npm run sync:pull -- <env> <tenant>            bucket -> data/ (newer files only)
//   npm run sync:push -- <env> <tenant> [--delete] data/ -> bucket (newer files only; --delete removes files gone locally)
// A file changed on both sides since the last sync is not overwritten unless you answer yes. The indexes are
// rebuilt on the receiving side afterwards. The last sync's state is kept in data/.sync/{env}-{tenant}.json.
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import S3ObjectStore from "../src/dal/s3ObjectStore.js";
import FileObjectStore from "../src/dal/fileObjectStore.js";
import { buildDependencies } from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [direction, env, tenant] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const removeMissing = process.argv.includes("--delete");
const yes = process.argv.includes("--yes");
if (!["pull", "push"].includes(direction) || !env || !tenant) { console.error("usage: sync.mjs pull|push <env> <tenant> [--delete] [--yes]"); process.exit(2); }
const bucket = process.env.PERSONALFINANCE_BUCKET || (env === "dev" ? "personalfinance-dev-20261108" : `personalfinance-${env}-20261108`);
const remote = new S3ObjectStore({ bucket, region: process.env.AWS_REGION || "ap-southeast-2" });
const dataDirectory = process.env.PERSONALFINANCE_LOCAL_DATA_DIR || path.join(root, "data");
const local = new FileObjectStore({ directory: dataDirectory });
const stateFile = path.join(dataDirectory, ".sync", `${env}-${tenant}.json`);
const hash = (body) => createHash("sha256").update(body).digest("hex");

const state = JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "{}"));
const prefixes = [`${tenant}/`, `$tenants/${tenant}.json`, "$tenants/$index.json"];
async function snapshot(store) {
  const map = new Map();
  for (const prefix of prefixes) for (const key of await store.list(prefix)) if (!key.endsWith(".deleted")) map.set(key, hash((await store.get(key)).body));
  return map;
}
const [from, to] = direction === "pull" ? [remote, local] : [local, remote];
const source = await snapshot(from);
const target = await snapshot(to);
const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
let copied = 0; let skipped = 0; let removed = 0;
for (const [key, sourceHash] of source) {
  const targetHash = target.get(key);
  if (targetHash === sourceHash) continue;
  // Changed on both sides since the last sync: ask.
  if (targetHash && state[key] && targetHash !== state[key] && sourceHash !== state[key] && !yes) {
    const answer = await ask.question(`${key} changed on both sides; overwrite the ${direction === "pull" ? "local" : "bucket"} copy? [y/N] `);
    if (!/^y/i.test(answer)) { skipped += 1; continue; }
  }
  // The tenants index is merged, not replaced (the bucket may list other tenants).
  if (key === "$tenants/$index.json") continue;
  const object = await from.get(key);
  await to.put(key, object.body, { contentType: object.contentType || "application/json" });
  copied += 1;
}
if (removeMissing && direction === "push") for (const key of target.keys()) if (!source.has(key) && key.startsWith(`${tenant}/`)) { await to.delete(key); removed += 1; }
ask.close();
// Rebuild the receiving side's indexes from its folders.
const deps = buildDependencies({ store: to, config: { localAuth: true, useMemoryStore: true } });
const tenantDoc = JSON.parse((await to.get(`$tenants/${tenant}.json`)).body.toString("utf8"));
await deps.indexService.upsert("$tenants/$index.json", { id: tenantDoc.id, name: tenantDoc.name, members: tenantDoc.members.map((member) => member.email) });
for (const item of await deps.workspaceService.rebuild(tenant)) {
  if (item.kind === "datasource") await deps.importService.importsources.rebuild(tenant, item.id);
  else await deps.projectService.rebuild(tenant, item.id);
}
const after = await snapshot(to);
await fs.mkdir(path.dirname(stateFile), { recursive: true });
await fs.writeFile(stateFile, JSON.stringify(Object.fromEntries(after), null, 1));
console.log(`${direction} ${tenant} (${bucket}): ${copied} copied, ${skipped} skipped, ${removed} removed`);
