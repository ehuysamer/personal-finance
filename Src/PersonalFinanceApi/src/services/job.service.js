import { randomUUID } from "node:crypto";
import HttpError from "../models/httpError.model.js";
import { keys } from "../lib/keys.js";
import { getJson, putJson, updateJson } from "../lib/json.js";

// Long-running work (analysis, forecasts) runs as a job: POST answers at once with the job id; a worker does the
// job's steps and saves its state after each one. When less than jobSafetyMs of the worker's time is left it stops
// and dispatches the job again (Lambda: an async invoke of the worker; locally: the next tick), so no step is cut
// off by a Lambda timeout. Limits: maxJobMs from the start and maxJobInvocations; past either the job fails with
// ERR-JOB-LIMIT. One job per project at a time (a lease).
//
// A handler: { plan(job, ctx) -> sets job.state / job.progress, step(job, ctx) -> true when finished }.
const FINISHED = ["complete", "failed", "cancelled"];

export default function createJobService({ store, leases, config, clock = () => new Date(), handlers = {}, dispatcher }) {
  const indexKey = (tenant, project) => `${tenant}/${project}/jobs/$index.json`;
  const summary = (job) => ({ id: job.id, type: job.type, name: job.params?.forecast || undefined, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt || null, error: job.error || undefined });

  async function save(job) {
    // A cancel written by another request while a step ran is kept.
    const stored = await getJson(store, keys.job(job.tenant, job.project, job.id), null);
    if (stored?.cancelRequested) job.cancelRequested = true;
    await putJson(store, keys.job(job.tenant, job.project, job.id), job);
    await updateJson(store, indexKey(job.tenant, job.project), (index) => ({ items: [summary(job), ...index.items.filter((item) => item.id !== job.id)].slice(0, 50) }), { items: [] });
    return job;
  }
  async function get(tenant, project, jobId) {
    try { return await getJson(store, keys.job(tenant, project, jobId)); }
    catch (error) { if (error.statusCode === 404) throw new HttpError(404, "ERR-NOT-FOUND", `job ${jobId} was not found`); throw error; }
  }
  async function list(tenant, project) { return (await getJson(store, indexKey(tenant, project), { items: [] })).items; }

  async function start(tenant, project, type, params = {}, user = {}) {
    const handler = handlers[type];
    if (!handler) throw new HttpError(400, "ERR-JOB-TYPE", `unknown job type ${type}`);
    const lease = await leases.acquire(`${tenant}/${project}`, config.maxJobMs + 5 * 60 * 1000);
    const now = clock();
    const job = { id: `${now.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`, tenant, project, type, params, status: "queued", lease, startedAt: now.toISOString(), deadline: new Date(now.getTime() + config.maxJobMs).toISOString(), invocations: 0, steps: 0, state: {}, progress: { message: "queued" }, createdBy: user.email || null };
    try {
      await handler.plan(job, context(job));
      await save(job);
      await dispatcher.dispatch({ tenant, project, jobId: job.id });
    } catch (error) {
      await leases.release(lease);
      throw error;
    }
    return summary(job);
  }

  function context(job) {
    return { workKey: (name) => keys.jobWork(job.tenant, job.project, job.id, name), progress: (message, done, total) => { job.progress = { message, done, total }; } };
  }

  async function finish(job, status, extra = {}) {
    Object.assign(job, { status, finishedAt: clock().toISOString(), ...extra });
    await save(job);
    await leases.release(job.lease);
    // Intermediate files of the job are removed when it ends.
    for (const key of await store.list(`${job.tenant}/${job.project}/jobs/${job.id}/`)) await store.delete(key);
    return job;
  }

  // One worker invocation: steps until the job is done or time is short. remainingMs() is the time left.
  async function work({ tenant, project, jobId }, { remainingMs }) {
    let job = await get(tenant, project, jobId);
    if (FINISHED.includes(job.status)) return job;
    const handler = handlers[job.type];
    job.invocations += 1;
    if (job.invocations > config.maxJobInvocations || clock() > new Date(job.deadline)) return await finish(job, "failed", { error: { code: "ERR-JOB-LIMIT", message: `the job ran past its limit (${Math.round(config.maxJobMs / 60000)} minutes, ${config.maxJobInvocations} invocations); results so far are incomplete` } });
    job.status = "running";
    await save(job);
    try {
      while (remainingMs() > config.jobSafetyMs) {
        const latest = await get(tenant, project, jobId);
        if (latest.cancelRequested) return await finish(job, "cancelled");
        if (clock() > new Date(job.deadline)) return await finish(job, "failed", { error: { code: "ERR-JOB-LIMIT", message: "the job ran past its time limit; results so far are incomplete" } });
        const done = await handler.step(job, context(job));
        job.steps += 1;
        if (done) return await finish(job, "complete");
        await save(job);
      }
    } catch (error) {
      return await finish(job, "failed", { error: { code: error.code || "ERR-JOB", message: error.message } });
    }
    await save(job);
    await dispatcher.dispatch({ tenant, project, jobId });
    return job;
  }

  async function cancel(tenant, project, jobId) {
    const job = await get(tenant, project, jobId);
    if (FINISHED.includes(job.status)) return summary(job);
    job.cancelRequested = true;
    await save(job);
    return summary(job);
  }

  // Lets a project's lease go when its job died without finishing (e.g. a worker that crashed).
  async function running(tenant, project) { return (await list(tenant, project)).find((item) => !FINISHED.includes(item.status)) || null; }

  return { start, work, get, list, cancel, running, summary };
}

// Dispatchers: where the next slice of a job runs.
export function createLocalDispatcher(getJobService, config) {
  return {
    async dispatch(ref) {
      setImmediate(() => {
        const end = Date.now() + config.localJobSliceMs;
        getJobService().work(ref, { remainingMs: () => end - Date.now() }).catch((error) => console.error(JSON.stringify({ event: "job.error", ...ref, message: error.message })));
      });
    }
  };
}

// The command line runs every slice itself, one after the other, until the job ends.
export function createInlineDispatcher() {
  const queue = [];
  return { queue, async dispatch(ref) { queue.push(ref); } };
}

export function createLambdaDispatcher({ functionName, region }) {
  let client;
  return {
    async dispatch(ref) {
      const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
      client ||= new LambdaClient({ region });
      await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ job: ref })) }));
    }
  };
}
