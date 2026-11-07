<script setup>
import { computed, inject, onMounted, ref } from "vue";
import { datasources, go, projectPath, state, tenantPath, toast } from "../state.js";
import { formatPercent } from "../lib/format.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";

const api = inject("api");
const reloadWorkspace = inject("reloadWorkspace");
const project = ref(null);
const accounts = ref([]);
const error = ref("");
const projectDraft = ref(null);
const accountDraft = ref(null);
const TYPES = ["income", "expense", "asset", "liability"];

async function load() {
  error.value = "";
  if (!state.workspace.activeProject) { project.value = null; return; }
  try {
    project.value = await api.get(projectPath());
    accounts.value = (await api.get(`${projectPath()}/accounts`)).items;
  } catch (failure) { error.value = failure.message; }
}
onMounted(async () => {
  await load();
  if (state.route.parts[0] === "new-project" || !state.workspace.activeProject) newProject();
});

function newProject() { projectDraft.value = { name: "", datasources: datasources().map((item) => item.id), birthDate: "", categories: null }; }
function editProject() { projectDraft.value = JSON.parse(JSON.stringify(project.value)); }
async function saveProject() {
  const draft = projectDraft.value;
  const body = { name: draft.name, description: draft.description, datasources: draft.datasources, birthDate: draft.birthDate || null, ...(draft.categories ? { categories: draft.categories.map((category) => ({ ...category, inflation: Number(category.inflation) / 100 })) } : {}) };
  try {
    if (draft.id) await api.put(`${tenantPath()}/projects/${draft.id}`, body);
    else { const created = await api.post(`${tenantPath()}/projects`, body); await api.put(`${tenantPath()}/active-project`, { project: created.id }); }
    await reloadWorkspace();
    projectDraft.value = null;
    if (state.route.parts[0] === "new-project") go("accounts");
    toast("Project saved");
    await load();
  } catch (failure) { error.value = failure.message; }
}
async function deleteProject() {
  if (!confirm(`Delete project ${project.value.name}?`)) return;
  try { await api.del(projectPath()); await reloadWorkspace(); await load(); } catch (failure) { error.value = failure.message; }
}
// Categories are edited in percent; the API keeps fractions.
function editCategories() { const draft = JSON.parse(JSON.stringify(project.value)); draft.categories = draft.categories.map((category) => ({ ...category, inflation: Math.round(category.inflation * 10000) / 100 })); projectDraft.value = draft; }

function newAccount() { accountDraft.value = { name: "", category: project.value.categories[0]?.id, shortCode: "", tags: "", description: "" }; }
function editAccount(account) { accountDraft.value = { ...account, tags: (account.tags || []).join(", ") }; }
async function saveAccount() {
  const draft = accountDraft.value;
  const body = { name: draft.name, category: draft.category, shortCode: draft.shortCode || null, tags: String(draft.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean), description: draft.description };
  try {
    if (draft.id) await api.put(`${projectPath()}/accounts/${draft.id}`, body); else await api.post(`${projectPath()}/accounts`, body);
    accountDraft.value = null; toast("Account saved"); await load();
  } catch (failure) { error.value = failure.message; }
}
async function deleteAccount(account) {
  try { await api.del(`${projectPath()}/accounts/${account.id}`); }
  catch (failure) {
    if (failure.code !== "ERR-IN-USE") { error.value = failure.message; return; }
    const { rules = [], charts = [] } = failure.data || {};
    if (!confirm(`${account.name} is used by ${rules.length} rules and ${charts.length} charts (${[...rules, ...charts].join(", ")}). Delete it anyway?`)) return;
    await api.del(`${projectPath()}/accounts/${account.id}`, { force: true });
  }
  accountDraft.value = null; toast("Account deleted"); await load();
}
const grouped = computed(() => (project.value?.categories || []).map((category) => ({ category, accounts: accounts.value.filter((account) => account.category === category.id) })));
const age = computed(() => { if (!project.value?.birthDate) return null; const ms = Date.now() - Date.parse(project.value.birthDate); return Math.floor(ms / (365.25 * 86400000)); });
</script>

<template>
  <section>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="project">
      <div class="spread"><h1>{{ project.name }}</h1>
        <div class="row"><button class="icon ghost" aria-label="Edit project" @click="editProject"><Icon name="edit" /></button><button class="icon ghost" aria-label="New project" @click="newProject"><Icon name="plus" /></button></div>
      </div>
      <p class="muted small">
        Datasources: {{ project.datasources.map((id) => datasources().find((ds) => ds.id === id)?.name || id).join(", ") || "none" }}
        <template v-if="project.birthDate"> · born {{ project.birthDate }} (age {{ age }})</template>
      </p>
      <div class="spread"><h2>Accounts</h2><button class="primary" @click="newAccount"><Icon name="plus" /> Account</button></div>
      <template v-for="group in grouped" :key="group.category.id">
        <h3>{{ group.category.name }} <span class="badge">{{ group.category.type }}</span> <span class="muted small">inflation {{ formatPercent(group.category.inflation) }}</span></h3>
        <ul class="list">
          <li v-for="account in group.accounts" :key="account.id" class="link" @click="editAccount(account)">
            <div class="grow"><div class="title">{{ account.name }}</div><div class="sub"><template v-if="account.shortCode">{{ account.shortCode }} · </template>{{ (account.tags || []).join(", ") || "no tags" }}</div></div>
            <Icon name="chevron" />
          </li>
          <li v-if="!group.accounts.length" class="empty">No accounts</li>
        </ul>
      </template>
      <div class="row" style="margin-top: 16px"><button @click="editCategories">Edit categories</button><button class="danger" @click="deleteProject">Delete project</button></div>
    </template>
    <p v-else-if="!projectDraft" class="muted">No project yet.</p>

    <Sheet v-if="projectDraft" :title="projectDraft.id ? 'Edit project' : 'New project'" @close="projectDraft = null">
      <label class="field"><span>Name</span><input v-model="projectDraft.name" placeholder="Household" /></label>
      <label class="field"><span>Birth date (yours, or the company's founding date)</span><input v-model="projectDraft.birthDate" type="date" /></label>
      <fieldset class="card"><legend class="small">Datasources</legend>
        <label v-for="item in datasources()" :key="item.id" class="check"><input v-model="projectDraft.datasources" type="checkbox" :value="item.id" />{{ item.name }}</label>
        <p v-if="!datasources().length" class="small muted">Create datasources in Import first.</p>
      </fieldset>
      <template v-if="projectDraft.categories">
        <h3>Categories</h3>
        <div v-for="(category, index) in projectDraft.categories" :key="index" class="card">
          <div class="grid2">
            <label class="field"><span>Name</span><input v-model="category.name" /></label>
            <label class="field"><span>Id</span><input v-model="category.id" :disabled="!!project?.categories.find((item) => item.id === category.id)" /></label>
            <label class="field"><span>Type</span><select v-model="category.type"><option v-for="type in TYPES" :key="type" :value="type">{{ type }}</option></select></label>
            <label class="field"><span>Inflation % per year</span><input v-model="category.inflation" type="number" step="0.1" inputmode="decimal" /></label>
          </div>
          <button class="danger" @click="projectDraft.categories.splice(index, 1)">Remove</button>
        </div>
        <button @click="projectDraft.categories.push({ id: '', name: '', type: 'expense', inflation: 3 })"><Icon name="plus" /> Category</button>
      </template>
      <div class="row end" style="margin-top: 12px"><button class="primary" :disabled="!projectDraft.name" @click="saveProject">Save</button></div>
    </Sheet>

    <Sheet v-if="accountDraft" :title="accountDraft.id ? 'Edit account' : 'New account'" @close="accountDraft = null">
      <label class="field"><span>Name</span><input v-model="accountDraft.name" placeholder="Groceries" /></label>
      <div class="grid2">
        <label class="field"><span>Category</span><select v-model="accountDraft.category"><option v-for="category in project.categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label>
        <label class="field"><span>Short code (for charts and formulas)</span><input v-model="accountDraft.shortCode" placeholder="FOOD" autocapitalize="characters" /></label>
      </div>
      <label class="field"><span>Tags (comma separated)</span><input v-model="accountDraft.tags" placeholder="essential, weekly" /></label>
      <label class="field"><span>Description</span><input v-model="accountDraft.description" /></label>
      <div class="spread" style="margin-top: 12px">
        <button v-if="accountDraft.id && !accountDraft.builtIn" class="danger" @click="deleteAccount(accountDraft)">Delete</button><span v-else />
        <button class="primary" :disabled="!accountDraft.name" @click="saveAccount">Save</button>
      </div>
    </Sheet>
  </section>
</template>
