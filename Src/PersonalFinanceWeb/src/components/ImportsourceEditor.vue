<script setup>
import { computed, inject, reactive, ref } from "vue";
import { readBase64 } from "../lib/api.js";
import { filesFromDrop } from "../lib/drop.js";
import { formatMoney } from "../lib/format.js";
import { tenantPath, toast } from "../state.js";
import Icon from "./Icon.vue";
import Sheet from "./Sheet.vue";

// One importsource: format, filename filter and the translators (per target field an ordered list of parts),
// with "Import sample" to see a file's columns and the normalised rows before saving.
const props = defineProps({ datasource: { type: String, required: true }, source: { type: Object, default: null } });
const emit = defineEmits(["saved", "cancel"]);
const api = inject("api");
const TARGETS = [
  { id: "date", label: "Date", hint: "One or more columns read as a date" },
  { id: "account", label: "Account", hint: "The bank account; often a fixed value" },
  { id: "description", label: "Description", hint: "Parts are joined in order" },
  { id: "amount", label: "Amount", hint: "Parts are added; − negates a part (e.g. Credit + and Debit −)" }
];
const DATE_FORMATS = ["auto", "dd/MM/yyyy", "d/M/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "dd-MM-yyyy", "dd.MM.yyyy", "yyyyMMdd", "yyyy/MM/dd", "dd MMM yyyy", "d MMM yyyy", "MMM d, yyyy", "dd/MM/yy", "excel"];

const empty = () => ({ parts: [] });
const draft = reactive(JSON.parse(JSON.stringify(props.source || { name: "", format: "csv", options: {}, filenameFilter: { type: "wildcard", pattern: "" }, translators: { date: { parts: [], format: "auto" }, account: empty(), description: empty(), amount: empty() } })));
draft.filenameFilter ||= { type: "wildcard", pattern: "" };
draft.options ||= {};
for (const target of TARGETS) draft.translators[target.id] ||= empty();
const sample = ref(null);
const sampleFile = ref(null);
const busy = ref(false);
const error = ref("");
const columns = computed(() => sample.value?.columns || [...new Set(TARGETS.flatMap((target) => draft.translators[target.id].parts.filter((part) => part.type === "column").map((part) => part.column)))]);

function addPart(target, type) { draft.translators[target].parts.push(type === "fixed" ? { type: "fixed", value: "" } : { type: "column", column: columns.value[0] || "" }); }
function move(target, index, delta) { const parts = draft.translators[target].parts; const [part] = parts.splice(index, 1); parts.splice(index + delta, 0, part); }
function payload() {
  const body = JSON.parse(JSON.stringify(draft));
  if (!body.filenameFilter?.pattern) delete body.filenameFilter;
  for (const key of ["skipRows"]) if (body.options[key] === "" || body.options[key] === null) delete body.options[key];
  return body;
}

// The sample: a file chosen or dropped here ({ file }), or a document ({ path, name }), which the API reads itself.
async function runSample(source = sampleFile.value) {
  if (!source) return;
  sampleFile.value = source;
  const name = source.file ? source.file.name : source.name;
  busy.value = true; error.value = "";
  try {
    if (!draft.name) draft.name = name.replace(/\.[^.]+$/, "");
    const extension = name.split(".").pop().toLowerCase();
    if (!props.source && ["csv", "json", "xlsx"].includes(extension)) draft.format = extension;
    if (!props.source && !draft.filenameFilter.pattern) draft.filenameFilter.pattern = name.replace(/\d+/g, "*").replace(/\*+/g, "*");
    const translatorsReady = TARGETS.every((target) => target.id === "account" || draft.translators[target.id].parts.length);
    let body;
    if (source.file) {
      // A sample needs only the start of a big CSV (cut at the last whole line); other formats are read whole.
      const part = draft.format === "csv" && source.file.size > 2 * 1024 * 1024 ? await cutCsv(source.file) : source.file;
      body = { filename: name, contentBase64: await readBase64(part) };
    } else body = { documentPath: source.path };
    sample.value = await api.post(`${tenantPath()}/datasources/${props.datasource}/sample`, { ...body, format: draft.format, options: draft.options, ...(translatorsReady ? { translators: draft.translators } : {}) });
    if (!translatorsReady) guess();
  } catch (failure) { error.value = failure.message; }
  busy.value = false;
}

const dragging = ref(false);
async function onDrop(event) {
  dragging.value = false;
  const [first] = await filesFromDrop(event.dataTransfer);
  if (first) await runSample({ file: first.file });
}
// Choose a statement from Documents.
const picking = ref(null);
async function openDocuments() { picking.value = { q: "", files: [] }; await searchDocuments(); }
async function searchDocuments() {
  const files = (await api.get(`${tenantPath()}/documents`, { q: picking.value.q, recursive: true })).files;
  picking.value.files = files.filter((file) => /\.(csv|json|xlsx)$/i.test(file.name));
}
function pickDocument(file) { picking.value = null; runSample({ path: file.path, name: file.name }); }
const sampleName = computed(() => (sampleFile.value ? (sampleFile.value.file ? sampleFile.value.file.name : sampleFile.value.path) : ""));

async function cutCsv(file) {
  const text = await file.slice(0, 2 * 1024 * 1024).text();
  return new Blob([text.slice(0, text.lastIndexOf("\n") + 1)]);
}

// A first guess at the mapping from the column names.
function guess() {
  const find = (pattern) => sample.value.columns.find((column) => pattern.test(column));
  const t = draft.translators;
  if (!t.date.parts.length && find(/date/i)) t.date.parts = [{ type: "column", column: find(/date/i) }];
  if (!t.description.parts.length) { const columns = sample.value.columns.filter((column) => /desc|detail|payee|particular|memo|reference|narrative/i.test(column)); t.description.parts = columns.map((column) => ({ type: "column", column })); }
  if (!t.amount.parts.length) {
    if (find(/^amount$/i)) t.amount.parts = [{ type: "column", column: find(/^amount$/i) }];
    else { if (find(/credit|deposit/i)) t.amount.parts.push({ type: "column", column: find(/credit|deposit/i) }); if (find(/debit|withdrawal/i)) t.amount.parts.push({ type: "column", column: find(/debit|withdrawal/i), negate: true }); }
  }
  if (!t.account.parts.length) t.account.parts = find(/account/i) ? [{ type: "column", column: find(/account/i) }] : [{ type: "fixed", value: draft.name || "" }];
}

async function save() {
  busy.value = true; error.value = "";
  try {
    const base = `${tenantPath()}/datasources/${props.datasource}/importsources`;
    const saved = props.source ? await api.put(`${base}/${props.source.id}`, payload()) : await api.post(base, payload());
    toast("Importsource saved");
    emit("saved", saved);
  } catch (failure) { error.value = failure.message; }
  busy.value = false;
}
</script>

<template>
  <div>
    <div class="card dropzone sample" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
      <h3>Import sample</h3>
      <p class="muted small">Choose a statement, drop one here, or pick one from Documents, to see its columns and what the mapping makes of it. Nothing is imported.</p>
      <div class="row">
        <label class="button"><Icon name="upload" /> Choose file<input type="file" accept=".csv,.json,.xlsx,text/csv,application/json" hidden @change="runSample({ file: $event.target.files[0] }); $event.target.value = ''" /></label>
        <button @click="openDocuments"><Icon name="document" /> From documents</button>
      </div>
      <p v-if="sampleName" class="small">Sample: {{ sampleName }}</p>
      <p v-if="sample" class="small muted">{{ sample.rowCount }} rows, columns: {{ sample.columns.join(", ") }}</p>
      <div v-if="sample?.rows?.length" class="table-wrap sample-grid" role="region" aria-label="Sample rows">
        <table>
          <thead><tr><th class="muted">#</th><th v-for="column in sample.columns" :key="column">{{ column }}</th></tr></thead>
          <tbody><tr v-for="(row, index) in sample.rows.slice(0, 10)" :key="index"><td class="muted">{{ index + 1 }}</td><td v-for="column in sample.columns" :key="column">{{ row[column] }}</td></tr></tbody>
        </table>
      </div>
      <p v-if="sample?.rowCount > 10" class="small muted">The first 10 of {{ sample.rowCount }} rows, as they are in the file.</p>
    </div>
    <Sheet v-if="picking" title="Sample from documents" @close="picking = null">
      <input v-model="picking.q" type="search" placeholder="Search documents" aria-label="Search documents" @input="searchDocuments" />
      <ul class="list" style="margin-top: 8px">
        <li v-for="file in picking.files" :key="file.path" class="link" @click="pickDocument(file)"><div class="grow"><div class="title">{{ file.name }}</div><div class="sub">{{ file.path }}</div></div><Icon name="chevron" /></li>
        <li v-if="!picking.files.length" class="empty">No statements (CSV, Excel, JSON) in documents</li>
      </ul>
    </Sheet>

    <div class="grid2">
      <label class="field"><span>Name</span><input v-model="draft.name" placeholder="ASB CSV export" /></label>
      <label class="field"><span>Format</span>
        <select v-model="draft.format"><option value="csv">CSV</option><option value="xlsx">Excel (xlsx)</option><option value="json">JSON</option></select>
      </label>
    </div>
    <div class="grid2">
      <label class="field"><span>Filename filter</span><input v-model="draft.filenameFilter.pattern" placeholder="ASB-*-Export.csv" /></label>
      <label class="field"><span>Filter type</span>
        <select v-model="draft.filenameFilter.type"><option value="wildcard">Wildcard (* and ?)</option><option value="regex">Regex</option></select>
      </label>
    </div>
    <details class="card">
      <summary>File options</summary>
      <div class="grid2">
        <label v-if="draft.format === 'csv'" class="field"><span>Delimiter</span><input v-model="draft.options.delimiter" placeholder="automatic" maxlength="2" /></label>
        <label v-if="draft.format !== 'json'" class="field"><span>Lines to skip before the header</span><input v-model.number="draft.options.skipRows" type="number" min="0" /></label>
        <label v-if="draft.format === 'xlsx'" class="field"><span>Sheet</span><input v-model="draft.options.sheet" placeholder="first sheet" /></label>
        <label v-if="draft.format === 'json'" class="field"><span>Rows path</span><input v-model="draft.options.rowsPath" placeholder="data.transactions" /></label>
        <label v-if="draft.format === 'csv'" class="field"><span>Encoding</span><select v-model="draft.options.encoding"><option :value="undefined">UTF-8</option><option value="latin1">Latin-1</option></select></label>
      </div>
      <label v-if="draft.format !== 'json'" class="check"><input type="checkbox" :checked="draft.options.hasHeader !== false" @change="draft.options.hasHeader = $event.target.checked" />The first row is a header</label>
      <button v-if="sampleFile" @click="runSample()">Read the sample again</button>
    </details>

    <h2>Mapping</h2>
    <div v-for="target in TARGETS" :key="target.id" class="card">
      <div class="spread"><strong>{{ target.label }}</strong><span class="muted small">{{ target.hint }}</span></div>
      <div v-for="(part, index) in draft.translators[target.id].parts" :key="index" class="part">
        <button v-if="target.id === 'amount'" class="sign" :class="{ negate: part.negate }" :aria-label="part.negate ? 'Negated: tap to add as is' : 'Added as is: tap to negate'" :title="part.negate ? 'Negated (e.g. a debit column)' : 'Added as is'" @click="part.negate = !part.negate">{{ part.negate ? "−" : "+" }}</button>
        <select v-model="part.type" aria-label="Part type"><option value="column">Column</option><option value="fixed">Fixed</option></select>
        <select v-if="part.type === 'column'" v-model="part.column" aria-label="Column">
          <option v-for="column in columns" :key="column" :value="column">{{ column }}</option>
          <option v-if="part.column && !columns.includes(part.column)" :value="part.column">{{ part.column }}</option>
        </select>
        <input v-else v-model="part.value" aria-label="Fixed value" placeholder="value" />
        <button class="icon ghost" :disabled="index === 0" aria-label="Move up" @click="move(target.id, index, -1)"><Icon name="up" /></button>
        <button class="icon ghost" :disabled="index === draft.translators[target.id].parts.length - 1" aria-label="Move down" @click="move(target.id, index, 1)"><Icon name="down" /></button>
        <button class="icon ghost" aria-label="Remove" @click="draft.translators[target.id].parts.splice(index, 1)"><Icon name="trash" /></button>
      </div>
      <div class="row">
        <button @click="addPart(target.id, 'column')"><Icon name="plus" /> Column</button>
        <button @click="addPart(target.id, 'fixed')"><Icon name="plus" /> Fixed value</button>
        <label v-if="target.id === 'date'" class="field" style="margin: 0; flex: 1; min-width: 140px"><select v-model="draft.translators.date.format" aria-label="Date format"><option v-for="format in DATE_FORMATS" :key="format" :value="format">{{ format }}</option></select></label>
        <label v-if="target.id === 'description' && draft.translators.description.parts.length > 1" class="field" style="margin: 0; width: 120px"><input v-model="draft.translators.description.separator" placeholder="separator" aria-label="Separator" /></label>
      </div>
    </div>

    <div v-if="sample?.normalised" class="card">
      <div class="spread"><h3>Preview</h3><span v-if="sample.rejectedCount" class="badge bad">{{ sample.rejectedCount }} rows rejected</span></div>
      <div class="table-wrap">
        <table><thead><tr><th>Date</th><th>Account</th><th>Description</th><th class="num">Amount</th></tr></thead>
          <tbody>
            <tr v-for="row in sample.normalised" :key="row.row"><td>{{ row.date }}</td><td>{{ row.account }}</td><td>{{ row.description }}</td><td class="num" :class="{ neg: row.amount < 0 }">{{ formatMoney(row.amount) }}</td></tr>
          </tbody>
        </table>
      </div>
      <p v-for="rejected in (sample.rejected || []).slice(0, 5)" :key="rejected.row" class="small neg">Row {{ rejected.row }}: {{ rejected.errors.join("; ") }}</p>
    </div>
    <button v-if="sampleFile" @click="runSample()">Preview with this mapping</button>

    <p v-if="error" class="error">{{ error }}</p>
    <div class="row end" style="margin-top: 12px">
      <button class="ghost" @click="emit('cancel')">Cancel</button>
      <button class="primary" :disabled="busy || !draft.name" @click="save">Save importsource</button>
    </div>
  </div>
</template>
