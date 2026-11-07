import { createHash } from "node:crypto";

// Seeds as in Timeseries: the time (fixed when first saved), a number, or a codeword (reversed, then hashed).
export function resolveSeed(seed = {}) {
  if (seed.mode === "number") return Number(seed.value) >>> 0;
  if (seed.mode === "codeword") return createHash("sha256").update(String(seed.value || "").split("").reverse().join("")).digest().readUInt32LE(0);
  return Number(seed.value || 1) >>> 0;
}
export function seededRandom(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(random) { const u = Math.max(random(), 1e-12); const v = random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
export function seedFor(base, text) { return (base ^ createHash("sha256").update(String(text)).digest().readUInt32LE(0)) >>> 0; }
