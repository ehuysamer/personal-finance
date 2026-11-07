// Playwright journey on a phone: the local API (offline mode, a throwaway data folder) and the Vite dev server,
// then Import -> Accounts -> Analysis -> Forecast through the UI. Run with NODE_PATH=$(npm root -g) on cobalt.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// require (not import) so NODE_PATH finds the machine's global Playwright.
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../..");
const apiDir = path.resolve(web, "../PersonalFinanceApi");
const fixture = path.join(apiDir, "test/fixtures/sample-statement.csv");
const data = await mkdtemp(path.join(os.tmpdir(), "pf-e2e-"));
const apiPort = 4290;
const webPort = 5191;
const children = [];
function start(command, args, cwd, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const timer = setTimeout(() => reject(new Error(`${command} did not start`)), 30000);
    const onData = (chunk) => { if (ready.test(String(chunk))) { clearTimeout(timer); resolve(child); } };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
  });
}
const shots = process.env.E2E_SHOTS || "";
// Drops several made-up files at once on an element (a real DataTransfer with File objects, as a browser builds it).
async function dropFiles(page, selector, files) {
  await page.locator(selector).first().evaluate((element, list) => {
    const data = new DataTransfer();
    for (const { name, text } of list) data.items.add(new File([text], name, { type: "text/csv" }));
    element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
}
let failed = false;
let page;
try {
  await start("node", ["src/index.js", "--port", String(apiPort)], apiDir, { PERSONALFINANCE_LOCAL_DATA_DIR: data, PERSONALFINANCE_LOCAL_AUTH: "true" }, /listening/);
  await start("node", [path.join(web, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], web, { PERSONALFINANCE_API_URL: `http://127.0.0.1:${apiPort}` }, /Local:/);
  const browser = await chromium.launch();
  page = await browser.newPage({ ...devices["iPhone 13"] });
  page.on("dialog", (dialog) => dialog.accept());
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true }); };
  await page.goto(`http://127.0.0.1:${webPort}/#/import`);

  // Import: datasource, importsource from a sample, upload.
  await page.getByRole("button", { name: "New" }).click();
  await page.getByPlaceholder("ASB everyday").fill("ASB everyday");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("heading", { name: "ASB everyday" }).waitFor();
  await page.getByRole("button", { name: "Importsources" }).click();
  await page.getByRole("button", { name: "New importsource" }).click();
  await page.locator("input[type=file]").first().setInputFiles(fixture);
  await page.getByText("10 rows, columns: Date, Details, Debit, Credit").waitFor();
  await page.getByRole("button", { name: "Preview with this mapping" }).click();
  await page.getByRole("cell", { name: "-120.40" }).waitFor();
  await shot("1-importsource");
  await page.getByRole("button", { name: "Save importsource" }).click();
  await page.getByText("sample-statement").first().waitFor();
  await page.getByRole("button", { name: "Files" }).click();
  await page.locator("input[type=file]").setInputFiles(fixture);
  await page.getByText("imported: 10 added").waitFor();
  await shot("2-files");

  // Accounts: project (all datasources ticked by default), accounts.
  await page.getByRole("link", { name: "Accounts" }).click();
  await page.getByPlaceholder("Household").fill("Household");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("heading", { name: "Household" }).waitFor();
  for (const [name, category, code] of [["Salary", "Income", "INC"], ["Groceries", "Food", "FOOD"], ["Rent", "Housing", "RENT"]]) {
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByPlaceholder("Groceries").fill(name);
    await page.getByLabel("Category").selectOption({ label: category });
    await page.getByPlaceholder("FOOD").fill(code);
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText(name, { exact: true }).waitFor();
  }
  await shot("3-accounts");

  // Analysis: a rule (tested), analyse, a chart, history.
  await page.getByRole("link", { name: "Analysis" }).click();
  await page.getByRole("button", { name: "Rules" }).click();
  for (const [name, account, value] of [["Salary", "Salary", "salary"], ["Supermarkets", "Groceries", "countdown, new world"], ["Rent", "Rent", "rent"]]) {
    await page.getByRole("button", { name: "Rule", exact: true }).click();
    await page.getByPlaceholder("Supermarkets").fill(name);
    await page.getByLabel("Into account").selectOption({ label: account });
    if (value.includes(",")) await page.getByLabel("Match", { exact: true }).selectOption("containsany");
    await page.getByLabel("Value", { exact: true }).fill(value);
    await page.getByRole("button", { name: "Test" }).click();
    await page.getByText(/transactions match/).waitFor();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText(`→ ${account}`).waitFor();
  }
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Analyse" }).click();
  await page.getByText("Last analysed").waitFor({ timeout: 20000 });
  await page.getByText("15,000.00").waitFor();
  await shot("4-analysis");
  await page.getByRole("button", { name: "Charts" }).click();
  await page.getByRole("button", { name: "New chart" }).click();
  await page.getByPlaceholder("Income and spending").fill("Salary");
  await page.getByRole("button", { name: "Save chart" }).click();
  await page.locator("svg[role=img] path").first().waitFor();
  await shot("5-chart");
  await page.getByRole("button", { name: "History" }).click();
  await page.getByLabel("Account").selectOption({ label: "Groceries" });
  await page.getByText("New World").waitFor();

  // Forecast: create, run, see transactions with actuals greyed and the chart with a dotted forecast.
  await page.getByRole("link", { name: "Forecast" }).click();
  await page.getByRole("button", { name: "New" }).click();
  await page.getByPlaceholder("Base case").fill("Base case");
  await page.getByRole("button", { name: "Save forecast" }).click();
  await page.getByRole("heading", { name: "Base case" }).waitFor();
  await page.getByRole("button", { name: "Run" }).click();
  await page.getByText("Last run").waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Transactions" }).click();
  await page.getByLabel("Account").selectOption({ label: "Salary" });
  await page.getByText("replayed (monthly)").first().waitFor();
  // Newest first, the actuals are on the last page; oldest first they lead.
  await page.getByLabel("Order").selectOption("asc");
  await page.locator("li.actual").first().waitFor();
  await shot("6-forecast-transactions");
  await page.getByRole("button", { name: "Charts" }).click();
  await page.locator("svg[role=img] path[stroke-dasharray]").first().waitFor();
  await shot("7-forecast-chart");
  await page.getByRole("button", { name: "Model" }).click();
  await page.getByText(/SALARY ACME: 5,000.00 monthly/).waitFor();

  // Documents: add a statement, see it, import it (it stays), and find it from a datasource's Files tab.
  await page.getByRole("link", { name: "Documents" }).click();
  await page.getByRole("heading", { name: "Documents" }).waitFor();
  await page.locator("input[type=file]").setInputFiles(fixture);
  await page.getByText("sample-statement.csv: saved").waitFor();
  // Several files dropped at once are all saved.
  const statement = (day) => ({ name: `sample-drop-${day}.csv`, text: `Date,Details,Debit,Credit\n${day}/04/2026,Drop ${day},1.00,\n` });
  await dropFiles(page, "section.dropzone", [statement("01"), statement("02"), statement("03")]);
  for (const day of ["01", "02", "03"]) await page.getByText(`sample-drop-${day}.csv: saved`).waitFor();
  await page.locator("li", { hasText: "sample-statement.csv" }).getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Import", exact: true }).click();
  await page.getByText(/already imported|imported again into|imported into/).waitFor();
  await shot("8-documents-import");
  await page.getByRole("dialog").getByLabel("Close").click();
  await page.getByRole("link", { name: "Import" }).click();
  await page.getByText("ASB everyday").click();
  // Several statements dropped at once on the Files tab are all imported.
  await dropFiles(page, "div.dropzone", [statement("04"), statement("05")]);
  // Their names match no filename filter: one choice imports both.
  await page.getByRole("dialog", { name: "Which importsource for 2 files?" }).getByText("sample-statement", { exact: true }).click();
  for (const day of ["04", "05"]) await page.getByText(new RegExp(`sample-drop-${day}.csv: imported`)).waitFor();
  await page.getByRole("button", { name: "From documents" }).click();
  await page.getByRole("dialog").getByText("sample-statement.csv").first().waitFor();
  await shot("9-from-documents");
  // An importsource's sample from Documents, then from a dropped file.
  await page.getByRole("dialog").getByLabel("Close").click();
  await page.getByRole("button", { name: "Importsources" }).click();
  await page.getByRole("button", { name: "New importsource" }).click();
  await page.getByRole("button", { name: "From documents" }).click();
  await page.getByRole("dialog", { name: "Sample from documents" }).getByText("sample-statement.csv").first().click();
  await page.getByText("Sample: sample-statement.csv").waitFor();
  await page.getByText("10 rows, columns: Date, Details, Debit, Credit").waitFor();
  await dropFiles(page, "div.dropzone.sample", [statement("06")]);
  await page.getByText("Sample: sample-drop-06.csv").waitFor();
  await page.getByText("1 rows, columns: Date, Details, Debit, Credit").waitFor();
  await shot("10-sample-sources");
  await browser.close();
  console.log("e2e: passed");
} catch (error) {
  failed = true;
  console.error("e2e: failed:", error.message);
  if (shots && page) await page.screenshot({ path: path.join(shots, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  for (const child of children) child.kill();
  await rm(data, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
