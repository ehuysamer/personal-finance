// Offline command line: the same services as the API, on the local data/ folder (or the bucket with --s3),
// signed in as the local owner, with jobs run here slice after slice until they end.
//   npm run import -- <tenant> <datasource> [files...]   (no files: everything in data/import/)
//   npm run import -- <tenant> --folder                  every file in the tenant's import folder with one match
//   npm run analyse -- <tenant> [project]                (project: the active one when left out)
//   npm run forecast -- <tenant> [project] <forecast>
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDependencies, createInlineDispatcher } from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const useS3 = process.argv.includes("--s3");
const [command, tenant, ...rest] = args;
if (!command || !tenant) { console.error("usage: cli.mjs import|analyse|forecast <tenant> ..."); process.exit(2); }
const dispatcher = createInlineDispatcher();
const deps = buildDependencies({ dispatcher, config: { localAuth: true, ...(useS3 ? {} : { localDataDirectory: process.env.PERSONALFINANCE_LOCAL_DATA_DIR || path.join(root, "data") }), localJobSliceMs: 15 * 60 * 1000 } });
const user = { email: deps.config.localUserEmail, source: "local" };
await deps.tenantDirectory.membership(user, tenant);

async function runJob(project, type, params) {
  const job = await deps.jobService.start(tenant, project, type, params, user);
  console.log(`${type} job ${job.id} started`);
  while (dispatcher.queue.length) {
    const end = Date.now() + deps.config.localJobSliceMs;
    const state = await deps.jobService.work(dispatcher.queue.shift(), { remainingMs: () => end - Date.now() });
    const { message, done, total } = state.progress || {};
    console.log(`  ${state.status}: ${message || ""}${total ? ` (${done}/${total})` : ""}`);
  }
  const final = await deps.jobService.get(tenant, project, job.id);
  if (final.status !== "complete") { console.error(`${type} ${final.status}: ${final.error?.message || ""}`); process.exitCode = 1; }
  return final;
}

if (command === "import" && process.argv.includes("--folder")) {
  for (const item of await deps.importService.folderFiles(tenant)) {
    if (item.candidates.length !== 1) { console.log(`${item.path}: skipped, ${item.candidates.length} matching importsources`); continue; }
    const result = await deps.importService.importFromFolder(tenant, { path: item.path });
    console.log(`${item.path}: ${result.status} into ${result.datasource}, ${result.added ?? 0} added, ${result.alreadyPresent ?? 0} already present`);
  }
} else if (command === "import") {
  const [datasource, ...files] = rest;
  if (!datasource) { console.error("usage: cli.mjs import <tenant> <datasource> [files...]"); process.exit(2); }
  const dropFolder = path.join(root, "data", "import");
  const list = files.length ? files : (await fs.readdir(dropFolder)).filter((name) => !name.startsWith(".")).map((name) => path.join(dropFolder, name));
  for (const file of list) {
    try {
      const result = await deps.importService.upload(tenant, datasource, { filename: path.basename(file), contentBase64: (await fs.readFile(file)).toString("base64") });
      console.log(`${path.basename(file)}: ${result.status}, ${result.added ?? 0} added, ${result.alreadyPresent ?? 0} already present${result.rejectedCount ? `, ${result.rejectedCount} rows rejected` : ""}`);
    } catch (error) { console.error(`${path.basename(file)}: ${error.code || "ERROR"} ${error.message}${error.data?.candidates ? ` (${error.data.candidates.map((item) => item.id).join(", ") || "none"})` : ""}`); process.exitCode = 1; }
  }
} else if (command === "analyse" || command === "analyze") {
  const project = rest[0] || await deps.workspaceService.activeProject(tenant, user.email);
  await runJob(project, "analysis", {});
  const meta = await deps.analysisService.meta(tenant, project);
  if (meta) for (const account of meta.accounts) console.log(`  ${account.id}: ${account.count} transactions, total ${account.running}`);
} else if (command === "forecast") {
  const [first, second] = rest;
  const project = second ? first : await deps.workspaceService.activeProject(tenant, user.email);
  const forecast = second || first;
  if (!forecast) { console.error("usage: cli.mjs forecast <tenant> [project] <forecast>"); process.exit(2); }
  await runJob(project, "forecast", { forecast });
  const meta = await deps.forecastService.meta(tenant, project, forecast);
  if (meta) console.log(`  ${meta.start} to ${meta.end}, ${meta.periods} periods at ${meta.frequency}`);
} else { console.error(`unknown command ${command}`); process.exitCode = 2; }
