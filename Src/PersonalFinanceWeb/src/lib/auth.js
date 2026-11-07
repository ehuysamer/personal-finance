// Sign-in with the shared admin pool's hosted login: the authorization code flow with PKCE, exchanged in the browser
// (a public client, no secret). This keeps the ID token: the API reads the
// email from it. Tokens are kept on the device (localStorage, so a phone stays signed in); the refresh
// token renews them for 30 days.
const STORE = "personalFinanceAuth";

export function base64Url(bytes) {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair(randomBytes = (size) => crypto.getRandomValues(new Uint8Array(size)), digest = (data) => crypto.subtle.digest("SHA-256", data)) {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(await digest(new TextEncoder().encode(verifier))) };
}

// The claims of a JWT (not verified here: the API verifies the token).
export function claims(token) {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

export function createAuth(config, { storage = localStorage, fetchImpl = (...args) => fetch(...args), location = window.location } = {}) {
  const redirectUri = `${location.origin}/`;
  const read = () => {
    try { return JSON.parse(storage.getItem(STORE) || "null"); } catch { return null; }
  };
  const save = (tokens) => storage.setItem(STORE, JSON.stringify(tokens));
  async function token(body) {
    const response = await fetchImpl(`https://${config.cognitoDomain}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, ...body }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error_description || payload.error || "Sign-in failed");
    return payload;
  }
  return {
    signedIn: () => Boolean(read()?.idToken),
    username: () => claims(read()?.idToken || "")["cognito:username"] || "",
    async start() {
      const { verifier, challenge } = await pkcePair();
      const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
      storage.setItem(`${STORE}:pkce`, JSON.stringify({ verifier, state, back: `${location.pathname}${location.search}` }));
      const query = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: "openid email profile", code_challenge: challenge, code_challenge_method: "S256", state });
      location.assign(`https://${config.cognitoDomain}/login?${query}`);
    },
    // Back from the hosted login with ?code=&state=: exchange the code. Returns where to go back to, or null.
    async complete(search = location.search) {
      const query = new URLSearchParams(search);
      if (!query.get("code")) return null;
      const pending = JSON.parse(storage.getItem(`${STORE}:pkce`) || "null");
      storage.removeItem(`${STORE}:pkce`);
      if (!pending || pending.state !== query.get("state")) throw new Error("The sign-in did not match this browser tab; try again");
      const tokens = await token({ grant_type: "authorization_code", code: query.get("code"), redirect_uri: redirectUri, code_verifier: pending.verifier });
      save({ idToken: tokens.id_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 });
      return /^\/(\?|$)/.test(pending.back || "/") ? pending.back : "/";
    },
    // A current ID token, renewed with the refresh token when it is about to expire.
    async idToken() {
      const tokens = read();
      if (!tokens) throw new Error("Sign in first");
      if (Date.now() < tokens.expiresAt - 60000) return tokens.idToken;
      if (!tokens.refreshToken) throw new Error("Your sign-in has expired: sign in again");
      const renewed = await token({ grant_type: "refresh_token", refresh_token: tokens.refreshToken });
      save({ ...tokens, idToken: renewed.id_token, expiresAt: Date.now() + renewed.expires_in * 1000 });
      return renewed.id_token;
    },
    signOut() {
      storage.removeItem(STORE);
      location.assign(`https://${config.cognitoDomain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri })}`);
    },
  };
}
