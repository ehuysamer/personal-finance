<script setup>
import { computed, inject, onMounted, ref, watch } from "vue";
import { go, projectPath, state, toast } from "../state.js";
import { describeFrequency, formatDate, formatMoney, formatPercent, isFrequency } from "../lib/format.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";
import Explore from "../components/Explore.vue";
import JobProgress from "../components/JobProgress.vue";

const api = inject("api");
const METHODS = [["replay+trend", "Replay recurring + trend (default)"], ["trend", "Trend only"], ["average", "Average month"], ["last", "Last month"], ["fixed", "Fixed amount per month"], ["none", "Nothing"]];
const GENERATORS = [["random", "Random between"], ["sine", "Sine wave"], ["linear", "Linear over time"], ["minimum", "Minimum (floor)"], ["maximum", "Maximum (cap)"]];
const forecasts = ref([]);
const project = ref(null);
const accounts = ref([]);
const current = computed(() => state.route.parts[0] || null);
const definition = ref(null);
const results = ref(null);
const tab = ref("overview");
const draft = ref(null);
const jobId = ref(null);
const error = ref("");

async function loadList() {
  const [list, p, a] = await Promise.all([api.get(`${projectPath()}/forecasts`), api.get(projectPath()), api.get(`${projectPath()}/accounts`)]);
  forecasts.value = list.items; project.value = p; accounts.value = a.items;
}
async function loadCurrent() {
  error.value = ""; definition.value = null; results.value = null;
  if (!current.value) return;
  try {
    definition.value = await api.get(`${projectPath()}/forecasts/${current.value}`);
    results.value = await api.get(`${projectPath()}/forecasts/${current.value}/results`);
    const running = (await api.get(`${projectPath()}/jobs`)).items.find((job) => job.type === "forecast" && job.name === current.value && ["queued", "running"].includes(job.status));
    jobId.value = running?.id || null;
  } catch (failure) { error.value = failure.message; }
}
onMounted(async () => { try { await loadList(); } catch (failure) { error.value = failure.message; } });
watch(current, loadCurrent, { immediate: true });

const accountName = (id) => accounts.value.find((account) => account.id === id)?.name || id;
function blank() { return { name: "", frequency: "1m", horizon: { type: "duration", value: "10y" }, lookbackYears: 3, settings: { replay: true, seasonality: true, noise: false, maxGrowth: 0.25 }, inflation: {}, accounts: {}, generators: [] }; }
// Inflation and growth are edited in percent; the API keeps fractions.
function toDraft(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  copy.generators = copy.generators.map((generator) => ({ ...generator, start: whenText(generator.start), end: whenText(generator.end) }));
  copy.inflationPercent = Object.fromEntries((project.value?.categories || []).map((category) => [category.id, copy.inflation[category.id] !== undefined ? copy.inflation[category.id] * 100 : ""]));
  copy.accountRows = accounts.value.map((account) => { const own = copy.accounts[account.id] || copy.accounts[account.shortCode] || {}; return { id: account.id, method: own.method || "replay+trend", inflation: own.inflation !== undefined ? own.inflation * 100 : "", growth: own.growth !== undefined && own.growth !== null ? own.growth * 100 : "", value: own.value ?? "", formula: own.formula || "", start: whenText(own.start), end: whenText(own.end) }; });
  return copy;
}
const whenText = (value) => (!value ? "" : typeof value === "string" ? value : value.age !== undefined ? `age ${value.age}` : value.date || "");
const parseWhen = (text) => { const value = String(text || "").trim(); if (!value) return undefined; const age = value.match(/^age\s+(\d+(\.\d+)?)$/i); return age ? { age: Number(age[1]) } : value; };
function fromDraft(copy) {
  const body = { name: copy.name, frequency: copy.frequency, horizon: { type: copy.horizon.type, value: copy.horizon.type === "age" ? Number(copy.horizon.value) : copy.horizon.value }, lookbackYears: Number(copy.lookbackYears), settings: { ...copy.settings, maxGrowth: Number(copy.settings.maxGrowth) }, seed: copy.seed, generators: copy.generators.map((generator) => ({ ...generator, start: parseWhen(generator.start), end: parseWhen(generator.end) })) };
  body.inflation = Object.fromEntries(Object.entries(copy.inflationPercent).filter(([, value]) => value !== "" && value !== null).map(([key, value]) => [key, Number(value) / 100]));
  body.accounts = Object.fromEntries(copy.accountRows.map((row) => {
    const own = {};
    if (row.method !== "replay+trend") own.method = row.method;
    if (row.inflation !== "") own.inflation = Number(row.inflation) / 100;
    if (row.growth !== "") own.growth = Number(row.growth) / 100;
    if (row.method === "fixed" && row.value !== "") own.value = Number(row.value);
    if (row.formula) own.formula = row.formula;
    if (row.start) own.start = parseWhen(row.start);
    if (row.end) own.end = parseWhen(row.end);
    return [row.id, own];
  }).filter(([, own]) => Object.keys(own).length));
  return body;
}
function newForecast() { draft.value = toDraft(blank()); }
function editForecast() { draft.value = toDraft(definition.value); }
async function save() {
  error.value = "";
  if (!isFrequency(draft.value.frequency)) { error.value = "Frequency is a number and d, w, m, q or y (1d, 1w, 6m)"; return; }
  try {
    const body = fromDraft(draft.value);
    const saved = draft.value.id ? await api.put(`${projectPath()}/forecasts/${draft.value.id}`, body) : await api.post(`${projectPath()}/forecasts`, body);
    draft.value = null; toast("Forecast saved"); await loadList();
    if (current.value === saved.id) await loadCurrent(); else go("forecast", saved.id);
  } catch (failure) { error.value = failure.message; }
}
async function cloneForecast() { const name = prompt("Name of the copy", `${definition.value.name} (copy)`); if (!name) return; const copy = await api.post(`${projectPath()}/forecasts/${current.value}/clone`, { name }); await loadList(); go("forecast", copy.id); }
async function deleteForecast() { if (!confirm(`Delete forecast ${definition.value.name}?`)) return; await api.del(`${projectPath()}/forecasts/${current.value}`); await loadList(); go("forecast"); }
async function run() { error.value = ""; try { jobId.value = (await api.post(`${projectPath()}/forecasts/${current.value}/run`)).id; } catch (failure) { error.value = failure.message; } }
async function done(job) { jobId.value = null; toast(`Forecast ${job.status}`); await loadCurrent(); }
const horizonText = (horizon) => (horizon.type === "age" ? `until age ${horizon.value}` : horizon.type === "date" ? `until ${formatDate(horizon.value)}` : `for ${horizon.value}`);
const models = computed(() => Object.entries(results.value?.model?.accounts || {}).map(([id, terms]) => ({ id, name: accountName(id), ...terms })));
</script>

<template>
  <section v-if="!current">
    <div class="spread"><h1>Forecasts</h1><button class="primary" @click="newForecast"><Icon name="plus" /> New</button></div>
    <p class="muted small">A forecast replays and projects the analysed accounts into the future. Run Analysis first.</p>
    <p v-if="error" class="error">{{ error }}</p>
    <ul class="list">
      <li v-for="item in forecasts" :key="item.id" class="link" @click="go('forecast', item.id)">
        <div class="grow"><div class="title">{{ item.name }}</div><div class="sub">{{ describeFrequency(item.frequency) }} · {{ horizonText(item.horizon) }}</div></div><Icon name="chevron" />
      </li>
      <li v-if="!forecasts.length" class="empty">No forecasts yet</li>
    </ul>
  </section>

  <section v-else-if="definition">
    <div class="spread">
      <button class="ghost" @click="go('forecast')"><Icon name="back" /> Forecasts</button>
      <div class="row"><button class="icon ghost" aria-label="Edit" @click="editForecast"><Icon name="edit" /></button><button class="icon ghost" aria-label="Clone" @click="cloneForecast"><Icon name="copy" /></button><button class="icon ghost" aria-label="Delete" @click="deleteForecast"><Icon name="trash" /></button></div>
    </div>
    <h1>{{ definition.name }}</h1>
    <p class="small muted">{{ describeFrequency(definition.frequency) }} · {{ horizonText(definition.horizon) }} · lookback {{ definition.lookbackYears }} years<template v-if="definition.generators.length"> · {{ definition.generators.length }} generators</template></p>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="tabs" role="tablist">
      <button v-for="item in [['overview', 'Overview'], ['explore', 'Explore'], ['model', 'Model']]" :key="item[0]" :class="{ on: tab === item[0] }" @click="tab = item[0]">{{ item[1] }}</button>
    </div>

    <div v-if="tab === 'overview'">
      <div class="card spread">
        <div><strong>Run forecast</strong><p class="small muted"><template v-if="results?.run?.finishedAt">Last run {{ new Date(results.run.finishedAt).toLocaleString() }}: {{ formatDate(results.run.start) }} to {{ formatDate(results.run.end) }}, {{ results.run.periods }} periods.</template><template v-else>Not run yet.</template><template v-if="results?.run?.definitionUpdatedAt && results.run.definitionUpdatedAt !== definition.updatedAt"> The definition changed since; run it again.</template></p></div>
        <button class="primary" :disabled="!!jobId" @click="run"><Icon name="play" /> Run</button>
      </div>
      <JobProgress v-if="jobId" :job-id="jobId" @done="done" />
    </div>

    <Explore v-if="tab === 'explore' && project" :key="current" :forecast="current" :accounts="accounts" :categories="project.categories" />

    <div v-if="tab === 'model'">
      <p class="small muted">What the forecast found per account at its last run: base (real money per month, today's prices), growth after inflation, recurring transactions it replays.</p>
      <ul class="list">
        <li v-for="item in models" :key="item.id" style="flex-wrap: wrap">
          <div class="grow"><div class="title">{{ item.name }}</div><div class="sub">{{ item.method }} · base {{ formatMoney(item.base) }}/month · growth {{ formatPercent(item.g) }} · inflation {{ formatPercent(item.inflation) }}<template v-if="item.seasonality"> · seasonal</template> · spread {{ formatMoney(item.sigma) }}</div>
            <div v-for="recurring in item.recurring" :key="recurring.key" class="sub">↻ {{ recurring.description }}: {{ formatMoney(recurring.amount) }} {{ recurring.cadence }}</div>
          </div>
        </li>
        <li v-if="!models.length" class="empty">Run the forecast to see its model</li>
      </ul>
    </div>
  </section>

  <Sheet v-if="draft" :title="draft.id ? 'Edit forecast' : 'New forecast'" @close="draft = null">
    <label class="field"><span>Name</span><input v-model="draft.name" placeholder="Base case" /></label>
    <div class="grid2">
      <label class="field"><span>Frequency ({{ describeFrequency(draft.frequency) }})</span><input v-model="draft.frequency" placeholder="1m" /></label>
      <label class="field"><span>Lookback (years of history)</span><input v-model="draft.lookbackYears" type="number" min="0.5" step="0.5" /></label>
      <label class="field"><span>Horizon</span><select v-model="draft.horizon.type"><option value="duration">For a time</option><option value="date">Until a date</option><option value="age">Until an age</option></select></label>
      <label class="field"><span>{{ draft.horizon.type === "duration" ? "Time (90d, 10y)" : draft.horizon.type === "date" ? "Date" : "Age" }}</span><input v-model="draft.horizon.value" :type="draft.horizon.type === 'date' ? 'date' : 'text'" /></label>
    </div>
    <div class="card">
      <label class="check"><input v-model="draft.settings.replay" type="checkbox" />Replay recurring transactions</label>
      <label class="check"><input v-model="draft.settings.seasonality" type="checkbox" />Seasonality (with 2+ years of history)</label>
      <label class="check"><input v-model="draft.settings.noise" type="checkbox" />Add noise within the past min/max band</label>
      <label class="field"><span>Largest growth per year (fraction)</span><input v-model="draft.settings.maxGrowth" type="number" step="0.01" /></label>
    </div>
    <h3>Inflation per category (% per year; empty uses the project's)</h3>
    <div class="grid2">
      <label v-for="category in project.categories" :key="category.id" class="field"><span>{{ category.name }} ({{ formatPercent(category.inflation) }})</span><input v-model="draft.inflationPercent[category.id]" type="number" step="0.1" inputmode="decimal" /></label>
    </div>
    <h3>Accounts</h3>
    <p class="small muted">Formula: the period's total. Names: value (model), replay, base, g, s, i, t (years ahead), age, and other accounts' short codes. Start and end: a date or "age 65".</p>
    <details v-for="row in draft.accountRows" :key="row.id" class="card">
      <summary>{{ accountName(row.id) }} <span class="muted small">{{ row.method }}{{ row.formula ? " · formula" : "" }}</span></summary>
      <div class="grid2">
        <label class="field"><span>Method</span><select v-model="row.method"><option v-for="method in METHODS" :key="method[0]" :value="method[0]">{{ method[1] }}</option></select></label>
        <label v-if="row.method === 'fixed'" class="field"><span>Amount per month</span><input v-model="row.value" type="number" step="0.01" /></label>
        <label class="field"><span>Inflation % (override)</span><input v-model="row.inflation" type="number" step="0.1" /></label>
        <label class="field"><span>Real growth % per year (override)</span><input v-model="row.growth" type="number" step="0.1" /></label>
        <label class="field"><span>Formula</span><input v-model="row.formula" placeholder="replay + value * 1.05" /></label>
        <label class="field"><span>Starts</span><input v-model="row.start" placeholder="yyyy-mm-dd or age 30" /></label>
        <label class="field"><span>Ends</span><input v-model="row.end" placeholder="yyyy-mm-dd or age 65" /></label>
      </div>
    </details>
    <h3>Generators</h3>
    <div v-for="(generator, index) in draft.generators" :key="index" class="card">
      <div class="grid2">
        <label class="field"><span>Name</span><input v-model="generator.name" /></label>
        <label class="field"><span>Type</span><select v-model="generator.type"><option v-for="type in GENERATORS" :key="type[0]" :value="type[0]">{{ type[1] }}</option></select></label>
        <label class="field"><span>Account</span><select v-model="generator.account"><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }}</option></select></label>
        <label v-if="!['minimum', 'maximum'].includes(generator.type)" class="field"><span>Frequency (empty: the forecast's)</span><input v-model="generator.frequency" placeholder="1m" /></label>
        <template v-if="generator.type === 'random'"><label class="field"><span>Min</span><input v-model.number="generator.min" type="number" /></label><label class="field"><span>Max</span><input v-model.number="generator.max" type="number" /></label></template>
        <template v-if="generator.type === 'sine'"><label class="field"><span>Amplitude</span><input v-model.number="generator.amplitude" type="number" /></label><label class="field"><span>Period (days)</span><input v-model.number="generator.periodDays" type="number" /></label><label class="field"><span>Phase (radians)</span><input v-model.number="generator.phase" type="number" step="0.1" /></label><label class="field"><span>Offset</span><input v-model.number="generator.offset" type="number" /></label></template>
        <template v-if="generator.type === 'linear'"><label class="field"><span>From</span><input v-model.number="generator.from" type="number" /></label><label class="field"><span>To (at the end; or slope)</span><input v-model.number="generator.to" type="number" /></label><label class="field"><span>Slope per year</span><input v-model.number="generator.slopePerYear" type="number" /></label></template>
        <label v-if="['minimum', 'maximum'].includes(generator.type)" class="field"><span>Value per period</span><input v-model.number="generator.value" type="number" /></label>
        <label class="field"><span>Starts</span><input v-model="generator.start" placeholder="yyyy-mm-dd or age 30" /></label>
        <label class="field"><span>Ends</span><input v-model="generator.end" placeholder="yyyy-mm-dd or age 65" /></label>
      </div>
      <button class="danger" @click="draft.generators.splice(index, 1)">Remove</button>
    </div>
    <button @click="draft.generators.push({ name: `Generator ${draft.generators.length + 1}`, type: 'random', account: accounts[0]?.id, min: 0, max: 100 })"><Icon name="plus" /> Generator</button>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row end" style="margin-top: 12px"><button class="primary" :disabled="!draft.name" @click="save">Save forecast</button></div>
  </Sheet>
</template>
