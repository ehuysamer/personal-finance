<script setup>
import { computed, inject, onMounted, ref, watch } from "vue";
import { projectPath, toast } from "../state.js";
import Icon from "./Icon.vue";
import Sheet from "./Sheet.vue";
import LineChart from "./LineChart.vue";

// Saved charts of the project: pick one to view, edit or make a new one. With forecast set, the chart shows that
// forecast (and the actuals when includeActuals is on, greyed lines solid, forecast dotted).
const props = defineProps({ forecast: { type: String, default: null }, accounts: { type: Array, default: () => [] }, categories: { type: Array, default: () => [] } });
const api = inject("api");
const charts = ref([]);
const selected = ref(null);
const data = ref(null);
const error = ref("");
const draft = ref(null);
const includeActuals = ref(true);
const MEASURES = [["running", "Running total"], ["sum", "Total"], ["count", "Count"], ["avg", "Average"], ["min", "Minimum"], ["max", "Maximum"]];
const tags = computed(() => [...new Set(props.accounts.flatMap((account) => account.tags || []))]);

async function loadList() { charts.value = (await api.get(`${projectPath()}/charts`)).items; if (!selected.value && charts.value.length) selected.value = charts.value[0].id; }
async function loadData() {
  error.value = ""; data.value = null;
  if (!selected.value) return;
  try { data.value = await api.post(`${projectPath()}/chart-data`, { id: selected.value, forecast: props.forecast || "", includeActuals: props.forecast ? includeActuals.value : true }); }
  catch (failure) { error.value = failure.message; }
}
onMounted(async () => { try { await loadList(); } catch (failure) { error.value = failure.message; } });
watch([selected, includeActuals, () => props.forecast], loadData, { immediate: true });

function newChart() {
  const first = props.accounts.find((account) => account.shortCode) || props.accounts[0];
  draft.value = { name: "", bucket: "monthly", series: first ? [{ name: first.shortCode || "A", type: "account", ref: first.shortCode || first.id, measure: "running" }] : [] };
}
async function editChart() { draft.value = await api.get(`${projectPath()}/charts/${selected.value}`); }
function addSeries(type) {
  const n = draft.value.series.length + 1;
  draft.value.series.push(type === "calculate" ? { name: `CALC${n}`, type, expression: "" } : { name: `S${n}`, type, ref: type === "category" ? props.categories[0]?.id : type === "tag" ? tags.value[0] : (props.accounts[0]?.shortCode || props.accounts[0]?.id), measure: "running" });
}
async function save() {
  const { id, createdAt: _c, updatedAt: _u, ...body } = draft.value;
  try {
    const saved = id ? await api.put(`${projectPath()}/charts/${id}`, body) : await api.post(`${projectPath()}/charts`, body);
    draft.value = null; await loadList(); selected.value = saved.id; await loadData(); toast("Chart saved");
  } catch (failure) { error.value = failure.message; }
}
async function remove() { if (!confirm("Delete this chart?")) return; await api.del(`${projectPath()}/charts/${selected.value}`); selected.value = null; draft.value = null; await loadList(); await loadData(); }
</script>

<template>
  <div>
    <div class="row">
      <select v-model="selected" aria-label="Chart" style="flex: 1; min-width: 160px"><option v-for="chart in charts" :key="chart.id" :value="chart.id">{{ chart.name }}</option></select>
      <button class="icon" aria-label="Edit chart" :disabled="!selected" @click="editChart"><Icon name="edit" /></button>
      <button class="icon" aria-label="New chart" @click="newChart"><Icon name="plus" /></button>
    </div>
    <label v-if="forecast" class="check small"><input v-model="includeActuals" type="checkbox" />Include actuals</label>
    <p v-if="error" class="error">{{ error }}</p>
    <div v-if="data" class="card"><LineChart :data="data" /></div>
    <p v-else-if="!charts.length" class="muted small">No charts yet. Make one with +.</p>

    <Sheet v-if="draft" :title="draft.id ? 'Edit chart' : 'New chart'" @close="draft = null">
      <div class="grid2">
        <label class="field"><span>Name</span><input v-model="draft.name" placeholder="Income and spending" /></label>
        <label class="field"><span>Per</span><select v-model="draft.bucket"><option value="monthly">Month</option><option value="quarterly">Quarter</option><option value="yearly">Year</option></select></label>
        <label class="field"><span>From (optional)</span><input v-model="draft.start" type="date" /></label>
        <label class="field"><span>To (optional)</span><input v-model="draft.end" type="date" /></label>
      </div>
      <h3>Series</h3>
      <div v-for="(series, index) in draft.series" :key="index" class="card">
        <div class="grid2">
          <label class="field"><span>Name (used in formulas)</span><input v-model="series.name" /></label>
          <label class="field"><span>Type</span><select v-model="series.type"><option value="account">Account</option><option value="category">Category total</option><option value="tag">Tag total</option><option value="calculate">Formula</option></select></label>
          <label v-if="series.type === 'account'" class="field"><span>Account</span><select v-model="series.ref"><option v-for="account in accounts" :key="account.id" :value="account.shortCode || account.id">{{ account.name }}{{ account.shortCode ? ` (${account.shortCode})` : "" }}</option></select></label>
          <label v-if="series.type === 'category'" class="field"><span>Category</span><select v-model="series.ref"><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label>
          <label v-if="series.type === 'tag'" class="field"><span>Tag</span><select v-model="series.ref"><option v-for="tag in tags" :key="tag" :value="tag">{{ tag }}</option></select></label>
          <label v-if="series.type !== 'calculate'" class="field"><span>Measure</span><select v-model="series.measure"><option v-for="measure in MEASURES" :key="measure[0]" :value="measure[0]">{{ measure[1] }}</option></select></label>
          <label v-if="series.type === 'calculate'" class="field"><span>Formula (other series' names, + − × ÷, brackets)</span><input v-model="series.expression" placeholder="INC + EXP" /></label>
          <label class="field"><span>Colour</span><input v-model="series.color" type="color" /></label>
        </div>
        <div class="row"><label class="check small"><input v-model="series.hidden" type="checkbox" />Hidden (for formulas only)</label><button class="danger" @click="draft.series.splice(index, 1)">Remove</button></div>
      </div>
      <div class="row"><button @click="addSeries('account')"><Icon name="plus" /> Account</button><button @click="addSeries('category')"><Icon name="plus" /> Category</button><button @click="addSeries('tag')"><Icon name="plus" /> Tag</button><button @click="addSeries('calculate')"><Icon name="plus" /> Formula</button></div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="spread" style="margin-top: 12px"><button v-if="draft.id" class="danger" @click="remove">Delete chart</button><span v-else /><button class="primary" :disabled="!draft.name || !draft.series.length" @click="save">Save chart</button></div>
    </Sheet>
  </div>
</template>
