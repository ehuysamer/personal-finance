const defaults = {
  env: "dev",
  region: "ap-southeast-2",
  bucket: "personalfinance-dev-20261108",
  leaseTable: "personalfinance-dev-lease",
  port: 4200,
  // Everyone else is refused even with a valid pool login.
  allowedEmails: ["ehuysamer@gmail.com"],
  localUserEmail: "ehuysamer@gmail.com",
  maxUploadBytes: 10 * 1024 * 1024,
  maxRowsPerFile: 200000,
  // Long-running jobs (analysis, forecasts): a worker saves and re-invokes itself when less than
  // jobSafetyMs of its time is left; a job past maxJobMs or maxJobInvocations stops with ERR-JOB-LIMIT.
  maxJobMs: 30 * 60 * 1000,
  maxJobInvocations: 20,
  jobSafetyMs: 60 * 1000,
  localJobSliceMs: 5 * 60 * 1000,
  maxForecastYears: 100,
  maxForecastPoints: 2000000
};

function list(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }

export default function getConfig(overrides = {}) {
  const env = process.env;
  return {
    ...defaults,
    env: env.PERSONALFINANCE_ENV || defaults.env,
    region: env.PERSONALFINANCE_REGION || env.AWS_REGION || defaults.region,
    bucket: env.PERSONALFINANCE_BUCKET || defaults.bucket,
    leaseTable: env.PERSONALFINANCE_LEASE_TABLE || defaults.leaseTable,
    port: Number(env.PERSONALFINANCE_PORT || env.PORT || defaults.port),
    allowedEmails: env.PERSONALFINANCE_ALLOWED_EMAILS ? list(env.PERSONALFINANCE_ALLOWED_EMAILS).map((email) => email.toLowerCase()) : defaults.allowedEmails,
    cognitoUserPoolId: env.PERSONALFINANCE_COGNITO_USER_POOL_ID || "",
    cognitoClientIds: list(env.PERSONALFINANCE_COGNITO_CLIENT_IDS),
    cognitoDomain: env.PERSONALFINANCE_COGNITO_DOMAIN || "",
    // The API's own app client for the MCP sign-in (callback /oauth/callback).
    mcpCognitoClientId: env.PERSONALFINANCE_MCP_COGNITO_CLIENT_ID || "",
    // "tenant|key" lines (or comma-separated): REST callers with that key act in that tenant only.
    apiKeys: String(env.PERSONALFINANCE_API_KEYS || "").split(/[\n,]/).map((line) => line.trim()).filter(Boolean).map((line) => { const [tenant, ...key] = line.split("|"); return { tenant, key: key.join("|") }; }).filter((entry) => entry.tenant && entry.key),
    mcpSigningSecret: env.PERSONALFINANCE_MCP_SIGNING_SECRET || "",
    mcpAllowedOrigins: list(env.MCP_ALLOWED_ORIGINS),
    localAuth: env.PERSONALFINANCE_LOCAL_AUTH === "true",
    localUserEmail: env.PERSONALFINANCE_LOCAL_USER || defaults.localUserEmail,
    useMemoryStore: env.PERSONALFINANCE_USE_MEMORY_STORE === "true",
    localDataDirectory: env.PERSONALFINANCE_LOCAL_DATA_DIR || "",
    workerFunctionName: env.PERSONALFINANCE_WORKER_FUNCTION_NAME || "",
    webOrigins: list(env.PERSONALFINANCE_WEB_ORIGINS),
    ...overrides
  };
}
