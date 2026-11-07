<script setup>
import Icon from "./Icon.vue";
defineProps({ title: { type: String, default: "" } });
const emit = defineEmits(["close"]);
</script>

<template>
  <div class="sheet-backdrop" @click.self="emit('close')">
    <section class="sheet" role="dialog" :aria-label="title">
      <header><h2>{{ title }}</h2><button class="icon ghost" aria-label="Close" @click="emit('close')"><Icon name="close" /></button></header>
      <slot />
    </section>
  </div>
</template>
