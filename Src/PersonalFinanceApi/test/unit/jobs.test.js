import test from "node:test";
import assert from "node:assert/strict";
import { MemoryObjectStore } from "../../src/lib/objectStore.js";
import { MemoryLeaseService } from "../../src/services/lease.service.js";
import createJobService, { createInlineDispatcher } from "../../src/services/job.service.js";

function setup({ steps = 3, config = {} } = {}) {
  const dispatcher = createInlineDispatcher();
  const handlers = { count: { async plan(job) { job.state = { n: 0 }; }, async step(job) { job.state.n += 1; return job.state.n >= steps; } } };
  const jobs = createJobService({ store: new MemoryObjectStore(), leases: new MemoryLeaseService(), dispatcher, handlers, config: { maxJobMs: 60000, maxJobInvocations: 3, jobSafetyMs: 1000, ...config } });
  return { jobs, dispatcher };
}

test("a job stops before the time runs out and carries on in the next invocation", async () => {
  const { jobs, dispatcher } = setup({ steps: 3 });
  const started = await jobs.start("t", "p", "count");
  let left = 2;
  // Each invocation has time for exactly one step: remaining time drops below the safety margin after it.
  const slice = () => { left = 2; return { remainingMs: () => (left-- > 1 ? 5000 : 0) }; };
  await jobs.work(dispatcher.queue.shift(), slice());
  assert.equal((await jobs.get("t", "p", started.id)).state.n, 1);
  assert.equal(dispatcher.queue.length, 1, "dispatched again");
  await jobs.work(dispatcher.queue.shift(), slice());
  const done = await jobs.work(dispatcher.queue.shift(), slice());
  assert.equal(done.status, "complete");
  assert.equal(done.invocations, 3);
  await jobs.start("t", "p", "count");
});

test("one job per project; a job past its invocation limit fails with ERR-JOB-LIMIT and frees the project", async () => {
  const { jobs, dispatcher } = setup({ steps: 100, config: { maxJobInvocations: 2 } });
  const started = await jobs.start("t", "p", "count");
  await assert.rejects(jobs.start("t", "p", "count"), { code: "ERR-JOB-RUNNING" });
  const short = { remainingMs: (() => { let calls = 0; return () => (calls++ % 2 === 0 ? 5000 : 0); })() };
  while (dispatcher.queue.length) await jobs.work(dispatcher.queue.shift(), short);
  const job = await jobs.get("t", "p", started.id);
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "ERR-JOB-LIMIT");
  await jobs.start("t", "p", "count");
});

test("a cancelled job stops at its next step", async () => {
  const { jobs, dispatcher } = setup({ steps: 100 });
  const started = await jobs.start("t", "p", "count");
  await jobs.cancel("t", "p", started.id);
  const job = await jobs.work(dispatcher.queue.shift(), { remainingMs: () => 5000 });
  assert.equal(job.status, "cancelled");
});
