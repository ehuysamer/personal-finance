import express from "express";
import { randomUUID } from "node:crypto";
import HttpError from "./models/httpError.model.js";
import { authenticate } from "./services/auth.service.js";
import { operations, pathParams, runOperation } from "./handlers/operations.handler.js";
import createMcpService from "./services/mcp.service.js";
import { authorizationServer, authorize, callback, protectedResource, register, token } from "./handlers/oauth.handler.js";

function sendError(res, error, requestId) {
  const known = error instanceof HttpError;
  if (known && error.headers) res.set(error.headers);
  res.status(known ? error.statusCode : 500).json({ code: known ? error.code : "ERR-UNEXPECTED", message: known ? error.message : "Unexpected error", requestId, data: known ? error.data : undefined });
}

export function createApp(deps) {
  const { config } = deps;
  const app = express();
  app.disable("x-powered-by");
  // Uploads are base64 in JSON: a 10 MB file is about 13.4 MB of text. (On Lambda a request is at most 6 MB, so
  // larger files use presigned uploads; this limit matters locally.)
  app.use(express.json({ limit: Math.ceil(Math.max(config.maxUploadBytes, config.maxDocumentBytes) * 1.4) + 65536 }));
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    // The web is on its own host (CloudFront) and calls the API directly.
    const origin = req.headers.origin;
    if (origin && (config.webOrigins.includes(origin) || (config.localAuth && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)))) {
      res.set({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Api-Key, MCP-Protocol-Version, MCP-Session-Id", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Max-Age": "600", Vary: "Origin" });
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  const user = (req) => authenticate(req.headers, config, { tenantDirectory: deps.tenantDirectory, verifier: deps.verifier });

  app.get("/v1/status", (req, res) => res.json({ status: "ok", version: "v1", environment: config.env, store: config.localDataDirectory ? "local" : config.useMemoryStore ? "memory" : "s3", ...(config.deployment || {}) }));

  // OAuth for MCP clients.
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/v1/mcp"], (req, res) => res.json(protectedResource(req)));
  app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(authorizationServer(req)));
  const oauthError = (res, error) => res.status(error.statusCode || 500).json({ error: error.code || "server_error", error_description: error.message });
  app.post("/oauth/register", (req, res) => { try { res.status(201).json(register(req.body, config)); } catch (error) { oauthError(res, error); } });
  app.get("/oauth/authorize", (req, res) => { try { res.redirect(302, authorize(req, config)); } catch (error) { oauthError(res, error); } });
  app.get("/oauth/callback", async (req, res) => { try { res.redirect(302, await callback(req, config, { verifier: deps.verifier })); } catch (error) { oauthError(res, error); } });
  app.post("/oauth/token", express.urlencoded({ extended: false }), (req, res) => { try { res.json(token(req.body || {}, config)); } catch (error) { oauthError(res, error); } });

  // MCP (streamable HTTP, JSON responses only).
  const mcp = createMcpService(deps);
  app.get("/v1/mcp", (req, res) => res.status(405).set("Allow", "POST, DELETE").json({ message: "GET streams are not supported; POST JSON-RPC messages" }));
  app.delete("/v1/mcp", (req, res) => res.status(204).end());
  app.post("/v1/mcp", async (req, res, next) => {
    try {
      const caller = await user(req);
      const { responses, batch, session } = await mcp.handlePayload(req.body, caller);
      if (session) res.set("MCP-Session-Id", session);
      if (!responses.length) return res.status(202).end();
      res.json(batch ? responses : responses[0]);
    } catch (error) { next(error); }
  });

  // REST: one route per operation; path parameters, then the query (GET, DELETE) or the body.
  for (const operation of operations) {
    app[operation.method](operation.path, async (req, res, next) => {
      try {
        const caller = await user(req);
        const params = Object.fromEntries(pathParams(operation.path).map((name) => [name, req.params[name]]));
        const input = operation.method === "get" || operation.method === "delete" ? req.query : (req.body || {});
        const result = await runOperation(operation, caller, { ...input, ...params }, deps);
        res.status(operation.status || 200).json(result ?? null);
      } catch (error) { next(error); }
    });
  }
  app.use((req, res) => sendError(res, new HttpError(404, "ERR-NOT-FOUND", `${req.method} ${req.path} is not a route`), req.requestId));
  app.use((error, req, res, _next) => {
    const refused = error instanceof HttpError && error.statusCode < 500;
    if (error.type === "entity.too.large") return sendError(res, new HttpError(413, "ERR-TOO-LARGE", "the request is too large"), req.requestId);
    (refused ? console.warn : console.error)(JSON.stringify({ event: refused ? "request.refused" : "request.error", requestId: req.requestId, path: req.path, code: error.code || "ERR-UNEXPECTED", message: error.message, ...(refused ? {} : { stack: error.stack }) }));
    sendError(res, error, req.requestId);
  });
  return app;
}
