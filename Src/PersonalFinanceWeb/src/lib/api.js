// The API client: every call carries the user's ID token (none locally, where the API signs in the local owner).
// Errors come back as Error with code, status and data from the API's { code, message, data }.
export function createApi(config, auth, fetchImpl = (...args) => fetch(...args)) {
  const base = String(config.apiUrl || "").replace(/\/$/, "");
  async function request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (!config.local) headers.Authorization = `Bearer ${await auth.idToken()}`;
    const response = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
    if (!response.ok) {
      const error = new Error(payload?.message || `${response.status} ${response.statusText}`);
      Object.assign(error, { status: response.status, code: payload?.code, data: payload?.data });
      throw error;
    }
    return payload;
  }
  const query = (params = {}) => {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
    return entries.length ? `?${new URLSearchParams(entries)}` : "";
  };
  return {
    get: (path, params) => request("GET", `${path}${query(params)}`),
    post: (path, body) => request("POST", path, body ?? {}),
    put: (path, body) => request("PUT", path, body ?? {}),
    del: (path, params) => request("DELETE", `${path}${query(params)}`)
  };
}

// Files as base64 for uploads.
export function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
