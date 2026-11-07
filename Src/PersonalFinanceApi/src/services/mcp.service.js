import { randomUUID } from "node:crypto";
import HttpError from "../models/httpError.model.js";
import { operations, runOperation, toolSchema } from "../handlers/operations.handler.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const INSTRUCTIONS = "Personal finance: import bank statements into datasources (importsources map file columns onto date, account, description, amount), put transactions into a project's accounts with rules, analyse them (running totals, monthly/quarterly/yearly aggregates), chart them and forecast them. Call me first for the tenants; project tools use the active project when project is left out. analysis_run and forecast_run start jobs: poll job_get until complete.";

// MCP over JSON-RPC: one tool per operation (operations.handler.js), run as the signed-in user.
export default function createMcpService(deps) {
  const tools = operations.map((operation) => ({ name: operation.name, description: operation.description, inputSchema: toolSchema(operation) }));
  const byName = new Map(operations.map((operation) => [operation.name, operation]));

  async function handle(message, user) {
    const { id, method, params } = message || {};
    if (id === undefined || id === null) return null;
    try {
      if (method === "initialize") {
        const requested = params?.protocolVersion;
        return { jsonrpc: "2.0", id, result: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "personal-finance", version: "0.1.0" }, instructions: INSTRUCTIONS } };
      }
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
      if (method === "tools/call") {
        const operation = byName.get(params?.name);
        if (!operation) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
        try {
          const result = await runOperation(operation, user, params.arguments || {}, deps);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }], structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { result } } };
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ code: error.code, message: error.message, data: error.data }) }] } };
        }
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method ${method} is not supported` } };
    } catch (error) {
      console.error(JSON.stringify({ event: "mcp.error", method, message: error.message, stack: error.stack }));
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } };
    }
  }

  async function handlePayload(body, user) {
    const batch = Array.isArray(body);
    const responses = (await Promise.all((batch ? body : [body]).map((message) => handle(message, user)))).filter(Boolean);
    return { responses, batch, session: !batch && body?.method === "initialize" ? randomUUID() : null };
  }
  return { tools, handlePayload };
}
