import { reactive } from "vue";

// App-wide state: the signed-in user, the tenant and the active project, and the current view (from the hash:
// #/import, #/import/{datasource}, #/accounts, #/analysis, #/forecast/{id}, ...).
export const state = reactive({
  ready: false,
  error: "",
  email: "",
  tenants: [],
  tenant: null,
  workspace: { items: [], activeProject: null },
  route: { section: "import", parts: [] },
  toast: ""
});

export function parseRoute(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const section = ["import", "accounts", "analysis", "forecast", "settings"].includes(parts[0]) ? parts[0] : "import";
  return { section, parts: parts.slice(1) };
}
export function go(section, ...parts) { location.hash = `#/${[section, ...parts].map(encodeURIComponent).join("/")}`; }

let toastTimer;
export function toast(message) { state.toast = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { state.toast = ""; }, 3500); }

export const projects = () => state.workspace.items.filter((item) => item.kind === "project");
export const datasources = () => state.workspace.items.filter((item) => item.kind === "datasource");
export const tenantPath = () => `/v1/tenants/${encodeURIComponent(state.tenant)}`;
export const projectPath = () => `${tenantPath()}/projects/${encodeURIComponent(state.workspace.activeProject)}`;
