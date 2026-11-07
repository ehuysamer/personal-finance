<script setup>
import { inject, ref, watch } from "vue";
import { formatDate, formatMoney } from "../lib/format.js";

// A paged transaction list (newest first by default). path is the API route; params are added to every call.
// Actual rows are greyed when a forecast is shown with its actuals.
const props = defineProps({ path: { type: String, required: true }, params: { type: Object, default: () => ({}) }, showRunning: { type: Boolean, default: true }, greyActuals: { type: Boolean, default: false }, actionLabel: { type: String, default: "" } });
// actionLabel adds a button to each row that emits action with the transaction (e.g. "Add rule").
const emit = defineEmits(["action"]);
const api = inject("api");
const page = ref(1);
const order = ref("desc");
const sort = ref("date");
const q = ref("");
const result = ref({ items: [], total: 0, pages: 0 });
const error = ref("");
const loading = ref(false);

async function load() {
  loading.value = true; error.value = "";
  try { result.value = await api.get(props.path, { ...props.params, page: page.value, pageSize: 50, order: order.value, sort: sort.value, q: q.value }); }
  catch (failure) { error.value = failure.message; }
  loading.value = false;
}
watch(() => [props.path, JSON.stringify(props.params)], () => { page.value = 1; load(); }, { immediate: true });
let timer;
function search() { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; load(); }, 300); }
function source(tx) {
  if (tx.source === "import") return tx.filename ? `${tx.filename}, row ${tx.row}` : "imported";
  if (tx.source === "replay") return `replayed (${tx.cadence})`;
  return tx.source || "";
}
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 8px">
      <input v-model="q" type="search" placeholder="Search descriptions" aria-label="Search" style="flex: 1; min-width: 160px" @input="search" />
      <select v-model="sort" aria-label="Sort by" style="width: auto" @change="load"><option value="date">Date</option><option value="amount">Amount</option></select>
      <select v-model="order" aria-label="Order" style="width: auto" @change="load"><option value="desc">Newest / largest first</option><option value="asc">Oldest / smallest first</option></select>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <ul class="list">
      <li v-for="(tx, index) in result.items" :key="`${tx.date}-${index}-${tx.seq ?? ''}`" :class="{ actual: greyActuals && tx.kind === 'actual', stack: !!actionLabel }">
        <div class="grow">
          <div class="title">{{ tx.description || "(no description)" }}</div>
          <div class="sub">{{ formatDate(tx.date) }}<template v-if="tx.bankAccount || tx.account"> · {{ tx.bankAccount || tx.account }}</template> · {{ source(tx) }}<template v-if="greyActuals"> · {{ tx.kind }}</template></div>
        </div>
        <div class="num">
          <div :class="{ neg: tx.amount < 0 }">{{ formatMoney(tx.amount) }}</div>
          <div v-if="showRunning && tx.running !== undefined" class="sub small">{{ formatMoney(tx.running) }}</div>
        </div>
        <div v-if="actionLabel" class="actions"><button class="small" @click="emit('action', tx)">{{ actionLabel }}</button></div>
      </li>
      <li v-if="!loading && !result.items.length" class="empty">No transactions</li>
    </ul>
    <div v-if="result.pages > 1" class="spread" style="margin-top: 8px">
      <button :disabled="page <= 1" @click="page--; load()">Previous</button>
      <span class="muted small">Page {{ page }} of {{ result.pages }} · {{ result.total }} transactions</span>
      <button :disabled="page >= result.pages" @click="page++; load()">Next</button>
    </div>
  </div>
</template>
