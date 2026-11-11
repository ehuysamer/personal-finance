<script setup>
import { computed, inject, onMounted, ref } from "vue";
import { datasources, go, projectPath, state, tenantPath, toast } from "../state.js";
import { currencyLabel, formatPercent } from "../lib/format.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";
import CategorySelect from "../components/CategorySelect.vue";
import CurrencyInput from "../components/CurrencyInput.vue";

const api = inject("api");
const reloadWorkspace = inject("reloadWorkspace");
const project = ref(null);
const accounts = ref([]);
const error = ref("");
const projectDraft = ref(null);
const accountDraft = ref(null);
const TYPES = ["income", "expense", "asset", "liability", "ignore"];

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

function newProject() { projectDraft.value = { name: "", datasources: datasources().map((item) => item.id), birthDate: "", currency: "NZD" }; }
function editProject() { projectDraft.value = JSON.parse(JSON.stringify(project.value)); }
async function saveProject() {
  const draft = projectDraft.value;
  const body = { name: draft.name, description: draft.description, datasources: draft.datasources, birthDate: draft.birthDate || null, currency: draft.currency || "NZD" };
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
// Categories, one at a time (inflation edited in percent; the API keeps fractions). A rename applies everywhere;
// a delete moves the category's accounts (and the charts that total it) to another category.
const categoryDraft = ref(null);
const managing = ref(false);
const categoryDelete = ref(null);
function newCategory() { categoryDraft.value = { name: "", type: "expense", inflation: 3 }; }
function editCategory(category) { categoryDraft.value = { ...category, inflation: Math.round(category.inflation * 10000) / 100 }; }
async function saveCategory() {
  const draft = categoryDraft.value;
  const body = { name: draft.name, type: draft.type, inflation: Number(draft.inflation || 0) / 100 };
  try {
    if (draft.id) await api.put(`${projectPath()}/categories/${draft.id}`, body); else await api.post(`${projectPath()}/categories`, body);
    categoryDraft.value = null; toast("Category saved"); await load();
  } catch (failure) { error.value = failure.message; }
}
function startDeleteCategory(category) {
  const others = project.value.categories.filter((item) => item.id !== category.id);
  if (!others.length) { error.value = "A project needs at least one category."; return; }
  categoryDelete.value = { category, moveTo: (others.find((item) => item.type === category.type) || others[0]).id, accounts: accounts.value.filter((account) => account.category === category.id).length };
}
async function deleteCategory() {
  const { category, moveTo } = categoryDelete.value;
  try {
    const result = await api.del(`${projectPath()}/categories/${category.id}`, { moveTo });
    categoryDelete.value = null;
    toast(`Deleted ${category.name}: ${result.accounts.length} accounts and ${result.charts.length} charts moved`);
    await load();
  } catch (failure) { error.value = failure.message; }
}
async function cloneProject() {
  const name = prompt("Name of the copy", `${project.value.name} (copy)`);
  if (!name) return;
  try {
    const copy = await api.post(`${projectPath()}/clone`, { name });
    await reloadWorkspace();
    toast(`${copy.name} is the active project: run Analyse on it`);
  } catch (failure) { error.value = failure.message; }
}

function newAccount() { accountDraft.value = { name: "", category: project.value.categories[0]?.id, currency: project.value.currency || "NZD", shortCode: "", tags: "", description: "" }; }
function editAccount(account) { accountDraft.value = { ...account, currency: account.currency || project.value.currency || "NZD", tags: (account.tags || []).join(", ") }; }
async function saveAccount() {
  const draft = accountDraft.value;
  const body = { name: draft.name, category: draft.category, currency: draft.currency, shortCode: draft.shortCode || null, tags: String(draft.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean), description: draft.description };
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
        <div class="row"><button class="icon ghost" aria-label="Edit project" title="Edit project" @click="editProject"><Icon name="edit" /></button><button class="icon ghost" aria-label="Clone project" title="Clone project" @click="cloneProject"><Icon name="copy" /></button><button class="icon ghost" aria-label="New project" title="New project" @click="newProject"><Icon name="plus" /></button></div>
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
            <div class="grow"><div class="title">{{ account.name }}</div><div class="sub">{{ currencyLabel(account.currency || project.currency || "NZD") }} · <template v-if="account.shortCode">{{ account.shortCode }} · </template>{{ (account.tags || []).join(", ") || "no tags" }}</div></div>
            <Icon name="chevron" />
          </li>
          <li v-if="!group.accounts.length" class="empty">No accounts</li>
        </ul>
      </template>
      <div class="row" style="margin-top: 16px"><button @click="managing = true">Manage categories</button><button class="danger" @click="deleteProject">Delete project</button></div>
    </template>
    <p v-else-if="!projectDraft" class="muted">No project yet.</p>

    <Sheet v-if="projectDraft" :title="projectDraft.id ? 'Edit project' : 'New project'" @close="projectDraft = null">
      <label class="field"><span>Name</span><input v-model="projectDraft.name" placeholder="Household" /></label>
      <label class="field"><span>Birth date (yours, or the company's founding date)</span><input v-model="projectDraft.birthDate" type="date" /></label>
      <CurrencyInput v-model="projectDraft.currency" label="Default currency of new accounts" />
      <fieldset class="card"><legend class="small">Datasources</legend>
        <label v-for="item in datasources()" :key="item.id" class="check"><input v-model="projectDraft.datasources" type="checkbox" :value="item.id" />{{ item.name }}</label>
        <p v-if="!datasources().length" class="small muted">Create datasources in Import first.</p>
      </fieldset>
      <p v-if="projectDraft.id" class="small muted">Categories are edited on the Accounts page.</p>
      <div class="row end" style="margin-top: 12px"><button class="primary" :disabled="!projectDraft.name" @click="saveProject">Save</button></div>
    </Sheet>

    <Sheet v-if="managing" title="Categories" @close="managing = false">
      <p class="small muted">Renaming shows everywhere the category is used. Deleting moves its accounts to another category.</p>
      <ul class="list">
        <li v-for="category in project.categories" :key="category.id">
          <div class="grow"><div class="title">{{ category.name }}</div><div class="sub">{{ category.type }} · inflation {{ formatPercent(category.inflation) }} · {{ accounts.filter((account) => account.category === category.id).length }} accounts</div></div>
          <button class="icon ghost" :aria-label="`Rename ${category.name}`" @click="editCategory(category)"><Icon name="edit" /></button>
          <button class="icon ghost" :aria-label="`Delete ${category.name}`" @click="startDeleteCategory(category)"><Icon name="trash" /></button>
        </li>
      </ul>
      <div class="row end" style="margin-top: 10px"><button class="primary" @click="newCategory"><Icon name="plus" /> Category</button></div>
    </Sheet>
    <Sheet v-if="categoryDraft" :title="categoryDraft.id ? `Edit ${categoryDraft.name || 'category'}` : 'New category'" @close="categoryDraft = null">
      <label class="field"><span>Name</span><input v-model="categoryDraft.name" placeholder="Pets" /></label>
      <div class="grid2">
        <label class="field"><span>Type</span><select v-model="categoryDraft.type"><option v-for="type in TYPES" :key="type" :value="type">{{ type }}</option></select></label>
        <label class="field"><span>Inflation % per year</span><input v-model="categoryDraft.inflation" type="number" step="0.1" inputmode="decimal" /></label>
      </div>
      <p v-if="categoryDraft.id" class="small muted">The new name shows everywhere the category is used: accounts, charts and forecasts.</p>
      <div class="row end"><button class="primary" :disabled="!categoryDraft.name" @click="saveCategory">Save</button></div>
    </Sheet>
    <Sheet v-if="categoryDelete" :title="`Delete ${categoryDelete.category.name}`" @close="categoryDelete = null">
      <p>{{ categoryDelete.accounts }} accounts are in this category. They, and any chart that totals it, move to:</p>
      <label class="field"><span>Move to</span><select v-model="categoryDelete.moveTo"><option v-for="item in project.categories.filter((c) => c.id !== categoryDelete.category.id)" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <p class="small muted">Forecasts drop their inflation override for this category.</p>
      <div class="row end"><button class="danger" @click="deleteCategory">Delete category</button></div>
    </Sheet>
    <Sheet v-if="accountDraft" :title="accountDraft.id ? 'Edit account' : 'New account'" @close="accountDraft = null">
      <label class="field"><span>Name</span><input v-model="accountDraft.name" placeholder="Groceries" /></label>
      <div class="grid2">
        <CategorySelect v-model="accountDraft.category" :categories="project.categories" @created="load" />
        <CurrencyInput v-model="accountDraft.currency" />
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
