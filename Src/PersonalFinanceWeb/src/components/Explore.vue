<script setup>
import { computed, inject, onMounted, ref, watch } from "vue";
import { projectPath, toast } from "../state.js";
import { accountsByCategory, formatMoney } from "../lib/format.js";
import { colorFor } from "../lib/chart.js";
import Icon from "./Icon.vue";
import LineChart from "./LineChart.vue";
import ChartEditor from "./ChartEditor.vue";
import TransactionList from "./TransactionList.vue";
import TxRow from "./TxRow.vue";

// One place for charts, history and aggregates (in Analysis, and in Forecast with forecast set). The settings at the
// top choose what to look at (a saved chart, or one account), the period (day to year) and dates; then the user
// flips between the Chart, its History (the transactions behind it) and its Aggregates (a row per period, each
// opening to the transactions that made it).
const props = defineProps({ forecast: { type: String, default: null }, accounts: { type: Array, default: () => [] }, categories: { type: Array, default: () => [] }, initialAccount: { type: String, default: null } });
const api = inject("api");
const BUCKETS = [["daily", "Day"], ["weekly", "Week"], ["monthly", "Month"], ["quarterly", "Quarter"], ["yearly", "Year"]];
const charts = ref([]);
// "chart:<id>" or "account:<id>".
const choice = ref(props.initialAccount ? `account:${props.initialAccount}` : "");
const savedChart = ref(null);
const bucket = ref("monthly");
const from = ref("");
const to = ref("");
const includeActuals = ref(true);
const view = ref("chart");
const data = ref(null);
const error = ref("");
const editing = ref(null);
const open = ref({});

async function loadCharts() { charts.value = (await api.get(`${projectPath()}/charts`)).items; }
onMounted(async () => {
  try {
    await loadCharts();
    if (!choice.value) choice.value = charts.value.length ? `chart:${charts.value[0].id}` : props.accounts[0] ? `account:${props.accounts[0].id}` : "";
  } catch (failure) { error.value = failure.message; }
});

// The definition being explored: the saved chart, or a one-account chart (its running total and total).
const definition = computed(() => {
  if (choice.value.startsWith("chart:")) return savedChart.value;
  const account = props.accounts.find((item) => `account:${item.id}` === choice.value);
  return account ? { name: account.name, bucket: bucket.value, series: [{ name: "BAL", label: `${account.name} running total`, type: "account", ref: account.id, measure: "running", axis: "left" }, { name: "TOT", label: `${account.name} per period`, type: "account", ref: account.id, measure: "sum", axis: "right" }] } : null;
});
const singleAccount = computed(() => choice.value.startsWith("account:"));
watch(choice, async (value) => {
  savedChart.value = null; open.value = {};
  if (value.startsWith("chart:")) {
    try { savedChart.value = await api.get(`${projectPath()}/charts/${value.slice(6)}`); bucket.value = savedChart.value.bucket || "monthly"; } catch (failure) { error.value = failure.message; }
  }
});
const request = computed(() => definition.value && ({ chart: { ...definition.value, bucket: bucket.value, start: from.value || null, end: to.value || null }, forecast: props.forecast || "", includeActuals: props.forecast ? includeActuals.value : true }));
async function load() {
  error.value = ""; open.value = {};
  if (!request.value) { data.value = null; return; }
  try { data.value = await api.post(`${projectPath()}/chart-data`, request.value); } catch (failure) { error.value = failure.message; data.value = null; }
}
watch(() => JSON.stringify(request.value), load, { immediate: true });

// Aggregates: newest period first; a row opens to the transactions behind it.
const rows = computed(() => (data.value?.buckets || []).map((period, i) => ({ period, i })).reverse());
const behind = ref({});
async function toggle(period) {
  if (open.value[period]) { open.value = { ...open.value, [period]: false }; return; }
  open.value = { ...open.value, [period]: true };
  if (!behind.value[period]) {
    behind.value = { ...behind.value, [period]: { loading: true, items: [] } };
    try { behind.value = { ...behind.value, [period]: await api.post(`${projectPath()}/chart-transactions`, { ...request.value, period, pageSize: 200 }) }; }
    catch (failure) { behind.value = { ...behind.value, [period]: { error: failure.message, items: [] } }; }
  }
}
watch(request, () => { behind.value = {}; });
const cell = (series, i) => {
  const actual = series.actual?.[i];
  const forecast = series.forecast?.[i];
  return { actual: actual ?? null, forecast: forecast ?? null };
};

async function saved(chart) { editing.value = null; await loadCharts(); choice.value = `chart:${chart.id}`; savedChart.value = chart; await load(); }
async function deleted() { editing.value = null; await loadCharts(); choice.value = charts.value.length ? `chart:${charts.value[0].id}` : props.accounts[0] ? `account:${props.accounts[0].id}` : ""; toast("Chart deleted"); }
</script>

<template>
  <div>
    <div class="card">
      <div class="row" style="flex-wrap: nowrap">
        <select v-model="choice" aria-label="Show" style="flex: 1; min-width: 0">
          <optgroup v-if="charts.length" label="Charts"><option v-for="chart in charts" :key="chart.id" :value="`chart:${chart.id}`">{{ chart.name }}</option></optgroup>
          <optgroup v-for="group in accountsByCategory(accounts, categories)" :key="group.category.id" :label="`Accounts: ${group.category.name}`"><option v-for="account in group.accounts" :key="account.id" :value="`account:${account.id}`">{{ account.name }}</option></optgroup>
        </select>
        <button class="icon" aria-label="Edit chart" title="Edit chart" :disabled="!savedChart" @click="editing = savedChart"><Icon name="edit" /></button>
        <button class="icon" aria-label="New chart" title="New chart" @click="editing = {}"><Icon name="plus" /></button>
      </div>
      <div class="grid2" style="margin-top: 6px">
        <label class="field"><span>Per</span><select v-model="bucket" aria-label="Period"><option v-for="item in BUCKETS" :key="item[0]" :value="item[0]">{{ item[1] }}</option></select></label>
        <div class="row" style="flex-wrap: nowrap">
          <label class="field" style="flex: 1"><span>From</span><input v-model="from" type="date" aria-label="From" /></label>
          <label class="field" style="flex: 1"><span>To</span><input v-model="to" type="date" aria-label="To" /></label>
        </div>
      </div>
      <label v-if="forecast" class="check small"><input v-model="includeActuals" type="checkbox" />Include actuals (solid and greyed; the forecast is dotted)</label>
    </div>

    <div class="tabs" role="tablist" aria-label="View">
      <button v-for="item in [['chart', 'Chart'], ['history', 'History'], ['aggregates', 'Aggregates']]" :key="item[0]" role="tab" :aria-selected="view === item[0]" :class="{ on: view === item[0] }" @click="view = item[0]">{{ item[1] }}</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="view === 'chart'">
      <div v-if="data?.buckets?.length" class="card"><LineChart :data="data" /></div>
      <p v-else-if="data" class="muted small">Nothing to chart yet: run Analyse{{ forecast ? " and the forecast" : "" }}.</p>
    </div>

    <TransactionList v-if="view === 'history' && request" :path="`${projectPath()}/chart-transactions`" :body="request" :show-running="singleAccount" :grey-actuals="!!forecast && includeActuals" />

    <div v-if="view === 'aggregates' && data">
      <ul class="list">
        <li v-for="row in rows" :key="row.period" style="flex-direction: column; align-items: stretch">
          <button class="ghost aggregate-row" :aria-expanded="!!open[row.period]" :aria-label="`${row.period} transactions`" @click="toggle(row.period)">
            <span class="title">{{ row.period }}</span>
            <span class="aggregate-values">
              <span v-for="(series, index) in data.series" :key="series.name" class="num small">
                <span :style="{ color: colorFor(series, index) }" class="series-name">{{ series.label }}</span>
                <template v-if="cell(series, row.i).actual !== null"> {{ formatMoney(cell(series, row.i).actual, series.currency) }}</template>
                <template v-if="cell(series, row.i).forecast !== null"> <em class="muted">forecast</em> {{ formatMoney(cell(series, row.i).forecast, series.currency) }}</template>
              </span>
            </span>
            <Icon :name="open[row.period] ? 'up' : 'down'" />
          </button>
          <div v-if="open[row.period]" class="behind">
            <p v-if="behind[row.period]?.loading" class="muted small">Loading…</p>
            <p v-else-if="behind[row.period]?.error" class="error">{{ behind[row.period].error }}</p>
            <ul v-else class="list">
              <TxRow v-for="(tx, index) in behind[row.period]?.items || []" :key="index" :tx="tx" :actual="!!forecast && includeActuals && tx.kind === 'actual'">
                <template #details>{{ tx.seriesLabel }}<template v-if="tx.accountName !== tx.seriesLabel"> ({{ tx.accountName }})</template><template v-if="forecast"> · {{ tx.kind }}</template></template>
              </TxRow>
              <li v-if="!(behind[row.period]?.items || []).length" class="empty">No transactions (a running total carried over)</li>
              <li v-if="behind[row.period]?.total > (behind[row.period]?.items || []).length" class="empty">{{ behind[row.period].total - behind[row.period].items.length }} more: see History</li>
            </ul>
          </div>
        </li>
        <li v-if="!rows.length" class="empty">Nothing yet: run Analyse{{ forecast ? " and the forecast" : "" }}.</li>
      </ul>
    </div>

    <ChartEditor v-if="editing" :chart="editing.id ? editing : null" :accounts="accounts" :categories="categories" @saved="saved" @deleted="deleted" @close="editing = null" />
  </div>
</template>
