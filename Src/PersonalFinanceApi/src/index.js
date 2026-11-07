import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import serverlessExpress from "@codegenie/serverless-express";
import getConfig from "./config/index.js";
import { createApp } from "./app.js";
import S3ObjectStore from "./dal/s3ObjectStore.js";
import FileObjectStore from "./dal/fileObjectStore.js";
import { MemoryObjectStore } from "./lib/objectStore.js";
import { MemoryLeaseService } from "./services/lease.service.js";
import DynamoLeaseService from "./services/dynamoLease.service.js";
import createIndexService from "./services/index.service.js";
import createTenantDirectory from "./services/tenantDirectory.service.js";
import createWorkspaceService from "./services/workspace.service.js";
import createImportService from "./services/import.service.js";
import createProjectService from "./services/project.service.js";
import createResultsService from "./services/results.service.js";
import createAnalysisService from "./services/analysis.service.js";
import createForecastService from "./services/forecast.service.js";
import createChartService from "./services/chart.service.js";
import createJobService, { createInlineDispatcher, createLambdaDispatcher, createLocalDispatcher } from "./services/job.service.js";

// Everything is wired here; overrides let tests and the command line swap the store, leases, clock or dispatcher.
// Locally (offline) the store is the data/ folder, leases are in memory and jobs run in-process.
export function buildDependencies(overrides = {}) {
  const config = getConfig(overrides.config);
  const clock = overrides.clock || (() => new Date());
  const store = overrides.store || (config.localDataDirectory ? new FileObjectStore({ directory: config.localDataDirectory }) : config.useMemoryStore ? new MemoryObjectStore() : new S3ObjectStore(config));
  const local = Boolean(config.localDataDirectory || config.useMemoryStore);
  const leases = overrides.leases || (local ? new MemoryLeaseService() : new DynamoLeaseService({ tableName: config.leaseTable, region: config.region }));
  const indexService = createIndexService({ store, clock });
  const tenantDirectory = createTenantDirectory({ store, indexService, config, clock });
  const workspaceService = createWorkspaceService({ store, indexService, clock });
  const importService = createImportService({ store, indexService, workspaceService, config, clock });
  const projectService = createProjectService({ store, indexService, workspaceService, clock });
  const resultsService = createResultsService({ store });
  const analysisService = createAnalysisService({ store, workspaceService, importService, projectService, resultsService, clock });
  const forecastService = createForecastService({ store, indexService, workspaceService, projectService, resultsService, config, clock });
  const chartService = createChartService({ workspaceService, projectService, resultsService, forecastService });
  let jobService;
  const dispatcher = overrides.dispatcher || (config.workerFunctionName ? createLambdaDispatcher({ functionName: config.workerFunctionName, region: config.region }) : createLocalDispatcher(() => jobService, config));
  jobService = createJobService({ store, leases, config, clock, dispatcher, handlers: { analysis: analysisService.handler, forecast: forecastService.handler } });
  return { config, store, leases, clock, indexService, tenantDirectory, workspaceService, importService, projectService, resultsService, analysisService, forecastService, chartService, jobService, dispatcher, verifier: overrides.verifier };
}

export { createInlineDispatcher };

export async function startLocalServer(overrides = {}) {
  const deps = buildDependencies(overrides);
  const server = createServer(createApp(deps));
  // Offline mode signs everyone in as the local owner, so it only listens on this machine.
  await new Promise((resolve) => server.listen(overrides.port ?? deps.config.port, deps.config.localAuth ? "127.0.0.1" : undefined, resolve));
  return server;
}

let api;
let deps;
// One Lambda for the API and the job worker: an event { job } is a worker invocation (from an async invoke),
// anything else is an API Gateway request.
export async function handler(event, context) {
  deps ||= buildDependencies();
  if (event?.job) {
    const result = await deps.jobService.work(event.job, { remainingMs: () => context.getRemainingTimeInMillis() });
    console.log(JSON.stringify({ event: "job.slice", ...event.job, status: result.status, steps: result.steps, invocations: result.invocations }));
    return { status: result.status };
  }
  api ||= serverlessExpress({ app: createApp(deps) });
  return await api(event, context);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const portIndex = process.argv.indexOf("--port");
  startLocalServer(portIndex > 0 ? { port: Number(process.argv[portIndex + 1]) } : {}).then((server) => console.log(`Personal finance API listening on ${JSON.stringify(server.address())}`)).catch((error) => { console.error(error); process.exitCode = 1; });
}
