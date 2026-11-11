<script setup>
import { computed, inject, ref } from "vue";
import { projectPath, toast } from "../state.js";
import { accountsByCategory, categoryName } from "../lib/format.js";
import Icon from "./Icon.vue";
import Sheet from "./Sheet.vue";

// A chart's definition in a pop-up: name, default period, axis titles, and its series. A series is one account,
// several accounts added up, a category or tag total, or a formula over other series; each has a label and an axis
// (left, right, or virtual: its own scale over the chart's height). Emits saved (the chart) or deleted.
const props = defineProps({ chart: { type: Object, default: null }, accounts: { type: Array, default: () => [] }, categories: { type: Array, default: () => [] } });
const emit = defineEmits(["saved", "deleted", "close"]);
const api = inject("api");
const MEASURES = [["running", "Running total"], ["sum", "Total"], ["count", "Count"], ["avg", "Average"], ["min", "Minimum"], ["max", "Maximum"]];
const BUCKETS = [["daily", "Day"], ["weekly", "Week"], ["monthly", "Month"], ["quarterly", "Quarter"], ["yearly", "Year"]];
const AXES = [["left", "Left axis"], ["right", "Right axis"], ["virtual", "Own scale (no axis)"]];
const MULTI = ["accounts", "categories", "categoryTypes"];
const TYPES = [["income", "Income"], ["expense", "Expenses"], ["asset", "Assets"], ["liability", "Liabilities"], ["ignore", "Ignored (transfers)"]];
// The accounts a by-type or several-categories series adds up, shown under its tick boxes.
function includedAccounts(series) {
  const ids = series.type === "categoryTypes" ? props.categories.filter((category) => series.refs.includes(category.type)).map((category) => category.id) : series.refs;
  return props.accounts.filter((account) => ids.includes(account.category));
}
const tags = computed(() => [...new Set(props.accounts.flatMap((account) => account.tags || []))]);
const refOf = (account) => account.shortCode || account.id;
const first = props.accounts.find((account) => account.shortCode) || props.accounts[0];
const draft = ref(props.chart ? JSON.parse(JSON.stringify(props.chart)) : { name: "", bucket: "monthly", series: first ? [{ name: first.shortCode || "A", label: first.name, type: "account", ref: refOf(first), measure: "running", axis: "left" }] : [] });
for (const series of draft.value.series) { series.axis ||= "left"; if (MULTI.includes(series.type)) series.refs ||= []; }
const error = ref("");

function addSeries(type) {
  const n = draft.value.series.length + 1;
  const base = { name: type === "calculate" ? `CALC${n}` : `S${n}`, label: "", type, axis: "left" };
  if (type === "calculate") draft.value.series.push({ ...base, expression: "" });
  else if (["accounts", "categories", "categoryTypes"].includes(type)) draft.value.series.push({ ...base, refs: [], measure: "running" });
  else draft.value.series.push({ ...base, ref: type === "category" ? props.categories[0]?.id : type === "tag" ? tags.value[0] : (first ? refOf(first) : ""), measure: "running" });
}
function toggleRef(series, ref) { series.refs = series.refs.includes(ref) ? series.refs.filter((item) => item !== ref) : [...series.refs, ref]; }
async function save() {
  error.value = "";
  const { id, createdAt: _c, updatedAt: _u, ...body } = draft.value;
  body.series = body.series.map((series) => ({ ...series, label: series.label || null }));
  try {
    const saved = id ? await api.put(`${projectPath()}/charts/${id}`, body) : await api.post(`${projectPath()}/charts`, body);
    toast("Chart saved");
    emit("saved", saved);
  } catch (failure) { error.value = failure.message; }
}
async function remove() {
  if (!confirm(`Delete the chart ${draft.value.name}?`)) return;
  await api.del(`${projectPath()}/charts/${draft.value.id}`);
  emit("deleted", draft.value.id);
}
</script>

<template>
  <Sheet :title="draft.id ? 'Edit chart' : 'New chart'" @close="emit('close')">
    <div class="grid2">
      <label class="field"><span>Name</span><input v-model="draft.name" placeholder="Income and spending" /></label>
      <label class="field"><span>Per</span><select v-model="draft.bucket"><option v-for="bucket in BUCKETS" :key="bucket[0]" :value="bucket[0]">{{ bucket[1] }}</option></select></label>
      <label class="field"><span>Left axis title (optional)</span><input v-model="draft.leftLabel" placeholder="Spending" /></label>
      <label class="field"><span>Right axis title (optional)</span><input v-model="draft.rightLabel" placeholder="Income" /></label>
    </div>
    <h3>Series</h3>
    <div v-for="(series, index) in draft.series" :key="index" class="card">
      <div class="grid2">
        <label class="field"><span>Label</span><input v-model="series.label" :placeholder="series.name" aria-label="Series label" /></label>
        <label class="field"><span>Name (used in formulas)</span><input v-model="series.name" aria-label="Series name" /></label>
        <label class="field"><span>Type</span><select v-model="series.type" aria-label="Series type" @change="MULTI.includes(series.type) ? (series.refs = series.type === 'accounts' && series.ref ? [series.ref] : series.type === 'categories' && series.ref ? [series.ref] : []) : null"><option value="account">Account</option><option value="accounts">Several accounts (added up)</option><option value="category">Category total</option><option value="categories">Several categories (added up)</option><option value="categoryTypes">By category type (e.g. all assets)</option><option value="tag">Tag total</option><option value="calculate">Formula</option></select></label>
        <label class="field"><span>Axis</span><select v-model="series.axis" aria-label="Series axis"><option v-for="axis in AXES" :key="axis[0]" :value="axis[0]">{{ axis[1] }}</option></select></label>
        <label v-if="series.type === 'account'" class="field"><span>Account</span><select v-model="series.ref" aria-label="Series account"><optgroup v-for="group in accountsByCategory(accounts, categories)" :key="group.category.id" :label="group.category.name"><option v-for="account in group.accounts" :key="account.id" :value="refOf(account)">{{ account.name }}{{ account.shortCode ? ` (${account.shortCode})` : "" }}</option></optgroup></select></label>
        <label v-if="series.type === 'category'" class="field"><span>Category</span><select v-model="series.ref"><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label>
        <label v-if="series.type === 'tag'" class="field"><span>Tag</span><select v-model="series.ref"><option v-for="tag in tags" :key="tag" :value="tag">{{ tag }}</option></select></label>
        <label v-if="series.type !== 'calculate'" class="field"><span>Measure</span><select v-model="series.measure"><option v-for="measure in MEASURES" :key="measure[0]" :value="measure[0]">{{ measure[1] }}</option></select></label>
        <label v-if="series.type === 'calculate'" class="field"><span>Formula (other series' names, + − × ÷, brackets)</span><input v-model="series.expression" placeholder="INC + EXP" /></label>
        <label class="field"><span>Colour</span><input v-model="series.color" type="color" /></label>
      </div>
      <fieldset v-if="series.type === 'accounts'" class="card" style="margin: 6px 0">
        <legend class="small">Accounts to add up ({{ series.refs.length }})</legend>
        <label v-for="account in accounts" :key="account.id" class="check"><input type="checkbox" :checked="series.refs.includes(refOf(account))" @change="toggleRef(series, refOf(account))" />{{ account.name }} <span class="muted small">{{ categoryName(account, categories) }}</span></label>
      </fieldset>
      <fieldset v-if="series.type === 'categories'" class="card" style="margin: 6px 0">
        <legend class="small">Categories to add up ({{ series.refs.length }})</legend>
        <label v-for="category in categories" :key="category.id" class="check"><input type="checkbox" :checked="series.refs.includes(category.id)" @change="toggleRef(series, category.id)" />{{ category.name }} <span class="muted small">{{ category.type }}</span></label>
      </fieldset>
      <fieldset v-if="series.type === 'categoryTypes'" class="card" style="margin: 6px 0">
        <legend class="small">Category types to add up</legend>
        <label v-for="type in TYPES" :key="type[0]" class="check"><input type="checkbox" :checked="series.refs.includes(type[0])" @change="toggleRef(series, type[0])" />{{ type[1] }}</label>
      </fieldset>
      <p v-if="['categories', 'categoryTypes'].includes(series.type) && series.refs.length" class="small muted included">Adds up {{ includedAccounts(series).length }} accounts: {{ includedAccounts(series).map((account) => account.name).join(", ") || "none yet" }}</p>
      <div class="row"><label class="check small"><input v-model="series.hidden" type="checkbox" />Hidden (for formulas only)</label><button class="danger" @click="draft.series.splice(index, 1)">Remove</button></div>
    </div>
    <div class="row"><button @click="addSeries('account')"><Icon name="plus" /> Account</button><button @click="addSeries('accounts')"><Icon name="plus" /> Several accounts</button><button @click="addSeries('category')"><Icon name="plus" /> Category</button><button @click="addSeries('categories')"><Icon name="plus" /> Several categories</button><button @click="addSeries('categoryTypes')"><Icon name="plus" /> Category type</button><button @click="addSeries('tag')"><Icon name="plus" /> Tag</button><button @click="addSeries('calculate')"><Icon name="plus" /> Formula</button></div>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="spread" style="margin-top: 12px"><button v-if="draft.id" class="danger" @click="remove">Delete chart</button><span v-else /><button class="primary" :disabled="!draft.name || !draft.series.length" @click="save">Save chart</button></div>
  </Sheet>
</template>
