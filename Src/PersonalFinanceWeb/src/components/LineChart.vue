<script setup>
import { computed, ref } from "vue";
import { colorFor, extent, linePath, niceTicks } from "../lib/chart.js";
import { formatCompact, formatMoney } from "../lib/format.js";

// Lines per series over buckets: actuals solid, forecasts dotted. Tap or hover a bucket to read its values.
const props = defineProps({ data: { type: Object, required: true } });
const width = 640;
const height = 300;
const pad = { left: 52, right: 12, top: 12, bottom: 34 };
const active = ref(null);

const buckets = computed(() => props.data.buckets || []);
const series = computed(() => props.data.series || []);
const scale = computed(() => {
  const [min, max] = extent(series.value);
  const ticks = niceTicks(min, max);
  const low = Math.min(min, ticks[0]);
  const high = Math.max(max, ticks.at(-1));
  const n = Math.max(1, buckets.value.length - 1);
  const x = (i) => pad.left + (i / n) * (width - pad.left - pad.right);
  const y = (value) => pad.top + (1 - (value - low) / (high - low || 1)) * (height - pad.top - pad.bottom);
  return { ticks, x, y };
});
const labels = computed(() => {
  const every = Math.max(1, Math.ceil(buckets.value.length / 6));
  return buckets.value.map((bucket, i) => ({ bucket, i })).filter(({ i }) => i % every === 0);
});
function pick(event) {
  const box = event.currentTarget.getBoundingClientRect();
  const ratio = ((event.clientX - box.left) / box.width * width - pad.left) / (width - pad.left - pad.right);
  active.value = Math.max(0, Math.min(buckets.value.length - 1, Math.round(ratio * (buckets.value.length - 1))));
}
</script>

<template>
  <figure style="margin: 0">
    <svg :viewBox="`0 0 ${width} ${height}`" width="100%" role="img" :aria-label="data.name" style="touch-action: pan-y; display: block" @pointermove="pick" @pointerdown="pick" @pointerleave="active = null">
      <g v-for="tick in scale.ticks" :key="tick">
        <line :x1="pad.left" :x2="width - pad.right" :y1="scale.y(tick)" :y2="scale.y(tick)" stroke="var(--border)" :stroke-width="tick === 0 ? 1.5 : 1" />
        <text :x="pad.left - 6" :y="scale.y(tick) + 4" text-anchor="end" font-size="11" fill="var(--muted)">{{ formatCompact(tick) }}</text>
      </g>
      <text v-for="label in labels" :key="label.bucket" :x="scale.x(label.i)" :y="height - 12" text-anchor="middle" font-size="11" fill="var(--muted)">{{ label.bucket }}</text>
      <template v-for="(item, index) in series" :key="item.name">
        <path v-if="item.actual" :d="linePath(item.actual, scale.x, scale.y)" fill="none" :stroke="colorFor(item, index)" stroke-width="2" stroke-linejoin="round" />
        <path v-if="item.forecast" :d="linePath(item.forecast, scale.x, scale.y)" fill="none" :stroke="colorFor(item, index)" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round" />
      </template>
      <line v-if="active !== null" :x1="scale.x(active)" :x2="scale.x(active)" :y1="pad.top" :y2="height - pad.bottom" stroke="var(--muted)" stroke-dasharray="3 3" />
    </svg>
    <figcaption class="small">
      <div class="row" style="gap: 12px">
        <span v-for="(item, index) in series" :key="item.name" class="row" style="gap: 6px"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" :stroke="colorFor(item, index)" stroke-width="2" /></svg>{{ item.label }}</span>
        <span v-if="series.some((item) => item.forecast)" class="row muted" style="gap: 6px"><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="currentColor" stroke-width="2" stroke-dasharray="2 4" /></svg>forecast</span>
      </div>
      <div v-if="active !== null" class="card" style="margin: 6px 0 0">
        <strong>{{ buckets[active] }}</strong>
        <div v-for="(item, index) in series" :key="item.name" class="spread"><span :style="{ color: colorFor(item, index) }">{{ item.label }}</span><span class="num">
          <template v-if="item.actual?.[active] !== null && item.actual?.[active] !== undefined">{{ formatMoney(item.actual[active]) }}</template>
          <template v-if="item.forecast?.[active] !== null && item.forecast?.[active] !== undefined"> <em class="muted">forecast</em> {{ formatMoney(item.forecast[active]) }}</template>
        </span></div>
      </div>
    </figcaption>
  </figure>
</template>
