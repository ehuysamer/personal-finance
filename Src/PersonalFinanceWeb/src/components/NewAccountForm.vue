<script setup>
import { inject, ref } from "vue";
import { projectPath, toast } from "../state.js";
import CategorySelect from "./CategorySelect.vue";
import Sheet from "./Sheet.vue";
import CurrencyInput from "./CurrencyInput.vue";

// A pop-up for a new account in a few fields (name, category with its own +, short code), e.g. while writing a rule.
// Emits created with the account, and categories-changed when a category was added on the way.
const props = defineProps({ categories: { type: Array, required: true }, name: { type: String, default: "" }, currency: { type: String, default: "NZD" } });
const emit = defineEmits(["created", "categories-changed", "cancel"]);
const api = inject("api");
const draft = ref({ name: props.name, category: (props.categories.find((category) => category.type === "expense") || props.categories[0])?.id || "", shortCode: "", currency: props.currency });
const error = ref("");
async function save() {
  error.value = "";
  try {
    const account = await api.post(`${projectPath()}/accounts`, { name: draft.value.name, category: draft.value.category, currency: draft.value.currency, shortCode: draft.value.shortCode || null });
    toast(`Account ${account.name} added`);
    emit("created", account);
  } catch (failure) { error.value = failure.message; }
}
</script>

<template>
  <Sheet title="New account" @close="emit('cancel')">
    <label class="field"><span>Name</span><input v-model="draft.name" placeholder="Groceries" aria-label="New account name" /></label>
    <CategorySelect v-model="draft.category" :categories="categories" @created="emit('categories-changed')" />
    <CurrencyInput v-model="draft.currency" />
    <label class="field"><span>Short code (optional)</span><input v-model="draft.shortCode" placeholder="FOOD" aria-label="New account short code" autocapitalize="characters" /></label>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="row end"><button class="primary" :disabled="!draft.name || !draft.category" @click="save">Add account</button></div>
  </Sheet>
</template>
