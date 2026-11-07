import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import HttpError from "../models/httpError.model.js";
import { authenticate, signMcpToken } from "../services/auth.service.js";

// OAuth 2.1 for MCP clients, delegated to Cognito: the client registers (stateless: its client_id is a signed list
// of its redirect URIs), /oauth/authorize sends the user to the Cognito hosted sign-in, /oauth/callback takes the
// Cognito code, checks the user is allowed and hands the client a short-lived signed code, which /oauth/token
// swaps (with PKCE S256) for an access token (1 hour) and a refresh token (30 days). Codes are signed, not stored,
// so a code can be replayed within its 5 minutes; acceptable for this single-user system, noted in the doc.
const CODE_TTL = 300;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 3600;

function seal(payload, secret) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`; }
function unseal(value, secret, type) {
  const [body, signature] = String(value || "").split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try { const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); return payload.type === type && (!payload.exp || payload.exp * 1000 > Date.now()) ? payload : null; } catch { return null; }
}
const now = () => Math.floor(Date.now() / 1000);
function secretOf(config) { if (!config.mcpSigningSecret) throw new HttpError(500, "ERR-OAUTH-CONFIG", "MCP sign-in is not configured"); return config.mcpSigningSecret; }
export function baseUrl(request) {
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = request.headers["x-forwarded-proto"] || (String(host).startsWith("localhost") || String(host).startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}

export function protectedResource(request) { const base = baseUrl(request); return { resource: `${base}/v1/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] }; }
export function authorizationServer(request) {
  const base = baseUrl(request);
  return { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["finance"] };
}

export function register(body, config) {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.some((uri) => !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(uri))) throw new HttpError(400, "invalid_redirect_uri", "redirect_uris must be https (or localhost)");
  return { client_id: seal({ type: "client", uris }, secretOf(config)), client_name: body.client_name || "MCP client", redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
}

export function authorize(request, config) {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = request.query;
  const client = unseal(client_id, secretOf(config), "client");
  if (!client || !client.uris.includes(redirect_uri)) throw new HttpError(400, "invalid_client", "unknown client or redirect_uri");
  if (!code_challenge || code_challenge_method !== "S256") throw new HttpError(400, "invalid_request", "PKCE with S256 is required");
  if (!config.cognitoDomain || !config.mcpCognitoClientId) throw new HttpError(500, "ERR-OAUTH-CONFIG", "Cognito sign-in for MCP is not configured");
  const pending = seal({ type: "pending", redirect_uri, state: state || "", code_challenge, exp: now() + 900 }, config.mcpSigningSecret);
  const target = new URL(`https://${config.cognitoDomain}/oauth2/authorize`);
  target.search = new URLSearchParams({ client_id: config.mcpCognitoClientId, response_type: "code", scope: "openid email", redirect_uri: `${baseUrl(request)}/oauth/callback`, state: pending }).toString();
  return target.toString();
}

export async function callback(request, config, { fetchImpl = fetch, verifier } = {}) {
  const pending = unseal(request.query.state, secretOf(config), "pending");
  if (!pending) throw new HttpError(400, "invalid_request", "the sign-in took too long or is invalid; start again");
  const response = await fetchImpl(`https://${config.cognitoDomain}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.mcpCognitoClientId, code: String(request.query.code || ""), redirect_uri: `${baseUrl(request)}/oauth/callback` }) });
  if (!response.ok) throw new HttpError(401, "access_denied", "Cognito sign-in failed");
  const tokens = await response.json();
  const user = await authenticate({ authorization: `Bearer ${tokens.id_token}` }, { ...config, localAuth: false }, { verifier });
  const code = seal({ type: "code", email: user.email, redirect_uri: pending.redirect_uri, code_challenge: pending.code_challenge, exp: now() + CODE_TTL }, config.mcpSigningSecret);
  const target = new URL(pending.redirect_uri);
  target.searchParams.set("code", code);
  if (pending.state) target.searchParams.set("state", pending.state);
  return target.toString();
}

function issue(email, config) {
  return { access_token: signMcpToken({ email, exp: now() + ACCESS_TTL }, config.mcpSigningSecret), token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: seal({ type: "refresh", email, exp: now() + REFRESH_TTL }, config.mcpSigningSecret) };
}

export function token(body, config) {
  const secret = secretOf(config);
  if (body.grant_type === "authorization_code") {
    const code = unseal(body.code, secret, "code");
    if (!code || code.redirect_uri !== body.redirect_uri) throw new HttpError(400, "invalid_grant", "the code is invalid or expired");
    const challenge = createHash("sha256").update(String(body.code_verifier || "")).digest("base64url");
    if (challenge !== code.code_challenge) throw new HttpError(400, "invalid_grant", "code_verifier does not match");
    if (!config.allowedEmails.includes(code.email)) throw new HttpError(400, "invalid_grant", "this account does not have access");
    return issue(code.email, config);
  }
  if (body.grant_type === "refresh_token") {
    const refresh = unseal(body.refresh_token, secret, "refresh");
    if (!refresh || !config.allowedEmails.includes(refresh.email)) throw new HttpError(400, "invalid_grant", "the refresh token is invalid or expired");
    return issue(refresh.email, config);
  }
  throw new HttpError(400, "unsupported_grant_type", "grant_type is authorization_code or refresh_token");
}
