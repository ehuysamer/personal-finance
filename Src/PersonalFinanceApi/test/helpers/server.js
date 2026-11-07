import { createServer } from "node:http";
import { MemoryObjectStore } from "../../src/lib/objectStore.js";
import { buildDependencies, createInlineDispatcher } from "../../src/index.js";
import { createApp } from "../../src/app.js";

// An API on a random port with the memory store, signed in as the local owner; jobs run when drain() is called.
export async function startTestApi(config = {}) {
  const dispatcher = createInlineDispatcher();
  const deps = buildDependencies({ store: new MemoryObjectStore(), dispatcher, config: { localAuth: true, useMemoryStore: true, localUserEmail: "owner@example.com", allowedEmails: ["owner@example.com"], ...config } });
  const server = createServer(createApp(deps));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, body) {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function drain() {
    while (dispatcher.queue.length) await deps.jobService.work(dispatcher.queue.shift(), { remainingMs: () => 10 * 60 * 1000 });
  }
  return { deps, base, call, drain, close: () => new Promise((resolve) => server.close(resolve)) };
}
