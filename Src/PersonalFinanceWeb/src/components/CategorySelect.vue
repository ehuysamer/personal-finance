<script setup>
import { inject, ref } from "vue";
import { projectPath, toast } from "../state.js";
import Icon from "./Icon.vue";
import Sheet from "./Sheet.vue";

// A category dropdown with a + that adds a category on the spot (name, type, inflation) and selects it.
// Emits created so the parent reloads the project's categories.
const props = defineProps({ modelValue: { type: String, default: "" }, categories: { type: Array, required: true }, label: { type: String, default: "Category" } });
const emit = defineEmits(["update:modelValue", "created"]);
const api = inject("api");
const TYPES = ["income", "expense", "asset", "liability"];
const draft = ref(null);
const error = ref("");
async function save() {
  error.value = "";
  try {
    const category = await api.post(`${projectPath()}/categories`, { name: draft.value.name, type: draft.value.type, inflation: Number(draft.value.inflation || 0) / 100 });
    draft.value = null;
    emit("created", category);
    emit("update:modelValue", category.id);
    toast(`Category ${category.name} added`);
  } catch (failure) { error.value = failure.message; }
}
</script>

<template>
  <div class="field">
    <span class="small muted" style="font-weight: 550">{{ label }}</span>
    <div class="row" style="flex-wrap: nowrap">
      <!-- Keyed on the list, so a category added here is shown selected once the reloaded list includes it. -->
      <select :key="categories.map((category) => category.id).join()" :value="props.modelValue" :aria-label="label" @change="emit('update:modelValue', $event.target.value)"><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option></select>
      <button class="icon" :aria-label="`Add a ${label.toLowerCase()}`" title="Add a category" @click="draft = { name: '', type: 'expense', inflation: 3 }; error = ''"><Icon name="plus" /></button>
    </div>
    <Sheet v-if="draft" title="New category" @close="draft = null">
      <label class="field"><span>Name</span><input v-model="draft.name" placeholder="Pets" aria-label="New category name" /></label>
      <div class="grid2">
        <label class="field"><span>Type</span><select v-model="draft.type"><option v-for="type in TYPES" :key="type" :value="type">{{ type }}</option></select></label>
        <label class="field"><span>Inflation % per year</span><input v-model="draft.inflation" type="number" step="0.1" inputmode="decimal" /></label>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <div class="row end"><button class="primary" :disabled="!draft.name" @click="save">Add category</button></div>
    </Sheet>
  </div>
</template>
