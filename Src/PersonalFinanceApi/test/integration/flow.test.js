import test from "node:test";
import assert from "node:assert/strict";
import { startTestApi } from "../helpers/server.js";

const b64 = (text) => Buffer.from(text).toString("base64");
// Made-up statements: March and April overlap on 2026-03-31; the coffee on 03-05 happens twice in one statement.
const MARCH = "Date,Details,Debit,Credit\n01/03/2026,SALARY ACME,,5000.00\n05/03/2026,Coffee Cart,4.50,\n05/03/2026,Coffee Cart,4.50,\n10/03/2026,Countdown 123,85.20,\n31/03/2026,Rent,2000.00,\n";
const APRIL = "Date,Details,Debit,Credit\n31/03/2026,Rent,2000.00,\n01/04/2026,SALARY ACME,,5000.00\n12/04/2026,Countdown 456,90.10,\n";

test("import, analyse, chart and forecast end to end", async (t) => {
  const api = await startTestApi();
  t.after(() => api.close());
  const me = await api.call("GET", "/v1/me");
  assert.equal(me.status, 200);
  const tenant = me.body.tenants[0].id;
  const T = `/v1/tenants/${tenant}`;

  const ds = await api.call("POST", `${T}/datasources`, { name: "ASB everyday" });
  assert.equal(ds.status, 201, JSON.stringify(ds.body));
  const D = `${T}/datasources/${ds.body.id}`;
  const translators = { date: { parts: [{ type: "column", column: "Date" }], format: "dd/MM/yyyy" }, account: { parts: [{ type: "fixed", value: "ASB 01" }] }, description: { parts: [{ type: "column", column: "Details" }] }, amount: { parts: [{ type: "column", column: "Credit" }, { type: "column", column: "Debit", negate: true }] } };
  const sample = await api.call("POST", `${D}/sample`, { filename: "asb-march.csv", contentBase64: b64(MARCH), format: "csv", translators });
  assert.equal(sample.status, 200, JSON.stringify(sample.body));
  assert.deepEqual(sample.body.columns, ["Date", "Details", "Debit", "Credit"]);
  assert.equal(sample.body.normalised[1].amount, -4.5);
  const source = await api.call("POST", `${D}/importsources`, { name: "ASB CSV", format: "csv", filenameFilter: { type: "wildcard", pattern: "asb-*.csv" }, translators });
  assert.equal(source.status, 201, JSON.stringify(source.body));

  const march = await api.call("POST", `${D}/files`, { filename: "asb-march.csv", contentBase64: b64(MARCH) });
  assert.equal(march.status, 201, JSON.stringify(march.body));
  assert.equal(march.body.added, 5);
  const april = await api.call("POST", `${D}/files`, { filename: "asb-april.csv", contentBase64: b64(APRIL) });
  assert.equal(april.body.added, 2);
  assert.equal(april.body.alreadyPresent, 1);
  const again = await api.call("POST", `${D}/files`, { filename: "asb-march.csv", contentBase64: b64(MARCH) });
  assert.equal(again.body.status, "replaced");
  const copy = await api.call("POST", `${D}/files`, { filename: "march-copy.csv", contentBase64: b64(MARCH) });
  assert.equal(copy.status, 409, "no importsource matches the copy's name");
  const sameContent = await api.call("POST", `${D}/files`, { filename: "asb-march-2.csv", contentBase64: b64(MARCH) });
  assert.equal(sameContent.body.status, "already-imported");
  const txs = await api.call("GET", `${D}/transactions`);
  assert.equal(txs.body.total, 7, "both coffees kept, the overlapping rent once");

  // The statement said 2950.00 at the end of March: 2905.80 from the rows plus an opening balance of 44.20.
  const total = await api.call("POST", `${D}/totals`, { date: "2026-03-31", account: "ASB 01", balance: 2950 });
  assert.equal(total.status, 201);

  const project = await api.call("POST", `${T}/projects`, { name: "Household", datasources: [ds.body.id], birthDate: "1980-06-15" });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const P = `${T}/projects/${project.body.id}`;
  const salary = await api.call("POST", `${P}/accounts`, { name: "Salary", category: "income", shortCode: "INC", tags: ["work"] });
  const food = await api.call("POST", `${P}/accounts`, { name: "Groceries", category: "food", shortCode: "FOOD" });
  const rent = await api.call("POST", `${P}/accounts`, { name: "Rent", category: "housing", shortCode: "RENT" });
  assert.equal(salary.status, 201, JSON.stringify(salary.body));
  await api.call("POST", `${P}/rules`, { name: "Salary", account: salary.body.id, conditions: [{ field: "description", op: "startswith", value: "salary" }] });
  await api.call("POST", `${P}/rules`, { name: "Supermarkets", account: food.body.id, conditions: [{ field: "description", op: "containsany", values: ["countdown", "new world"] }] });
  await api.call("POST", `${P}/rules`, { name: "Rent", account: rent.body.id, conditions: [{ field: "description", op: "wildcard", value: "rent*" }], amount: { max: 0 } });
  const tested = await api.call("POST", `${P}/rules-test`, { rule: { name: "coffee", account: food.body.id, conditions: [{ field: "description", op: "regex", value: "^coffee" }] } });
  assert.equal(tested.body.count, 2);

  const job = await api.call("POST", `${P}/analysis`);
  assert.equal(job.status, 202, JSON.stringify(job.body));
  await api.drain();
  const status = await api.call("GET", `${P}/jobs/${job.body.id}`);
  assert.equal(status.body.status, "complete", JSON.stringify(status.body));
  const analysis = await api.call("GET", `${P}/analysis`);
  assert.equal(analysis.body.lastDate, "2026-04-12");
  const uncategorised = await api.call("GET", `${P}/accounts/uncategorised/transactions`);
  assert.deepEqual(uncategorised.body.items.map((tx) => tx.description).sort(), ["Balance adjustment", "Coffee Cart", "Coffee Cart"]);
  assert.equal(uncategorised.body.items.find((tx) => tx.description === "Balance adjustment").amount, 44.2);
  const history = await api.call("GET", `${P}/accounts/${food.body.id}/transactions?pageSize=1`);
  assert.equal(history.body.total, 2);
  assert.equal(history.body.items[0].date, "2026-04-12", "newest first");
  assert.equal(history.body.items[0].running, -175.3);
  const aggregates = await api.call("GET", `${P}/accounts/${salary.body.id}/aggregates`);
  assert.deepEqual(aggregates.body.monthly.map((entry) => [entry.period, entry.sum, entry.running]), [["2026-03", 5000, 5000], ["2026-04", 5000, 10000]]);

  const chart = await api.call("POST", `${P}/charts`, { name: "Net", bucket: "monthly", series: [{ name: "INC", type: "account", ref: "INC", measure: "sum" }, { name: "SPEND", type: "category", ref: "food", measure: "sum" }, { name: "NET", type: "calculate", expression: "INC + SPEND" }] });
  assert.equal(chart.status, 201, JSON.stringify(chart.body));
  const data = await api.call("POST", `${P}/chart-data`, { id: chart.body.id });
  assert.deepEqual(data.body.buckets, ["2026-03", "2026-04"]);
  assert.deepEqual(data.body.series.find((series) => series.name === "NET").actual, [4914.8, 4909.9]);

  const forecast = await api.call("POST", `${P}/forecasts`, { name: "Base", frequency: "1m", horizon: { type: "duration", value: "1y" }, generators: [{ name: "Bonus", type: "linear", account: "INC", from: 1000, slopePerYear: 0, frequency: "1y" }] });
  assert.equal(forecast.status, 201, JSON.stringify(forecast.body));
  const run = await api.call("POST", `${P}/forecasts/${forecast.body.id}/run`);
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await api.drain();
  const runStatus = await api.call("GET", `${P}/jobs/${run.body.id}`);
  assert.equal(runStatus.body.status, "complete", JSON.stringify(runStatus.body));
  const results = await api.call("GET", `${P}/forecasts/${forecast.body.id}/results`);
  assert.equal(results.body.run.start, "2026-04-13");
  const forecastHistory = await api.call("GET", `${P}/accounts/${salary.body.id}/transactions?forecast=${forecast.body.id}&includeActuals=true&pageSize=100`);
  assert.ok(forecastHistory.body.items.some((tx) => tx.kind === "actual") && forecastHistory.body.items.some((tx) => tx.kind === "forecast"));
  assert.ok(forecastHistory.body.items.some((tx) => tx.source === "generator" && tx.amount === 1000));
  const forecastChart = await api.call("POST", `${P}/chart-data`, { id: chart.body.id, forecast: forecast.body.id });
  const inc = forecastChart.body.series.find((series) => series.name === "INC");
  assert.ok(inc.actual.some((value) => value !== null) && inc.forecast.some((value) => value !== null));
  const cloned = await api.call("POST", `${P}/forecasts/${forecast.body.id}/clone`, { name: "High inflation" });
  assert.equal(cloned.status, 201);
  assert.equal(cloned.body.generators.length, 1);
});

test("MCP lists a tool for every operation and runs them as the user", async (t) => {
  const api = await startTestApi();
  t.after(() => api.close());
  const list = await api.call("POST", "/v1/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = list.body.result.tools.map((tool) => tool.name);
  for (const name of ["datasource_create", "file_upload", "analysis_run", "chart_data", "forecast_run", "job_get"]) assert.ok(names.includes(name), name);
  const me = await api.call("POST", "/v1/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "me", arguments: {} } });
  const tenant = me.body.result.structuredContent.tenants[0].id;
  const created = await api.call("POST", "/v1/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "datasource_create", arguments: { tenant, name: "Kiwisaver" } } });
  assert.equal(created.body.result.structuredContent.id, "kiwisaver");
  const refused = await api.call("POST", "/v1/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project_get", arguments: { tenant } } });
  assert.equal(refused.body.result.isError, true);
});

test("an account that is not on the allow-list is refused", async (t) => {
  const api = await startTestApi({ localUserEmail: "someone@example.com" });
  t.after(() => api.close());
  const me = await api.call("GET", "/v1/me");
  assert.equal(me.status, 403);
});

test("the tenant import folder: listed with matching importsources, imported, then moved aside", async (t) => {
  const api = await startTestApi();
  t.after(() => api.close());
  const tenant = (await api.call("GET", "/v1/me")).body.tenants[0].id;
  const T = `/v1/tenants/${tenant}`;
  const reserved = await api.call("POST", `${T}/datasources`, { name: "Import" });
  assert.equal(reserved.body.id, "import-2", "import is the folder, not an id");
  const ds = (await api.call("POST", `${T}/datasources`, { name: "Visa" })).body;
  const translators = { date: { parts: [{ type: "column", column: "Date" }], format: "dd/MM/yyyy" }, account: { parts: [{ type: "fixed", value: "Visa" }] }, description: { parts: [{ type: "column", column: "Details" }] }, amount: { parts: [{ type: "column", column: "Amount" }] } };
  await api.call("POST", `${T}/datasources/${ds.id}/importsources`, { name: "Visa CSV", format: "csv", filenameFilter: "visa-*.csv", translators });
  await api.deps.store.put(`${tenant}/import/2026/visa-jan.csv`, "Date,Details,Amount\n02/01/2026,Cafe,-5\n");
  await api.deps.store.put(`${tenant}/import/unknown.csv`, "x\n1\n");
  const listed = await api.call("GET", `${T}/import-folder`);
  assert.deepEqual(listed.body.items.map((item) => [item.path, item.candidates.map((c) => c.importsource)]), [["2026/visa-jan.csv", ["visa-csv"]], ["unknown.csv", []]]);
  const imported = await api.call("POST", `${T}/import-folder/import`, { path: "2026/visa-jan.csv" });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.added, 1);
  assert.match(imported.body.movedTo, /^imported\/\d{4}-\d{2}-\d{2}\/2026\/visa-jan.csv$/);
  assert.deepEqual((await api.call("GET", `${T}/import-folder`)).body.items.map((item) => item.path), ["unknown.csv"]);
  const unmatched = await api.call("POST", `${T}/import-folder/import`, { path: "unknown.csv" });
  assert.equal(unmatched.status, 409);
  const escape = await api.call("POST", `${T}/import-folder/import`, { path: "../other/x.csv" });
  assert.equal(escape.status, 400);
});

test("documents: upload into folders, list, move, download, import a statement (it stays), delete", async (t) => {
  const api = await startTestApi();
  t.after(() => api.close());
  const tenant = (await api.call("GET", "/v1/me")).body.tenants[0].id;
  const T = `/v1/tenants/${tenant}`;
  const ds = (await api.call("POST", `${T}/datasources`, { name: "Visa" })).body;
  const translators = { date: { parts: [{ type: "column", column: "Date" }], format: "dd/MM/yyyy" }, account: { parts: [{ type: "fixed", value: "Visa" }] }, description: { parts: [{ type: "column", column: "Details" }] }, amount: { parts: [{ type: "column", column: "Amount" }] } };
  await api.call("POST", `${T}/datasources/${ds.id}/importsources`, { name: "Visa CSV", format: "csv", filenameFilter: "visa-*.csv", translators });
  const csv = Buffer.from("Date,Details,Amount\n02/01/2026,Cafe,-5\n").toString("base64");
  assert.equal((await api.call("POST", `${T}/documents`, { path: "statements/2026/visa-jan.csv", contentBase64: csv })).status, 201);
  assert.equal((await api.call("POST", `${T}/documents`, { path: "receipts/fridge.pdf", contentBase64: Buffer.from("%PDF-1.4").toString("base64") })).body.contentType, "application/pdf");
  assert.equal((await api.call("POST", `${T}/documents`, { path: "../escape.txt", contentBase64: csv })).status, 400);
  const top = await api.call("GET", `${T}/documents`);
  assert.deepEqual([top.body.folders, top.body.files.length], [["receipts", "statements"], 0]);
  assert.deepEqual((await api.call("GET", `${T}/documents?folder=statements/2026`)).body.files.map((file) => file.name), ["visa-jan.csv"]);
  assert.equal((await api.call("GET", `${T}/documents?q=fridge`)).body.files.length, 1);
  const candidates = await api.call("GET", `${T}/documents/candidates?path=statements/2026/visa-jan.csv`);
  assert.deepEqual(candidates.body.candidates.map((c) => c.datasource), [ds.id]);
  const imported = await api.call("POST", `${T}/documents/import`, { path: "statements/2026/visa-jan.csv" });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.added, 1);
  assert.equal((await api.call("GET", `${T}/datasources/${ds.id}/files`)).body.items[0].filename, "visa-jan.csv");
  assert.equal((await api.call("GET", `${T}/documents?folder=statements/2026`)).body.files.length, 1, "the document stays");
  await api.call("PUT", `${T}/documents/move`, { path: "receipts/fridge.pdf", to: "home/fridge receipt.pdf" });
  const download = await api.call("GET", `${T}/documents/download?path=${encodeURIComponent("home/fridge receipt.pdf")}`);
  assert.equal(Buffer.from(download.body.contentBase64, "base64").toString(), "%PDF-1.4");
  await api.call("DELETE", `${T}/documents?path=${encodeURIComponent("home/fridge receipt.pdf")}`);
  assert.deepEqual((await api.call("GET", `${T}/documents`)).body.folders, ["statements"]);
  const rebuilt = await api.call("POST", `${T}/indexes/rebuild`);
  assert.equal(rebuilt.body.documents, 1);
});
