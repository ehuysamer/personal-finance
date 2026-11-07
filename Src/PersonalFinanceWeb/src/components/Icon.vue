<script setup>
defineProps({ name: { type: String, required: true } });
const paths = {
  upload: "M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z",
  chart: "M4 19h16M7 16V9m5 7V5m5 11v-4",
  trend: "M4 17l5-5 4 3 7-8m0 0h-5m5 0v5",
  chevron: "M9 6l6 6-6 6",
  back: "M15 6l-6 6 6 6",
  plus: "M12 5v14M5 12h14",
  logout: "M15 12H4m0 0l4-4m-4 4l4 4M14 5h4a2 2 0 012 2v10a2 2 0 01-2 2h-4",
  copy: "M8 8h10v12H8zM6 16H5a1 1 0 01-1-1V5a1 1 0 011-1h10a1 1 0 011 1v1",
  trash: "M5 7h14M10 11v6m4-6v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3",
  up: "M12 19V5m0 0l-6 6m6-6l6 6",
  down: "M12 5v14m0 0l-6-6m6 6l6-6",
  play: "M8 5v14l11-7z",
  edit: "M4 20h4L19 9l-4-4L4 16v4z",
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M20 12a8 8 0 11-2.3-5.7M20 4v5h-5"
};
</script>

<template>
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name]" /></svg>
</template>
