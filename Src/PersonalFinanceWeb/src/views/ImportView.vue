<script setup>
import { computed, inject, ref, watch } from "vue";
import { readBase64 } from "../lib/api.js";
import { formatDate, formatMoney } from "../lib/format.js";
import { datasources, go, state, tenantPath, toast } from "../state.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";
import ImportsourceEditor from "../components/ImportsourceEditor.vue";
import TransactionList from "../components/TransactionList.vue";

const api = inject("api");
const reloadWorkspace = inject("reloadWorkspace");
const current = computed(() => state.route.parts[0] || null);
const tab = ref("files");
const detail = ref(null);
const files = ref([]);
const sources = ref([]);
const banks = ref([]);
const totals = ref([]);
const manual = ref([]);
const error = ref("");
const editing = ref(null);
const creating = ref(false);
const newName = ref("");
const uploads = ref([]);
const choose = ref(null);
const cloneOf = ref(null);
const totalDraft = ref(null);
const manualDraft = ref(null);

const D = () => `${tenantPath()}/datasources/${current.value}`;
async function load() {
  error.value = "";
  if (!current.value) return;
  try {
    detail.value = await api.get(D());
    const [f, s, b, t, m] = await Promise.all([api.get(`${D()}/files`), api.get(`${D()}/importsources`), api.get(`${D()}/bank-accounts`), api.get(`${D()}/totals`), api.get(`${D()}/manual-transactions`)]);
    files.value = f.items.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
    sources.value = s.items; banks.value = b.items; totals.value = t.items; manual.value = m.items;
  } catch (failure) { error.value = failure.message; }
}
watch(current, load, { immediate: true });

async function createDatasource() {
  try {
    const created = await api.post(`${tenantPath()}/datasources`, { name: newName.value });
    await reloadWorkspace();
    creating.value = false; newName.value = "";
    go("import", created.id);
  } catch (failure) { error.value = failure.message; }
}
async function removeDatasource() {
  if (!confirm(`Delete datasource ${detail.value.name}? Its files stay in storage but it disappears from the lists.`)) return;
  try { await api.del(D()); await reloadWorkspace(); go("import"); } catch (failure) { error.value = failure.message; }
}

// Uploads: the importsource comes from the filename filters; when none or several match, the user picks one.
async function upload(list, importsource) {
  for (const file of list) {
    const entry = { name: file.name, status: "uploading…" };
    uploads.value.unshift(entry);
    try {
      // Over 3 MB the file goes straight to the bucket (a Lambda request takes about 6 MB, base64 adds a third).
      let body = { filename: file.name, importsource };
      const target = file.size > 3 * 1024 * 1024 ? await api.post(`${D()}/upload-url`, { filename: file.name }) : { url: null };
      if (target.url) {
        const put = await fetch(target.url, { method: "PUT", headers: { "Content-Type": target.contentType }, body: file });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);
        body.uploadId = target.uploadId;
      } else body.contentBase64 = await readBase64(file);
      const result = await api.post(`${D()}/files`, body);
      entry.status = result.status === "already-imported" ? `already imported as ${result.sameAs}` : `${result.status}: ${result.added} added, ${result.alreadyPresent} already there${result.rejectedCount ? `, ${result.rejectedCount} rows rejected` : ""}`;
      entry.ok = true;
    } catch (failure) {
      if (failure.code === "ERR-IMPORTSOURCE-CHOICE") { entry.status = failure.message; choose.value = { file, candidates: failure.data?.candidates?.length ? failure.data.candidates : sources.value }; }
      else entry.status = failure.message;
    }
  }
  await load();
}
async function removeFile(file) {
  if (!confirm(`Remove ${file.filename} and its ${file.rows} rows?`)) return;
  await api.del(`${D()}/files/${file.id}`); toast("File removed"); await load();
}

async function cloneSource(target, move) {
  try {
    const copy = await api.post(`${D()}/importsources/${cloneOf.value.id}/clone`, { targetDatasource: target, move });
    toast(move ? "Importsource moved" : "Importsource cloned");
    cloneOf.value = null;
    if (target === current.value) editing.value = copy; else await load();
    await load();
  } catch (failure) { error.value = failure.message; }
}
async function editSource(item) { editing.value = await api.get(`${D()}/importsources/${item.id}`); }
async function removeSource(item) { if (!confirm(`Delete importsource ${item.name}?`)) return; await api.del(`${D()}/importsources/${item.id}`); await load(); }

async function saveTotal() {
  const body = { ...totalDraft.value, balance: Number(totalDraft.value.balance) };
  try { totalDraft.value.id ? await api.put(`${D()}/totals/${totalDraft.value.id}`, body) : await api.post(`${D()}/totals`, body); totalDraft.value = null; toast("Total saved: it is the source of truth at the next analysis"); await load(); } catch (failure) { error.value = failure.message; }
}
async function removeTotal(item) { if (!confirm("Delete this total?")) return; await api.del(`${D()}/totals/${item.id}`); await load(); }
async function saveManual() {
  const body = { ...manualDraft.value, amount: Number(manualDraft.value.amount) };
  try { manualDraft.value.id ? await api.put(`${D()}/manual-transactions/${manualDraft.value.id}`, body) : await api.post(`${D()}/manual-transactions`, body); manualDraft.value = null; toast("Transaction saved"); await load(); } catch (failure) { error.value = failure.message; }
}
async function removeManual(item) { if (!confirm("Delete this transaction?")) return; await api.del(`${D()}/manual-transactions/${item.id}`); await load(); }
const today = () => new Date().toISOString().slice(0, 10);
const bankNames = computed(() => banks.value.map((bank) => bank.account).filter(Boolean));
</script>

<template>
  <section v-if="!current">
    <div class="spread"><h1>Datasources</h1><button class="primary" @click="creating = true"><Icon name="plus" /> New</button></div>
    <p class="muted small">A datasource is where one set of statements lives, e.g. a bank account or a card. Upload statements into it; importsources describe how to read them.</p>
    <p v-if="error" class="error">{{ error }}</p>
    <ul class="list">
      <li v-for="item in datasources()" :key="item.id" class="link" @click="go('import', item.id)">
        <div class="grow"><div class="title">{{ item.name }}</div><div class="sub">{{ item.id }}</div></div><Icon name="chevron" />
      </li>
      <li v-if="!datasources().length" class="empty">No datasources yet</li>
    </ul>
    <Sheet v-if="creating" title="New datasource" @close="creating = false">
      <label class="field"><span>Name</span><input v-model="newName" placeholder="ASB everyday" @keyup.enter="createDatasource" /></label>
      <div class="row end"><button class="primary" :disabled="!newName" @click="createDatasource">Create</button></div>
    </Sheet>
  </section>

  <section v-else-if="detail">
    <div class="spread">
      <button class="ghost" @click="go('import')"><Icon name="back" /> Datasources</button>
      <button class="icon ghost" aria-label="Delete datasource" @click="removeDatasource"><Icon name="trash" /></button>
    </div>
    <h1>{{ detail.name }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="tabs" role="tablist">
      <button v-for="item in [['files', 'Files'], ['sources', 'Importsources'], ['banks', 'Balances'], ['manual', 'Manual'], ['transactions', 'Transactions']]" :key="item[0]" :class="{ on: tab === item[0] }" @click="tab = item[0]">{{ item[1] }}</button>
    </div>

    <div v-if="tab === 'files'">
      <div class="card">
        <label class="field"><span>Upload statements</span><input type="file" multiple accept=".csv,.json,.xlsx" @change="upload([...$event.target.files]); $event.target.value = ''" /></label>
        <p v-if="!sources.length" class="small muted">Set up an importsource first (the Importsources tab).</p>
        <p v-for="entry in uploads" :key="entry.name + entry.status" class="small" :class="{ neg: !entry.ok }">{{ entry.name }}: {{ entry.status }}</p>
      </div>
      <ul class="list">
        <li v-for="file in files" :key="file.id">
          <div class="grow"><div class="title">{{ file.filename }}</div><div class="sub">{{ file.rows }} rows · {{ formatDate(file.firstDate) }} – {{ formatDate(file.lastDate) }} · {{ file.importsource }}<template v-if="file.rejected"> · {{ file.rejected }} rejected</template></div></div>
          <button class="icon ghost" aria-label="Remove file" @click="removeFile(file)"><Icon name="trash" /></button>
        </li>
        <li v-if="!files.length" class="empty">No files imported</li>
      </ul>
    </div>

    <div v-if="tab === 'sources'">
      <div v-if="editing !== null">
        <ImportsourceEditor :datasource="current" :source="editing.id ? editing : null" @saved="editing = null; load()" @cancel="editing = null" />
      </div>
      <template v-else>
        <div class="row end"><button class="primary" @click="editing = {}"><Icon name="plus" /> New importsource</button></div>
        <ul class="list" style="margin-top: 8px">
          <li v-for="item in sources" :key="item.id">
            <div class="grow link" @click="editSource(item)"><div class="title">{{ item.name }}</div><div class="sub">{{ item.format }} · {{ item.filenameFilter?.pattern || "no filename filter" }}</div></div>
            <button class="icon ghost" aria-label="Clone or move" @click="cloneOf = item"><Icon name="copy" /></button>
            <button class="icon ghost" aria-label="Delete" @click="removeSource(item)"><Icon name="trash" /></button>
          </li>
          <li v-if="!sources.length" class="empty">No importsources yet</li>
        </ul>
      </template>
    </div>

    <div v-if="tab === 'banks'">
      <p class="muted small">A total is a bank account's balance on a date (e.g. a statement's closing balance). Totals are the source of truth: analysis adds a balance adjustment for any difference.</p>
      <ul class="list">
        <li v-for="bank in banks" :key="bank.account">
          <div class="grow"><div class="title">{{ bank.account || "(no account)" }}</div><div class="sub">{{ bank.transactions }} transactions<template v-if="bank.lastTotal"> · total {{ formatMoney(bank.lastTotal.balance) }} on {{ formatDate(bank.lastTotal.date) }}</template></div></div>
          <div class="num">{{ formatMoney(bank.sum) }}</div>
        </li>
      </ul>
      <div class="spread"><h2>Totals</h2><button @click="totalDraft = { date: today(), account: bankNames[0] || '', balance: '' }"><Icon name="plus" /> Add total</button></div>
      <ul class="list">
        <li v-for="item in totals" :key="item.id">
          <div class="grow link" @click="totalDraft = { ...item }"><div class="title">{{ item.account }}</div><div class="sub">{{ formatDate(item.date) }}<template v-if="item.note"> · {{ item.note }}</template></div></div>
          <div class="num">{{ formatMoney(item.balance) }}</div>
          <button class="icon ghost" aria-label="Delete total" @click="removeTotal(item)"><Icon name="trash" /></button>
        </li>
        <li v-if="!totals.length" class="empty">No totals</li>
      </ul>
    </div>

    <div v-if="tab === 'manual'">
      <div class="row end"><button class="primary" @click="manualDraft = { date: today(), account: bankNames[0] || '', description: '', amount: '' }"><Icon name="plus" /> Add transaction</button></div>
      <ul class="list" style="margin-top: 8px">
        <li v-for="item in manual" :key="item.id" class="link" @click="manualDraft = { ...item }">
          <div class="grow"><div class="title">{{ item.description || "(no description)" }}</div><div class="sub">{{ formatDate(item.date) }} · {{ item.account }}</div></div>
          <div class="num" :class="{ neg: item.amount < 0 }">{{ formatMoney(item.amount) }}</div>
          <button class="icon ghost" aria-label="Delete transaction" @click.stop="removeManual(item)"><Icon name="trash" /></button>
        </li>
        <li v-if="!manual.length" class="empty">No manual transactions</li>
      </ul>
    </div>

    <div v-if="tab === 'transactions'">
      <TransactionList :path="`${D()}/transactions`" :show-running="false" />
    </div>

    <Sheet v-if="choose" title="Which importsource?" @close="choose = null">
      <p class="small">{{ choose.file.name }}</p>
      <ul class="list">
        <li v-for="item in choose.candidates" :key="item.id" class="link" @click="upload([choose.file], item.id); choose = null"><div class="grow title">{{ item.name }}</div><Icon name="chevron" /></li>
      </ul>
    </Sheet>
    <Sheet v-if="cloneOf" :title="`Clone ${cloneOf.name}`" @close="cloneOf = null">
      <p class="muted small">Clone it here to configure a variant, or clone or move it to another datasource.</p>
      <ul class="list">
        <li class="link" @click="cloneSource(current, false)"><div class="grow title">Clone into this datasource</div></li>
        <template v-for="item in datasources().filter((ds) => ds.id !== current)" :key="item.id">
          <li class="link" @click="cloneSource(item.id, false)"><div class="grow title">Clone to {{ item.name }}</div></li>
          <li class="link" @click="cloneSource(item.id, true)"><div class="grow title">Move to {{ item.name }}</div></li>
        </template>
      </ul>
    </Sheet>
    <Sheet v-if="totalDraft" :title="totalDraft.id ? 'Edit total' : 'Add total'" @close="totalDraft = null">
      <label class="field"><span>Bank account</span><input v-model="totalDraft.account" list="bank-accounts" /></label>
      <datalist id="bank-accounts"><option v-for="name in bankNames" :key="name" :value="name" /></datalist>
      <div class="grid2">
        <label class="field"><span>Date</span><input v-model="totalDraft.date" type="date" /></label>
        <label class="field"><span>Balance</span><input v-model="totalDraft.balance" type="number" step="0.01" inputmode="decimal" /></label>
      </div>
      <label class="field"><span>Note</span><input v-model="totalDraft.note" /></label>
      <div class="row end"><button class="primary" @click="saveTotal">Save</button></div>
    </Sheet>
    <Sheet v-if="manualDraft" :title="manualDraft.id ? 'Edit transaction' : 'Add transaction'" @close="manualDraft = null">
      <div class="grid2">
        <label class="field"><span>Date</span><input v-model="manualDraft.date" type="date" /></label>
        <label class="field"><span>Amount (negative for spending)</span><input v-model="manualDraft.amount" type="number" step="0.01" inputmode="decimal" /></label>
      </div>
      <label class="field"><span>Bank account</span><input v-model="manualDraft.account" list="bank-accounts-2" /></label>
      <datalist id="bank-accounts-2"><option v-for="name in bankNames" :key="name" :value="name" /></datalist>
      <label class="field"><span>Description</span><input v-model="manualDraft.description" /></label>
      <div class="row end"><button class="primary" @click="saveManual">Save</button></div>
    </Sheet>
  </section>
</template>
