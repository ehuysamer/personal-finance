import test from "node:test";
import assert from "node:assert/strict";
import { extent, linePath, niceTicks } from "../../src/lib/chart.js";
import { describeFrequency, isFrequency } from "../../src/lib/format.js";
import { createApi } from "../../src/lib/api.js";

test("chart helpers: ticks, extent with forecasts, gaps break lines", () => {
  assert.deepEqual(niceTicks(0, 100), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(extent([{ actual: [1, null, 5], forecast: [null, null, -3] }]), [-3, 5]);
  assert.equal(linePath([1, null, 2, 3], (i) => i * 10, (v) => v), "M0.0,1.0M20.0,2.0L30.0,3.0");
});

test("frequencies in words", () => {
  assert.equal(describeFrequency("1w"), "weekly");
  assert.equal(describeFrequency("6m"), "every 6 months");
  assert.ok(isFrequency("1d") && !isFrequency("0d") && !isFrequency("1x"));
});

test("the API client sends the ID token and turns errors into Error with code and data", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: false, status: 409, statusText: "Conflict", text: async () => JSON.stringify({ code: "ERR-X", message: "nope", data: { a: 1 } }) }; };
  const api = createApi({ apiUrl: "https://api.example/" }, { idToken: async () => "token" }, fetchImpl);
  await assert.rejects(api.get("/v1/me", { q: "a b", empty: "" }), (error) => error.code === "ERR-X" && error.status === 409 && error.data.a === 1);
  assert.equal(calls[0].url, "https://api.example/v1/me?q=a+b");
  assert.equal(calls[0].options.headers.Authorization, "Bearer token");
});

test("money with its currency: dollar prefixes, other currencies by code", async () => {
  const { formatMoney, currencyLabel } = await import("../../src/lib/format.js");
  assert.equal(formatMoney(-1234.5, "NZD"), "-NZ$1,234.50");
  assert.equal(formatMoney(12, "USD"), "US$12.00");
  assert.equal(formatMoney(-12, "EUR"), "EUR -12.00");
  assert.equal(formatMoney(5), "5.00");
  assert.equal(currencyLabel("AUD"), "A$");
  assert.equal(currencyLabel("GBP"), "GBP");
});

test("accounts grouped under their categories, in the project's order", async () => {
  const { accountsByCategory, categoryName } = await import("../../src/lib/format.js");
  const categories = [{ id: "income", name: "Income" }, { id: "food", name: "Food" }, { id: "home", name: "Home" }];
  const accounts = [{ id: "g", name: "Groceries", category: "food" }, { id: "s", name: "Salary", category: "income" }, { id: "x", name: "Old", category: "gone" }];
  assert.deepEqual(accountsByCategory(accounts, categories).map((group) => [group.category.name, group.accounts.map((a) => a.name)]), [["Income", ["Salary"]], ["Food", ["Groceries"]], ["No category", ["Old"]]]);
  assert.equal(categoryName(accounts[0], categories), "Food");
});
