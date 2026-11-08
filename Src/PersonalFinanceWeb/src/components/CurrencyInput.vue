<script setup>
import { CURRENCIES, currencyLabel } from "../lib/format.js";

// A currency code (NZD, USD, EUR...): common ones offered, any three-letter code accepted.
const props = defineProps({ modelValue: { type: String, default: "NZD" }, label: { type: String, default: "Currency" } });
const emit = defineEmits(["update:modelValue"]);
const id = `currencies-${Math.random().toString(36).slice(2, 8)}`;
</script>

<template>
  <label class="field"><span>{{ label }} <span class="muted">({{ currencyLabel(props.modelValue) }})</span></span>
    <input :value="props.modelValue" :list="id" maxlength="3" autocapitalize="characters" :aria-label="label" @input="emit('update:modelValue', $event.target.value.toUpperCase())" />
    <datalist :id="id"><option v-for="code in CURRENCIES" :key="code" :value="code">{{ currencyLabel(code) }}</option></datalist>
  </label>
</template>
