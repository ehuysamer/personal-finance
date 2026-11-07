<script setup>
import { computed, inject, onMounted, provide } from "vue";
import { state, parseRoute, go, projects, tenantPath, toast } from "./state.js";
import Icon from "./components/Icon.vue";
import ImportView from "./views/ImportView.vue";
import AccountsView from "./views/AccountsView.vue";
import AnalysisView from "./views/AnalysisView.vue";
import ForecastView from "./views/ForecastView.vue";
import DocumentsView from "./views/DocumentsView.vue";

const api = inject("api");
const auth = inject("auth");
const TENANT_KEY = "personalFinanceTenant";
const sections = [
  { id: "import", label: "Import", icon: "upload" },
  { id: "accounts", label: "Accounts", icon: "folder" },
  { id: "analysis", label: "Analysis", icon: "chart" },
  { id: "forecast", label: "Forecast", icon: "trend" },
  { id: "documents", label: "Documents", icon: "document" }
];

async function loadWorkspace() {
  state.workspace = await api.get(`${tenantPath()}/workspace`);
}
provide("reloadWorkspace", loadWorkspace);

async function chooseTenant(id) {
  state.tenant = id;
  try { localStorage.setItem(TENANT_KEY, id); } catch { /* private mode */ }
  await loadWorkspace();
}
async function chooseProject(id) {
  await api.put(`${tenantPath()}/active-project`, { project: id });
  state.workspace.activeProject = id;
  toast("Active project changed");
}

const needsProject = computed(() => !["import", "documents"].includes(state.route.section) && !state.workspace.activeProject);
const projectList = computed(() => projects());

onMounted(async () => {
  window.addEventListener("hashchange", () => { state.route = parseRoute(); });
  state.route = parseRoute();
  try {
    const back = await auth.complete();
    if (back !== null) history.replaceState(null, "", back);
    if (!auth.signedIn()) { await auth.start(); return; }
    const me = await api.get("/v1/me");
    state.email = me.email;
    state.tenants = me.tenants;
    let saved = null;
    try { saved = localStorage.getItem(TENANT_KEY); } catch { /* private mode */ }
    const initial = me.tenants.find((tenant) => tenant.id === saved) || (me.tenants.length === 1 ? me.tenants[0] : null);
    if (initial) await chooseTenant(initial.id);
  } catch (error) {
    state.error = error.status === 403 ? "This account does not have access to Personal finance." : error.message;
  }
  state.ready = true;
});
</script>

<template>
  <div v-if="!state.ready" class="center muted">Loading…</div>
  <div v-else-if="state.error && !state.tenant" class="center">
    <p class="error">{{ state.error }}</p>
    <button @click="auth.signOut()">Sign out</button>
  </div>
  <div v-else-if="!state.tenant" class="center">
    <h1>Choose a tenant</h1>
    <ul class="list" style="min-width: min(360px, 90vw)">
      <li v-for="tenant in state.tenants" :key="tenant.id" class="link" @click="chooseTenant(tenant.id)">
        <div class="grow"><div class="title">{{ tenant.name }}</div><div class="sub">{{ tenant.id }}</div></div>
        <Icon name="chevron" />
      </li>
      <li v-if="!state.tenants.length" class="empty">You are not a member of any tenant yet.</li>
    </ul>
    <button class="ghost" @click="auth.signOut()">Sign out {{ state.email }}</button>
  </div>
  <template v-else>
    <header class="top">
      <span class="brand"><img src="/icon.svg" width="22" height="22" alt="" />Finance</span>
      <select v-if="state.tenants.length > 1" :value="state.tenant" aria-label="Tenant" @change="chooseTenant($event.target.value)">
        <option v-for="tenant in state.tenants" :key="tenant.id" :value="tenant.id">{{ tenant.name }}</option>
      </select>
      <select v-if="projectList.length" :value="state.workspace.activeProject" aria-label="Active project" @change="chooseProject($event.target.value)">
        <option v-for="project in projectList" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
      <button class="icon ghost" title="Sign out" aria-label="Sign out" @click="auth.signOut()"><Icon name="logout" /></button>
    </header>
    <nav class="bottom">
      <a v-for="section in sections" :key="section.id" :href="`#/${section.id}`" :class="{ active: state.route.section === section.id }"><Icon :name="section.icon" />{{ section.label }}</a>
    </nav>
    <main>
      <div v-if="needsProject && state.route.section !== 'accounts'" class="card">
        <p>Every section from here on works in one project. Create one first.</p>
        <button class="primary" @click="go('accounts', 'new-project')">Create a project</button>
      </div>
      <ImportView v-else-if="state.route.section === 'import'" :key="`i-${state.tenant}`" />
      <AccountsView v-else-if="state.route.section === 'accounts'" :key="`a-${state.tenant}-${state.workspace.activeProject}`" />
      <AnalysisView v-else-if="state.route.section === 'analysis'" :key="`n-${state.tenant}-${state.workspace.activeProject}`" />
      <DocumentsView v-else-if="state.route.section === 'documents'" :key="`d-${state.tenant}`" />
      <ForecastView v-else-if="state.route.section === 'forecast'" :key="`f-${state.tenant}-${state.workspace.activeProject}`" />
    </main>
  </template>
  <div v-if="state.toast" class="toast" role="status">{{ state.toast }}</div>
</template>
