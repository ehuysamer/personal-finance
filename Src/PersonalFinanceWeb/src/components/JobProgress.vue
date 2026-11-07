<script setup>
import { inject, onBeforeUnmount, ref, watch } from "vue";
import { projectPath } from "../state.js";

// Follows a job until it ends (polling every 1.5 s), then emits done with the final job.
const props = defineProps({ jobId: { type: String, default: null } });
const emit = defineEmits(["done"]);
const api = inject("api");
const job = ref(null);
let timer;
async function poll() {
  if (!props.jobId) return;
  try {
    job.value = await api.get(`${projectPath()}/jobs/${props.jobId}`);
    if (["complete", "failed", "cancelled"].includes(job.value.status)) { emit("done", job.value); return; }
  } catch { /* try again */ }
  timer = setTimeout(poll, 1500);
}
watch(() => props.jobId, () => { clearTimeout(timer); job.value = null; poll(); }, { immediate: true });
onBeforeUnmount(() => clearTimeout(timer));
async function cancel() { await api.post(`${projectPath()}/jobs/${props.jobId}/cancel`); }
</script>

<template>
  <div v-if="job" class="card">
    <div class="spread"><strong>{{ job.type }}: {{ job.status }}</strong><button v-if="['queued', 'running'].includes(job.status)" class="ghost" @click="cancel">Cancel</button></div>
    <p class="small muted">{{ job.progress?.message }}<template v-if="job.progress?.total"> ({{ job.progress.done }}/{{ job.progress.total }})</template></p>
    <div v-if="job.progress?.total" class="progress"><div :style="{ width: `${Math.round((job.progress.done / job.progress.total) * 100)}%` }" /></div>
    <p v-if="job.error" class="error">{{ job.error.message }}</p>
  </div>
</template>
