import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, parseFrequency, resolveHorizon, schedule } from "../../src/lib/frequency.js";
import { findRecurring, fitModel, modelValue, replay } from "../../src/lib/forecastModel.js";
import { generatorTransactions, limitsFor, validateGenerator } from "../../src/lib/generators.js";
import { seededRandom } from "../../src/lib/random.js";
import { aggregate, combineAggregates } from "../../src/lib/aggregate.js";

test("frequencies and horizons", () => {
  assert.deepEqual(parseFrequency("1w"), { n: 7, unit: "d", text: "1w" });
  assert.deepEqual(parseFrequency("6m"), { n: 6, unit: "m", text: "6m" });
  assert.throws(() => parseFrequency("0d"), { code: "ERR-FREQUENCY" });
  assert.throws(() => parseFrequency("2x"), { code: "ERR-FREQUENCY" });
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.deepEqual(schedule("2026-01-31", "2026-05-01", parseFrequency("1m")), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  assert.equal(resolveHorizon("2026-01-01", { type: "duration", value: "10y" }), "2036-01-01");
  assert.equal(resolveHorizon("2026-01-01", { type: "age", value: 65 }, "1980-06-15"), "2045-06-15");
  assert.throws(() => resolveHorizon("2026-01-01", { type: "duration", value: "101y" }), { code: "ERR-HORIZON" });
  assert.throws(() => schedule("2026-01-01", "2030-01-01", parseFrequency("1d"), 100), { code: "ERR-FORECAST-LIMIT" });
});

// Three years of made-up history: a monthly salary, weekly groceries growing 10% a year, irregular extras.
function history() {
  const txs = [];
  for (let m = 0; m < 36; m += 1) {
    const month = addMonths("2023-04-01", m);
    txs.push({ date: addMonths("2023-04-20", m), description: "SALARY ACME 0042", amount: 5000 });
    txs.push({ date: `${month.slice(0, 7)}-11`, description: `Shop ${String.fromCharCode(65 + ((m * 7) % 26))}`, amount: -400 * 1.1 ** (m / 12) });
  }
  return txs;
}

test("recurring transactions are found and replayed at their cadence", () => {
  const recurring = findRecurring(history(), "2026-03-31");
  const salary = recurring.find((item) => item.key === "salary acme #");
  assert.equal(salary.cadence, "monthly");
  const replayed = replay({ recurring: [salary], inflation: 0 }, "2026-03-31", "2026-07-01");
  assert.deepEqual(replayed.map((tx) => tx.date), ["2026-04-20", "2026-05-20", "2026-06-20"]);
});

test("the model takes out inflation, finds the trend and projects with it", () => {
  const terms = fitModel(history(), { asOf: "2026-03-31", inflation: 0.03, method: "replay+trend" });
  assert.ok(terms.recurring.some((item) => item.key === "salary acme #"), "salary is replayed, not trended");
  assert.ok(terms.base < 0, "groceries are spending");
  // 10% nominal growth less 3% inflation is about 7% real growth.
  assert.ok(terms.g > 0.05 && terms.g < 0.09, `g ${terms.g}`);
  const nextMonth = modelValue(terms, "2026-04-01", "2026-05-01", "2026-03-31");
  const inAYear = modelValue(terms, "2027-04-01", "2027-05-01", "2026-03-31");
  assert.ok(inAYear / nextMonth > 1.08 && inAYear / nextMonth < 1.12, "about 10% more a year later (real growth and inflation)");
  const half = modelValue(terms, "2026-04-01", "2026-04-16", "2026-03-31");
  assert.ok(Math.abs(half / nextMonth - 0.5) < 0.01, "a half-month period gets half the month");
  assert.equal(modelValue({ ...terms, method: "none" }, "2026-04-01", "2026-05-01", "2026-03-31"), 0);
});

test("generators: random, sine and linear add amounts; minimum and maximum are a floor and a cap", () => {
  const random = seededRandom(7);
  const frequency = parseFrequency("1m");
  const linear = validateGenerator({ name: "Raise", type: "linear", account: "INC", from: 100, to: 200 }, 0);
  const txs = generatorTransactions(linear, { start: "2026-01-01", end: "2026-03-01", frequency, random });
  assert.deepEqual(txs.map((tx) => tx.amount), [100, 152.54]);
  const noise = generatorTransactions(validateGenerator({ type: "random", account: "X", min: 1, max: 2 }, 0), { start: "2026-01-01", end: "2027-01-01", frequency, random });
  assert.ok(noise.length === 12 && noise.every((tx) => tx.amount >= 1 && tx.amount <= 2));
  const sine = generatorTransactions(validateGenerator({ type: "sine", account: "X", amplitude: 10, periodDays: 365 }, 0), { start: "2026-01-01", end: "2027-01-01", frequency: parseFrequency("3m"), random });
  assert.equal(sine[0].amount, 0);
  const retire = validateGenerator({ type: "maximum", account: "INC", value: 0, start: { age: 65 } }, 0);
  assert.deepEqual(limitsFor([retire], "2045-07-01", "1980-06-15"), { floor: null, cap: 0 });
  assert.deepEqual(limitsFor([retire], "2040-07-01", "1980-06-15"), { floor: null, cap: null });
  assert.throws(() => validateGenerator({ type: "wave", account: "X" }, 0), { code: "ERR-GENERATOR" });
});

test("aggregates: running totals and per-bucket stats; combined accounts", () => {
  const a = aggregate([{ date: "2026-01-02", amount: 10 }, { date: "2026-01-20", amount: -4 }, { date: "2026-04-01", amount: 6 }]);
  assert.deepEqual(a.monthly.map((e) => [e.period, e.sum, e.count, e.avg, e.min, e.max, e.running]), [["2026-01", 6, 2, 3, -4, 10, 6], ["2026-04", 6, 1, 6, 6, 6, 12]]);
  assert.deepEqual(a.quarterly.map((e) => e.period), ["2026-Q1", "2026-Q2"]);
  const b = aggregate([{ date: "2026-02-01", amount: 1 }]);
  assert.deepEqual(combineAggregates([a, b], "monthly").map((e) => [e.period, e.sum, e.running]), [["2026-01", 6, 6], ["2026-02", 1, 7], ["2026-04", 6, 13]]);
});
