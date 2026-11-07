// Pure helpers for the SVG line chart: scales, nice ticks and line paths. Gaps (null) break a line.
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) { const pad = Math.abs(min) || 1; min -= pad; max += pad; }
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) || raw;
  const ticks = [];
  for (let value = Math.floor(min / step) * step; value <= max + step * 0.001; value += step) ticks.push(Math.round(value / step) * step);
  return ticks;
}

export function extent(series) {
  const values = series.flatMap((item) => [...(item.actual || []), ...(item.forecast || [])]).filter((value) => value !== null && value !== undefined);
  if (!values.length) return [0, 1];
  return [Math.min(0, ...values), Math.max(0, ...values)];
}

// Points to a path; null values end a segment.
export function linePath(values, x, y) {
  let path = "";
  let drawing = false;
  values.forEach((value, i) => {
    if (value === null || value === undefined) { drawing = false; return; }
    path += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    drawing = true;
  });
  return path;
}

// A categorical palette that reads in light and dark themes.
export const PALETTE = ["#0f766e", "#2563eb", "#c2410c", "#7c3aed", "#be123c", "#4d7c0f", "#a16207", "#0369a1"];
export function colorFor(series, index) { return series.color || PALETTE[index % PALETTE.length]; }
