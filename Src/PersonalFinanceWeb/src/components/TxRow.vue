<script setup>
import { formatMoney, formatTxDate, weekday } from "../lib/format.js";

// One transaction in a list: the date (yyyy/mm/dd, weekday greyed under it) on the left, then the description and
// its details, then the amount (and running total). On a phone the date and amount share the top line and the
// description and details go below. Slots: details (the line under the description), extra (under the amount),
// actions (buttons).
defineProps({ tx: { type: Object, required: true }, actual: { type: Boolean, default: false } });
</script>

<template>
  <li class="tx" :class="{ actual }">
    <div class="tx-date"><div class="num-date">{{ formatTxDate(tx.date) }}</div><div class="weekday">{{ weekday(tx.date) }}</div></div>
    <div class="tx-body"><div class="title">{{ tx.description || "(no description)" }}</div><div class="sub"><slot name="details" /></div></div>
    <div class="tx-amount num"><div :class="{ neg: tx.amount < 0 }">{{ formatMoney(tx.amount) }}</div><div class="sub small"><slot name="extra" /></div></div>
    <div v-if="$slots.actions" class="tx-actions"><slot name="actions" /></div>
  </li>
</template>
