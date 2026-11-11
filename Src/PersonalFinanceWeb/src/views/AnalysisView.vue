<script setup>
import { computed, inject, onMounted, ref } from "vue";
import { projectPath, state, toast } from "../state.js";
import { accountsByCategory, categoryName, formatDate, formatMoney } from "../lib/format.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";
import Explore from "../components/Explore.vue";
import JobProgress from "../components/JobProgress.vue";
import TransactionList from "../components/TransactionList.vue";
import NewAccountForm from "../components/NewAccountForm.vue";
import TxRow from "../components/TxRow.vue";

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
  ruleDraft.value = { name: suggestion.name, account: "", enabled: true, conditions: suggestion.conditions.map((condition) => ({ ...condition })), date: { start: "", end: "" }, amount: { min: "", max: "" }, example: { ...suggestion.example, currency: tx.currency } };
  testResult.value = null;
  testRule();
}

const currencyOf = (id) => accounts.value.find((account) => account.id === id)?.currency || project.value?.currency || "NZD";
// Rules by category, then account (in the project's order), each rule with its place in the order.
const ruleView = ref("tree");
const ruleTree = computed(() => {
  const placed = rules.value.map((rule, i) => ({ ...rule, place: i + 1 }));
  return accountsByCategory(accounts.value, project.value?.categories)
    .map((group) => ({ category: group.category, accounts: group.accounts.map((account) => ({ account, rules: placed.filter((rule) => rule.account === account.id) })).filter((branch) => branch.rules.length) }))
    .filter((group) => group.accounts.length)
    .concat(orphanRules(placed));
});
// Rules whose account no longer exists are still shown (so they can be fixed or deleted).
function orphanRules(placed) {
  const known = new Set(accounts.value.map((account) => account.id));
  const lost = placed.filter((rule) => !known.has(rule.account));
  return lost.length ? [{ category: { id: "-missing", name: "Account deleted" }, accounts: [{ account: { id: "-missing", name: "(account deleted)" }, rules: lost }] }] : [];
}
const categoryOf = (id) => categoryName(accounts.value.find((account) => account.id === id), project.value?.categories);
const accountName = (id) => accounts.value.find((account) => account.id === id)?.name || id;
const accountSummary = computed(() => (status.value?.accounts || []).map((item) => ({ ...item, name: accountName(item.id) })).sort((a, b) => Math.abs(b.running) - Math.abs(a.running)));
// The overview by category (in the project's order; ignored categories last): each with its accounts and its total,
// in the accounts' currency when they share one.
const summaryByCategory = computed(() => {
  const byId = new Map(accountSummary.value.map((item) => [item.id, item]));
  const categories = [...(project.value?.categories || [])].sort((a, b) => (a.type === "ignore") - (b.type === "ignore"));
  const groups = categories.map((category) => {
    const items = accounts.value.filter((account) => account.category === category.id).map((account) => byId.get(account.id)).filter(Boolean).sort((a, b) => Math.abs(b.running) - Math.abs(a.running));
    const currencies = [...new Set(items.map((item) => currencyOf(item.id)))];
    return { category, items, total: Math.round(items.reduce((sum, item) => sum + (item.running || 0), 0) * 100) / 100, currency: currencies.length === 1 ? currencies[0] : null };
  });
  return groups.filter((group) => group.items.length);
});

function newRule() { addingAccount.value = false; ruleDraft.value = { name: "", account: "", enabled: true, conditions: [{ field: "description", op: "contains", value: "" }], date: { start: "", end: "" }, amount: { min: "", max: "" } }; testResult.value = null; }
async function editRule(item) { addingAccount.value = false; const rule = await api.get(`${projectPath()}/rules/${item.id}`); ruleDraft.value = { ...rule, date: { start: rule.date.start || "", end: rule.date.end || "" }, amount: { min: rule.amount.min ?? "", max: rule.amount.max ?? "" }, conditions: rule.conditions.map((condition) => ({ ...condition, value: condition.values ? condition.values.join(", ") : condition.value })) }; testResult.value = null; }
function body() {
  const draft = ruleDraft.value;
  return { name: draft.name, account: draft.account, enabled: draft.enabled, ...(draft.id ? { id: draft.id, order: draft.order } : {}), conditions: draft.conditions.map((condition) => (["containsall", "containsany"].includes(condition.op) ? { field: condition.field, op: condition.op, values: String(condition.value).split(",").map((value) => value.trim()).filter(Boolean), not: condition.not, caseSensitive: condition.caseSensitive === true } : { field: condition.field, op: condition.op, value: condition.value, not: condition.not, caseSensitive: condition.caseSensitive === true })), date: { start: draft.date.start || null, end: draft.date.end || null }, amount: { min: draft.amount.min === "" ? null : Number(draft.amount.min), max: draft.amount.max === "" ? null : Number(draft.amount.max) } };
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
      <button v-for="item in [['run', 'Overview'], ['rules', 'Rules'], ['explore', 'Explore']]" :key="item[0]" :class="{ on: tab === item[0] }" @click="tab = item[0]">{{ item[1] }}</button>
    </div>

    <div v-if="tab === 'run'">
      <div class="card spread">
        <div><strong>Analyse</strong><p class="small muted">Puts every transaction of this project's datasources into accounts by the rules, and builds running totals and monthly, quarterly and yearly figures.</p></div>
        <button class="primary" :disabled="!!jobId" @click="analyse"><Icon name="play" /> Analyse</button>
      </div>
      <JobProgress v-if="jobId" :job-id="jobId" @done="(job) => { jobId = null; jobDone(job); }" />
      <p v-if="status?.finishedAt" class="small muted">Last analysed {{ new Date(status.finishedAt).toLocaleString() }} · transactions up to {{ formatDate(status.lastDate) }}</p>
      <p v-for="warning in status?.warnings || []" :key="warning" class="small neg">{{ warning }}</p>
      <!-- Accounts under their categories; each category's total in bold, coloured by its type. -->
      <section v-for="group in summaryByCategory" :key="group.category.id" class="summary-category" :class="`type-${group.category.type}`">
        <div class="summary-head">
          <h3>{{ group.category.name }} <span class="badge">{{ group.category.type === "ignore" ? "ignored" : group.category.type }}</span></h3>
          <strong class="num category-total">{{ formatMoney(group.total, group.currency) }}</strong>
        </div>
        <ul class="list">
          <li v-for="item in group.items" :key="item.id" class="link" @click="historyAccount = item.id; tab = 'explore'">
            <div class="grow"><div class="title">{{ item.name }}</div><div class="sub">{{ item.count }} transactions<template v-if="item.first"> · {{ formatDate(item.first) }} – {{ formatDate(item.last) }}</template></div></div>
            <div class="num" :class="{ neg: item.running < 0 }">{{ formatMoney(item.running, currencyOf(item.id)) }}</div>
          </li>
        </ul>
      </section>
      <ul v-if="!accountSummary.length" class="list"><li class="empty">Not analysed yet</li></ul>
      <template v-if="status?.finishedAt">
        <div class="spread"><h2>Not matched by any rule <span class="badge">{{ unmatchedCount }}</span></h2><button v-if="rulesChanged" class="primary" :disabled="!!jobId" @click="analyse"><Icon name="play" /> Analyse again</button></div>
        <p class="muted small">These went to Uncategorised. Add a rule to put them (and others like them) into an account.</p>
        <TransactionList :key="unmatchedKey" :path="`${projectPath()}/unmatched`" :show-running="false" action-label="Add rule" @action="ruleFromTransaction" />
      </template>
    </div>

    <div v-if="tab === 'rules'">
      <div class="spread"><p class="small muted">The first enabled rule that matches wins (the number is its place). Anything unmatched goes to Uncategorised.</p><button class="primary" @click="newRule"><Icon name="plus" /> Rule</button></div>
      <div class="tabs" role="tablist" aria-label="Rules view">
        <button role="tab" :aria-selected="ruleView === 'tree'" :class="{ on: ruleView === 'tree' }" @click="ruleView = 'tree'">By account</button>
        <button role="tab" :aria-selected="ruleView === 'order'" :class="{ on: ruleView === 'order' }" @click="ruleView = 'order'">In order</button>
      </div>
      <!-- Category, then account, then the rules that move transactions there. -->
      <template v-if="ruleView === 'tree'">
        <section v-for="group in ruleTree" :key="group.category.id" class="rule-category">
          <h3>{{ group.category.name }}</h3>
          <div v-for="branch in group.accounts" :key="branch.account.id" class="rule-account">
            <h4>{{ branch.account.name }} <span class="muted small">{{ branch.rules.length }} {{ branch.rules.length === 1 ? "rule" : "rules" }}</span></h4>
            <ul class="list">
              <li v-for="rule in branch.rules" :key="rule.id" class="link rule-row" :class="{ disabled: !rule.enabled }" role="button" tabindex="0" :aria-label="`Edit rule ${rule.name}`" @click="editRule(rule)" @keyup.enter="editRule(rule)">
                <span class="badge" :title="`Rule ${rule.place} of ${rules.length}`">{{ rule.place }}</span>
                <div class="grow"><div class="title">{{ rule.name }} <span v-if="!rule.enabled" class="badge">off</span></div></div>
                <button class="icon ghost" aria-label="Clone" title="Clone" @click.stop="cloneRule(rule)"><Icon name="copy" /></button>
                <Icon name="chevron" />
              </li>
            </ul>
          </div>
        </section>
        <ul v-if="!rules.length" class="list"><li class="empty">No rules yet</li></ul>
      </template>
      <!-- The order rules are tried in: move one up or down to change which wins. -->
      <ul v-else class="list">
        <li v-for="(rule, index) in rules" :key="rule.id" class="link rule-row" :class="{ disabled: !rule.enabled }" role="button" tabindex="0" :aria-label="`Edit rule ${rule.name}`" @click="editRule(rule)" @keyup.enter="editRule(rule)">
          <span class="badge">{{ index + 1 }}</span>
          <div class="grow"><div class="title">{{ rule.name }} <span v-if="!rule.enabled" class="badge">off</span></div><div class="sub">→ {{ accountName(rule.account) }} <span class="muted">({{ categoryOf(rule.account) }})</span></div></div>
          <button class="icon ghost" :disabled="index === 0" aria-label="Move up" @click.stop="moveRule(index, -1)"><Icon name="up" /></button>
          <button class="icon ghost" :disabled="index === rules.length - 1" aria-label="Move down" @click.stop="moveRule(index, 1)"><Icon name="down" /></button>
          <button class="icon ghost" aria-label="Clone" @click.stop="cloneRule(rule)"><Icon name="copy" /></button>
        </li>
        <li v-if="!rules.length" class="empty">No rules yet</li>
      </ul>
    </div>

    <!-- Charts, history and aggregates in one place; an account picked on the Overview opens here. -->
    <Explore v-if="tab === 'explore' && project" :key="historyAccount || 'explore'" :accounts="accounts" :categories="project.categories" :initial-account="historyAccount" />

    <Sheet v-if="ruleDraft" :title="ruleDraft.id ? 'Edit rule' : 'New rule'" @close="ruleDraft = null">
      <div class="grid2">
        <label class="field"><span>Name</span><input v-model="ruleDraft.name" placeholder="Supermarkets" /></label>
        <div class="field">
          <span class="small muted" style="font-weight: 550">Into account</span>
          <div class="row" style="flex-wrap: nowrap">
            <select v-model="ruleDraft.account" aria-label="Into account"><option value="" disabled>Choose an account</option><optgroup v-for="group in accountsByCategory(accounts, project?.categories)" :key="group.category.id" :label="group.category.name"><option v-for="account in group.accounts" :key="account.id" :value="account.id">{{ account.name }}</option></optgroup></select>
            <button class="icon" aria-label="Add an account" title="Add an account" @click="addingAccount = true"><Icon name="plus" /></button>
          </div>
        </div>
      </div>
      <NewAccountForm v-if="addingAccount && project" :categories="project.categories" :currency="project.currency || 'NZD'" :name="ruleDraft.name" @created="accountAdded" @categories-changed="reloadProject" @cancel="addingAccount = false" />
      <label class="check"><input v-model="ruleDraft.enabled" type="checkbox" />Enabled</label>
      <p v-if="ruleDraft.example" class="card small">From: {{ ruleDraft.example.description }} · {{ formatDate(ruleDraft.example.date) }} · {{ formatMoney(ruleDraft.example.amount, ruleDraft.example.currency) }}</p>
      <h3>All of these</h3>
      <div v-for="(condition, index) in ruleDraft.conditions" :key="index" class="card">
        <div class="grid2">
          <select v-model="condition.field" aria-label="Field"><option v-for="field in FIELDS" :key="field[0]" :value="field[0]">{{ field[1] }}</option></select>
          <select v-model="condition.op" aria-label="Match"><option v-for="op in OPS" :key="op[0]" :value="op[0]">{{ op[1] }}</option></select>
        </div>
        <input v-model="condition.value" :placeholder="['containsall', 'containsany'].includes(condition.op) ? 'countdown, new world, pak n save' : 'text'" aria-label="Value" style="margin-top: 6px" />
        <div class="row"><label class="check small" title="Ticked: countdown matches COUNTDOWN"><input type="checkbox" :checked="!condition.caseSensitive" aria-label="Ignore case" @change="condition.caseSensitive = !$event.target.checked" />Ignore case</label><label class="check small"><input v-model="condition.not" type="checkbox" />Does not match</label><button class="danger" @click="ruleDraft.conditions.splice(index, 1)">Remove</button></div>
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
          <TxRow v-for="(tx, index) in testResult.transactions.slice(0, 15)" :key="index" :tx="tx" :actual="!!tx.takenBy"><template #details>{{ tx.account }}<template v-if="tx.takenBy"> · taken by {{ tx.takenBy }}</template></template></TxRow>
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
