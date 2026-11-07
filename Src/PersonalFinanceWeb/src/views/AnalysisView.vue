<script setup>
import { computed, inject, onMounted, ref } from "vue";
import { projectPath, state, toast } from "../state.js";
import { formatDate, formatMoney } from "../lib/format.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";
import ChartPanel from "../components/ChartPanel.vue";
import JobProgress from "../components/JobProgress.vue";
import TransactionList from "../components/TransactionList.vue";
import NewAccountForm from "../components/NewAccountForm.vue";

const api = inject("api");
const tab = ref(state.route.parts[0] || "run");
const project = ref(null);
const accounts = ref([]);
const rules = ref([]);
const status = ref(null);
const jobId = ref(null);
const error = ref("");
const ruleDraft = ref(null);
const testResult = ref(null);
const historyAccount = ref(null);
const FIELDS = [["description", "Description"], ["account", "Bank account"], ["filename", "File name"], ["datasource", "Datasource"]];
const OPS = [["contains", "contains"], ["containsany", "contains any of"], ["containsall", "contains all of"], ["startswith", "starts with"], ["endswith", "ends with"], ["exact", "is exactly"], ["wildcard", "matches wildcard (* ?)"], ["regex", "matches regex"]];

async function load() {
  error.value = "";
  try {
    const [p, a, r, s, jobs] = await Promise.all([api.get(projectPath()), api.get(`${projectPath()}/accounts`), api.get(`${projectPath()}/rules`), api.get(`${projectPath()}/analysis`), api.get(`${projectPath()}/jobs`)]);
    project.value = p; accounts.value = a.items; rules.value = r.items; status.value = s;
    const running = jobs.items.find((job) => job.type === "analysis" && ["queued", "running"].includes(job.status));
    if (running) jobId.value = running.id;
    if (!historyAccount.value && accounts.value.length) historyAccount.value = accounts.value[0].id;
  } catch (failure) { error.value = failure.message; }
}
onMounted(load);

async function analyse() {
  error.value = ""; rulesChanged.value = false;
  try { jobId.value = (await api.post(`${projectPath()}/analysis`)).id; } catch (failure) { error.value = failure.message; }
}
async function jobDone(job) { toast(`Analysis ${job.status}`); status.value = await api.get(`${projectPath()}/analysis`); unmatchedKey.value += 1; }

// A rule's account can be made on the spot (and its category with it).
const addingAccount = ref(false);
async function reloadProject() { project.value = await api.get(projectPath()); }
async function accountAdded(account) {
  accounts.value = (await api.get(`${projectPath()}/accounts`)).items;
  ruleDraft.value.account = account.id;
  addingAccount.value = false;
}

// Transactions no rule matched: each can start a rule, pre-filled with its beneficiary words.
const unmatchedKey = ref(0);
const unmatchedCount = computed(() => status.value?.accounts?.find((item) => item.id === "uncategorised")?.count || 0);
const rulesChanged = ref(false);
function ruleFromTransaction(tx) {
  const suggestion = tx.suggestedRule;
  addingAccount.value = false;
  ruleDraft.value = { name: suggestion.name, account: "", enabled: true, conditions: suggestion.conditions.map((condition) => ({ ...condition })), date: { start: "", end: "" }, amount: { min: "", max: "" }, example: suggestion.example };
  testResult.value = null;
  testRule();
}

const accountName = (id) => accounts.value.find((account) => account.id === id)?.name || id;
const accountSummary = computed(() => (status.value?.accounts || []).map((item) => ({ ...item, name: accountName(item.id) })).sort((a, b) => Math.abs(b.running) - Math.abs(a.running)));

function newRule() { addingAccount.value = false; ruleDraft.value = { name: "", account: "", enabled: true, conditions: [{ field: "description", op: "contains", value: "" }], date: { start: "", end: "" }, amount: { min: "", max: "" } }; testResult.value = null; }
async function editRule(item) { addingAccount.value = false; const rule = await api.get(`${projectPath()}/rules/${item.id}`); ruleDraft.value = { ...rule, date: { start: rule.date.start || "", end: rule.date.end || "" }, amount: { min: rule.amount.min ?? "", max: rule.amount.max ?? "" }, conditions: rule.conditions.map((condition) => ({ ...condition, value: condition.values ? condition.values.join(", ") : condition.value })) }; testResult.value = null; }
function body() {
  const draft = ruleDraft.value;
  return { name: draft.name, account: draft.account, enabled: draft.enabled, ...(draft.id ? { id: draft.id, order: draft.order } : {}), conditions: draft.conditions.map((condition) => (["containsall", "containsany"].includes(condition.op) ? { field: condition.field, op: condition.op, values: String(condition.value).split(",").map((value) => value.trim()).filter(Boolean), not: condition.not } : { field: condition.field, op: condition.op, value: condition.value, not: condition.not })), date: { start: draft.date.start || null, end: draft.date.end || null }, amount: { min: draft.amount.min === "" ? null : Number(draft.amount.min), max: draft.amount.max === "" ? null : Number(draft.amount.max) } };
}
async function testRule() { error.value = ""; try { testResult.value = await api.post(`${projectPath()}/rules-test`, { rule: body() }); } catch (failure) { error.value = failure.message; } }
async function saveRule() {
  error.value = "";
  try {
    const { id, order: _o, ...rest } = body();
    if (id) await api.put(`${projectPath()}/rules/${id}`, rest); else await api.post(`${projectPath()}/rules`, rest);
    ruleDraft.value = null; rulesChanged.value = true; toast("Rule saved; analyse to apply it"); await load();
  } catch (failure) { error.value = failure.message; }
}
async function deleteRule() { if (!confirm("Delete this rule?")) return; await api.del(`${projectPath()}/rules/${ruleDraft.value.id}`); ruleDraft.value = null; await load(); }
async function cloneRule(item) { await api.post(`${projectPath()}/rules/${item.id}/clone`); await load(); }
async function moveRule(index, delta) {
  const ids = rules.value.map((rule) => rule.id);
  const [id] = ids.splice(index, 1); ids.splice(index + delta, 0, id);
  rules.value = (await api.put(`${projectPath()}/rules-order`, { ids })).items;
}
</script>

<template>
  <section>
    <h1>Analysis</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="tabs" role="tablist">
      <button v-for="item in [['run', 'Overview'], ['rules', 'Rules'], ['charts', 'Charts'], ['history', 'History']]" :key="item[0]" :class="{ on: tab === item[0] }" @click="tab = item[0]">{{ item[1] }}</button>
    </div>

    <div v-if="tab === 'run'">
      <div class="card spread">
        <div><strong>Analyse</strong><p class="small muted">Puts every transaction of this project's datasources into accounts by the rules, and builds running totals and monthly, quarterly and yearly figures.</p></div>
        <button class="primary" :disabled="!!jobId" @click="analyse"><Icon name="play" /> Analyse</button>
      </div>
      <JobProgress v-if="jobId" :job-id="jobId" @done="(job) => { jobId = null; jobDone(job); }" />
      <p v-if="status?.finishedAt" class="small muted">Last analysed {{ new Date(status.finishedAt).toLocaleString() }} · transactions up to {{ formatDate(status.lastDate) }}</p>
      <p v-for="warning in status?.warnings || []" :key="warning" class="small neg">{{ warning }}</p>
      <ul class="list">
        <li v-for="item in accountSummary" :key="item.id" class="link" @click="historyAccount = item.id; tab = 'history'">
          <div class="grow"><div class="title">{{ item.name }}</div><div class="sub">{{ item.count }} transactions<template v-if="item.first"> · {{ formatDate(item.first) }} – {{ formatDate(item.last) }}</template></div></div>
          <div class="num" :class="{ neg: item.running < 0 }">{{ formatMoney(item.running) }}</div>
        </li>
        <li v-if="!accountSummary.length" class="empty">Not analysed yet</li>
      </ul>
      <template v-if="status?.finishedAt">
        <div class="spread"><h2>Not matched by any rule <span class="badge">{{ unmatchedCount }}</span></h2><button v-if="rulesChanged" class="primary" :disabled="!!jobId" @click="analyse"><Icon name="play" /> Analyse again</button></div>
        <p class="muted small">These went to Uncategorised. Add a rule to put them (and others like them) into an account.</p>
        <TransactionList :key="unmatchedKey" :path="`${projectPath()}/unmatched`" :show-running="false" action-label="Add rule" @action="ruleFromTransaction" />
      </template>
    </div>

    <div v-if="tab === 'rules'">
      <div class="spread"><p class="small muted">The first enabled rule that matches wins. Anything unmatched goes to Uncategorised.</p><button class="primary" @click="newRule"><Icon name="plus" /> Rule</button></div>
      <ul class="list">
        <li v-for="(rule, index) in rules" :key="rule.id">
          <div class="grow link" @click="editRule(rule)"><div class="title">{{ rule.name }} <span v-if="!rule.enabled" class="badge">off</span></div><div class="sub">→ {{ accountName(rule.account) }}</div></div>
          <button class="icon ghost" :disabled="index === 0" aria-label="Move up" @click="moveRule(index, -1)"><Icon name="up" /></button>
          <button class="icon ghost" :disabled="index === rules.length - 1" aria-label="Move down" @click="moveRule(index, 1)"><Icon name="down" /></button>
          <button class="icon ghost" aria-label="Clone" @click="cloneRule(rule)"><Icon name="copy" /></button>
        </li>
        <li v-if="!rules.length" class="empty">No rules yet</li>
      </ul>
    </div>

    <div v-if="tab === 'charts' && project">
      <ChartPanel :accounts="accounts" :categories="project.categories" />
    </div>

    <div v-if="tab === 'history'">
      <select v-model="historyAccount" aria-label="Account" style="margin-bottom: 8px"><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option></select>
      <TransactionList v-if="historyAccount" :path="`${projectPath()}/accounts/${historyAccount}/transactions`" />
    </div>

    <Sheet v-if="ruleDraft" :title="ruleDraft.id ? 'Edit rule' : 'New rule'" @close="ruleDraft = null">
      <div class="grid2">
        <label class="field"><span>Name</span><input v-model="ruleDraft.name" placeholder="Supermarkets" /></label>
        <div class="field">
          <span class="small muted" style="font-weight: 550">Into account</span>
          <div class="row" style="flex-wrap: nowrap">
            <select v-model="ruleDraft.account" aria-label="Into account"><option value="" disabled>Choose an account</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option></select>
            <button class="icon" aria-label="Add an account" title="Add an account" @click="addingAccount = true"><Icon name="plus" /></button>
          </div>
        </div>
      </div>
      <NewAccountForm v-if="addingAccount && project" :categories="project.categories" :name="ruleDraft.name" @created="accountAdded" @categories-changed="reloadProject" @cancel="addingAccount = false" />
      <label class="check"><input v-model="ruleDraft.enabled" type="checkbox" />Enabled</label>
      <p v-if="ruleDraft.example" class="card small">From: {{ ruleDraft.example.description }} · {{ formatDate(ruleDraft.example.date) }} · {{ formatMoney(ruleDraft.example.amount) }}</p>
      <h3>All of these</h3>
      <div v-for="(condition, index) in ruleDraft.conditions" :key="index" class="card">
        <div class="grid2">
          <select v-model="condition.field" aria-label="Field"><option v-for="field in FIELDS" :key="field[0]" :value="field[0]">{{ field[1] }}</option></select>
          <select v-model="condition.op" aria-label="Match"><option v-for="op in OPS" :key="op[0]" :value="op[0]">{{ op[1] }}</option></select>
        </div>
        <input v-model="condition.value" :placeholder="['containsall', 'containsany'].includes(condition.op) ? 'countdown, new world, pak n save' : 'text'" aria-label="Value" style="margin-top: 6px" />
        <div class="row"><label class="check small"><input v-model="condition.not" type="checkbox" />Does not match</label><button class="danger" @click="ruleDraft.conditions.splice(index, 1)">Remove</button></div>
      </div>
      <button @click="ruleDraft.conditions.push({ field: 'description', op: 'contains', value: '' })"><Icon name="plus" /> Condition</button>
      <div class="grid2">
        <label class="field"><span>From date</span><input v-model="ruleDraft.date.start" type="date" /></label>
        <label class="field"><span>To date</span><input v-model="ruleDraft.date.end" type="date" /></label>
        <label class="field"><span>Minimum amount</span><input v-model="ruleDraft.amount.min" type="number" step="0.01" inputmode="decimal" /></label>
        <label class="field"><span>Maximum amount</span><input v-model="ruleDraft.amount.max" type="number" step="0.01" inputmode="decimal" /></label>
      </div>
      <div v-if="testResult" class="card">
        <strong>{{ testResult.count }} transactions match</strong><span v-if="testResult.takenEarlier" class="muted small"> ({{ testResult.takenEarlier }} go to an earlier rule)</span>
        <ul class="list" style="margin-top: 6px">
          <li v-for="(tx, index) in testResult.transactions.slice(0, 15)" :key="index" :class="{ actual: tx.takenBy }"><div class="grow"><div class="title">{{ tx.description }}</div><div class="sub">{{ formatDate(tx.date) }}<template v-if="tx.takenBy"> · taken by {{ tx.takenBy }}</template></div></div><div class="num">{{ formatMoney(tx.amount) }}</div></li>
        </ul>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="spread" style="margin-top: 12px">
        <button v-if="ruleDraft.id" class="danger" @click="deleteRule">Delete</button><span v-else />
        <div class="row"><button @click="testRule">Test</button><button class="primary" :disabled="!ruleDraft.name || !ruleDraft.account" @click="saveRule">Save</button></div>
      </div>
    </Sheet>
  </section>
</template>
