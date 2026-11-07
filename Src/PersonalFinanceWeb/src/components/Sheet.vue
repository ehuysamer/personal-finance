<script setup>
import Icon from "./Icon.vue";
defineProps({ title: { type: String, default: "" } });
const emit = defineEmits(["close"]);
</script>

<template>
  <!-- Closes only with its ✕ (or what the form does on save): a tap or a text selection ending outside it must not
       throw away a half-filled form. -->
  <div class="sheet-backdrop">
    <section class="sheet" role="dialog" aria-modal="true" :aria-label="title">
      <header><h2>{{ title }}</h2><button class="icon ghost" aria-label="Close" @click="emit('close')"><Icon name="close" /></button></header>
      <slot />
    </section>
  </div>
</template>
