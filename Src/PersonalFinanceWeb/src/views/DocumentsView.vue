<script setup>
import { computed, inject, ref, watch } from "vue";
import { readBase64 } from "../lib/api.js";
import { formatDate } from "../lib/format.js";
import { go, state, tenantPath, toast } from "../state.js";
import Icon from "../components/Icon.vue";
import Sheet from "../components/Sheet.vue";

// Documents: drop files (or whole folders) anywhere on the page, or choose them; browse folders, download, move,
// delete, and import statements into a datasource (they stay here).
const api = inject("api");
const folder = computed(() => state.route.parts.join("/"));
const listing = ref({ folders: [], files: [] });
const q = ref("");
const results = ref(null);
const dragging = ref(false);
const uploads = ref([]);
const error = ref("");
const importing = ref(null);
const moving = ref(null);

const crumbs = computed(() => folder.value ? folder.value.split("/").map((name, i, parts) => ({ name, path: parts.slice(0, i + 1) })) : []);
async function load() {
  error.value = "";
  try { listing.value = await api.get(`${tenantPath()}/documents`, { folder: folder.value }); } catch (failure) { error.value = failure.message; }
}
watch(folder, load, { immediate: true });
let timer;
function search() {
  clearTimeout(timer);
  timer = setTimeout(async () => { results.value = q.value ? (await api.get(`${tenantPath()}/documents`, { q: q.value })).files : null; }, 250);
}

// Dropped folders are read entry by entry so their files keep their place below the current folder.
async function entriesOf(item) {
  const entry = item.webkitGetAsEntry?.();
  if (!entry) { const file = item.getAsFile(); return file ? [{ file, path: file.name }] : []; }
  const out = [];
  async function walk(node, prefix) {
    if (node.isFile) { out.push({ file: await new Promise((resolve, reject) => node.file(resolve, reject)), path: `${prefix}${node.name}` }); return; }
    const reader = node.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${node.name}/`);
    }
  }
  await walk(entry, "");
  return out;
}
async function onDrop(event) {
  dragging.value = false;
  const items = [...(event.dataTransfer?.items || [])].filter((item) => item.kind === "file");
  const files = [];
  for (const item of items) files.push(...await entriesOf(item));
  await upload(files);
}
async function upload(files) {
  for (const { file, path } of files) {
    if (file.name.startsWith(".")) continue;
    const target = folder.value ? `${folder.value}/${path}` : path;
    const entry = { path: target, status: "uploading…" };
    uploads.value.unshift(entry);
    try {
      // Over 3 MB the file goes straight to the bucket (a Lambda request takes about 6 MB).
      const direct = file.size > 3 * 1024 * 1024 ? await api.post(`${tenantPath()}/documents/upload-url`, { path: target }) : { url: null };
      let saved;
      if (direct.url) {
        const put = await fetch(direct.url, { method: "PUT", headers: { "Content-Type": direct.contentType }, body: file });
        if (!put.ok) throw new Error(`upload failed (${put.status})`);
        saved = await api.post(`${tenantPath()}/documents`, { path: target, uploaded: true });
      } else saved = await api.post(`${tenantPath()}/documents`, { path: target, contentBase64: await readBase64(file) });
      entry.status = saved.replaced ? "replaced" : "saved"; entry.ok = true;
    } catch (failure) { entry.status = failure.message; }
  }
  await load();
}
function chosen(event) { upload([...event.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); event.target.value = ""; }

async function download(file) {
  try {
    const link = await api.get(`${tenantPath()}/documents/download`, { path: file.path });
    const href = link.url || URL.createObjectURL(new Blob([Uint8Array.from(atob(link.contentBase64), (c) => c.charCodeAt(0))], { type: link.contentType }));
    const a = document.createElement("a");
    a.href = href; a.download = file.name; a.rel = "noopener"; a.click();
  } catch (failure) { error.value = failure.message; }
}
async function remove(file) {
  if (!confirm(`Delete ${file.name}?`)) return;
  await api.del(`${tenantPath()}/documents`, { path: file.path }); toast("Deleted"); await load();
}
async function move() {
  try { await api.put(`${tenantPath()}/documents/move`, { path: moving.value.path, to: moving.value.to }); moving.value = null; toast("Moved"); await load(); } catch (failure) { error.value = failure.message; }
}
function newFolder() {
  const name = prompt("Folder name");
  if (name) go("documents", ...folder.value.split("/").filter(Boolean), ...name.split("/").filter(Boolean));
}

// Import a statement: the matching datasources and importsources, or any datasource (its filters then choose).
async function startImport(file) {
  importing.value = { file, candidates: [], pick: null, datasource: "", result: "" };
  const { candidates } = await api.get(`${tenantPath()}/documents/candidates`, { path: file.path });
  importing.value.candidates = candidates;
  importing.value.pick = candidates.length === 1 ? 0 : null;
}
async function runImport() {
  const job = importing.value;
  const pick = job.candidates[job.pick];
  job.result = "importing…";
  try {
    const result = await api.post(`${tenantPath()}/documents/import`, { path: job.file.path, ...(pick ? { datasource: pick.datasource, importsource: pick.importsource } : job.datasource ? { datasource: job.datasource } : {}) });
    job.result = result.status === "already-imported" ? `already imported as ${result.sameAs}` : `${result.status === "replaced" ? "imported again" : "imported"} into ${result.datasource}: ${result.added} added, ${result.alreadyPresent} already there`;
  } catch (failure) { job.result = failure.message; }
}
const datasourceOptions = computed(() => state.workspace.items.filter((item) => item.kind === "datasource"));
const sizeText = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const isStatement = (name) => /\.(csv|json|xlsx)$/i.test(name);
</script>

<template>
  <section class="dropzone" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.self="dragging = false" @drop.prevent="onDrop">
    <div class="spread"><h1>Documents</h1>
      <div class="row">
        <button class="icon" aria-label="New folder" title="New folder" @click="newFolder"><Icon name="folder" /></button>
        <label class="button primary"><Icon name="upload" /> Add<input type="file" multiple hidden @change="chosen" /></label>
      </div>
    </div>
    <p class="muted small">Drop files or folders anywhere here. Statements (CSV, Excel, JSON) can be imported into a datasource and stay here too.</p>
    <input v-model="q" type="search" placeholder="Search all documents" aria-label="Search documents" @input="search" />
    <p v-if="error" class="error">{{ error }}</p>
    <p v-for="entry in uploads.slice(0, 6)" :key="entry.path + entry.status" class="small" :class="{ neg: !entry.ok }">{{ entry.path }}: {{ entry.status }}</p>

    <template v-if="results">
      <h2>Found {{ results.length }}</h2>
      <ul class="list">
        <li v-for="file in results" :key="file.path"><div class="grow link" @click="go('documents', ...file.path.split('/').slice(0, -1)); q = ''; results = null"><div class="title">{{ file.name }}</div><div class="sub">{{ file.path }}</div></div><button class="icon ghost" aria-label="Download" @click="download(file)"><Icon name="down" /></button></li>
      </ul>
    </template>
    <template v-else>
      <nav class="row small" aria-label="Folder" style="margin: 10px 0">
        <a href="#/documents">Documents</a>
        <template v-for="crumb in crumbs" :key="crumb.path.join('/')"><span class="muted">/</span><a :href="`#/documents/${crumb.path.map(encodeURIComponent).join('/')}`">{{ crumb.name }}</a></template>
      </nav>
      <ul class="list">
        <li v-for="name in listing.folders" :key="name" class="link" @click="go('documents', ...folder.split('/').filter(Boolean), name)"><Icon name="folder" /><div class="grow title">{{ name }}</div><Icon name="chevron" /></li>
        <li v-for="file in listing.files" :key="file.path" class="stack">
          <div class="grow"><div class="title">{{ file.name }}</div><div class="sub">{{ sizeText(file.size) }} · {{ formatDate(file.updatedAt) }}</div></div>
          <div class="actions">
            <button v-if="isStatement(file.name)" class="ghost small" @click="startImport(file)">Import</button>
            <button class="icon ghost" aria-label="Download" @click="download(file)"><Icon name="down" /></button>
            <button class="icon ghost" aria-label="Move or rename" @click="moving = { path: file.path, to: file.path }"><Icon name="edit" /></button>
            <button class="icon ghost" aria-label="Delete" @click="remove(file)"><Icon name="trash" /></button>
          </div>
        </li>
        <li v-if="!listing.folders.length && !listing.files.length" class="empty">{{ folder ? "This folder is empty: drop files here" : "No documents yet: drop files here" }}</li>
      </ul>
    </template>

    <Sheet v-if="importing" :title="`Import ${importing.file.name}`" @close="importing = null">
      <template v-if="!importing.result">
        <label v-if="importing.candidates.length" class="field"><span>Into</span>
          <select v-model="importing.pick"><option :value="null">Choose</option><option v-for="(candidate, index) in importing.candidates" :key="index" :value="index">{{ candidate.datasourceName }} · {{ candidate.importsourceName }}</option></select>
        </label>
        <label v-else class="field"><span>No importsource's filename filter matches; choose a datasource (it needs an importsource that reads this file)</span>
          <select v-model="importing.datasource"><option value="">Choose</option><option v-for="item in datasourceOptions" :key="item.id" :value="item.id">{{ item.name }}</option></select>
        </label>
        <div class="row end"><button class="primary" :disabled="importing.pick === null && !importing.datasource" @click="runImport">Import</button></div>
      </template>
      <p v-else>{{ importing.result }}</p>
    </Sheet>
    <Sheet v-if="moving" title="Move or rename" @close="moving = null">
      <label class="field"><span>Path (folder/name)</span><input v-model="moving.to" /></label>
      <div class="row end"><button class="primary" @click="move">Move</button></div>
    </Sheet>
  </section>
</template>
