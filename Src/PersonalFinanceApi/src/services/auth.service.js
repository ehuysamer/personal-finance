import { createHmac, timingSafeEqual } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import HttpError from "../models/httpError.model.js";

function header(headers, name) { return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1]; }
function bearer(headers) {
  const value = String(header(headers, "authorization") || "").trim();
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}
function equals(a, b) { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); }

let cached;
function verifierFor(config) {
  const signature = `${config.cognitoUserPoolId}|${config.cognitoClientIds.join(",")}`;
  if (cached?.signature !== signature) cached = { signature, verifier: CognitoJwtVerifier.create({ userPoolId: config.cognitoUserPoolId, clientId: config.cognitoClientIds, tokenUse: "id" }) };
  return cached.verifier;
}

// MCP access tokens are issued by this API's OAuth endpoints after a Cognito sign-in: HMAC-signed { email, exp }.
export function signMcpToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `pf.${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function verifyMcpToken(token, secret, now = Date.now()) {
  const [prefix, body, signature] = String(token || "").split(".");
  if (prefix !== "pf" || !body || !signature || !secret || !equals(createHmac("sha256", secret).update(body).digest("base64url"), signature)) return null;
  try { const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return payload.exp * 1000 > now ? payload : null; } catch { return null; }
}

// The caller: a Cognito ID token from the shared pool (web), an MCP token (MCP clients), a per-tenant API key
// (scripts), or the local owner when local auth is on. Only allow-listed emails get in.
export async function authenticate(headers, config, { verifier, tenantDirectory } = {}) {
  const allowed = (email) => tenantDirectory?.isAllowed(email) ?? config.allowedEmails.includes(email);
  if (config.localAuth) {
    if (!allowed(String(config.localUserEmail).toLowerCase())) throw new HttpError(403, "ERR-AUTH-FORBIDDEN", "this account does not have access");
    return { email: String(config.localUserEmail).toLowerCase(), source: "local" };
  }
  const apiKey = header(headers, "x-api-key");
  if (apiKey) {
    const entry = config.apiKeys.find((candidate) => equals(candidate.key, apiKey));
    if (!entry) throw new HttpError(401, "ERR-AUTH-INVALID", "API key is invalid");
    return { email: `api-key@${entry.tenant}`, tenant: entry.tenant, source: "api-key" };
  }
  const token = bearer(headers);
  if (!token) throw new HttpError(401, "ERR-AUTH-MISSING", "Authorization header is required");
  let user;
  if (token.startsWith("pf.")) {
    const payload = verifyMcpToken(token, config.mcpSigningSecret);
    if (!payload) throw new HttpError(401, "ERR-AUTH-INVALID", "token is invalid or expired", undefined, { "WWW-Authenticate": "Bearer resource_metadata=\"/.well-known/oauth-protected-resource\"" });
    user = { email: payload.email, source: "mcp" };
  } else {
    if (!config.cognitoUserPoolId || !config.cognitoClientIds.length) throw new HttpError(500, "ERR-AUTH-CONFIG", "Cognito is not configured");
    let payload;
    try { payload = await (verifier || verifierFor(config)).verify(token); }
    catch (error) { throw new HttpError(401, /expired/i.test(error?.message || "") ? "ERR-AUTH-TOKEN-EXPIRED" : "ERR-AUTH-INVALID", "sign-in token is invalid or expired"); }
    user = { email: String(payload.email || "").toLowerCase(), sub: payload.sub, source: "cognito" };
  }
  if (!allowed(user.email)) throw new HttpError(403, "ERR-AUTH-FORBIDDEN", "this account does not have access");
  return user;
}
