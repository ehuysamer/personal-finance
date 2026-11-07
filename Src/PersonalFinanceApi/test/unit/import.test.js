import test from "node:test";
import assert from "node:assert/strict";
import { parseAmount, parseDate, translateRows, validateTranslators } from "../../src/lib/translate.js";
import { parseCsv, parseFile } from "../../src/lib/parse.js";
import { filenameMatches, compileTextCondition, safeRegex } from "../../src/lib/match.js";
import { importReport, mergeFiles } from "../../src/lib/dedupe.js";
import { balanceAdjustments } from "../../src/lib/balance.js";

test("dates in the supported formats", () => {
  assert.equal(parseDate("05/03/2026", "dd/MM/yyyy"), "2026-03-05");
  assert.equal(parseDate("03/05/2026", "MM/dd/yyyy"), "2026-03-05");
  assert.equal(parseDate("5 Mar 2026", "d MMM yyyy"), "2026-03-05");
  assert.equal(parseDate("Mar 5, 2026", "MMM d, yyyy"), "2026-03-05");
  assert.equal(parseDate("20260305", "yyyyMMdd"), "2026-03-05");
  assert.equal(parseDate(46086, "excel"), "2026-03-05");
  assert.equal(parseDate("2026-03-05T10:00:00", "auto"), "2026-03-05");
  assert.equal(parseDate("5/3/26", "auto"), "2026-03-05", "auto is day first");
  assert.equal(parseDate("31/02/2026", "dd/MM/yyyy"), null, "no 31 February");
});

test("amounts with symbols, thousands, brackets and DR/CR", () => {
  assert.equal(parseAmount("$1,234.50"), 1234.5);
  assert.equal(parseAmount("(12.00)"), -12);
  assert.equal(parseAmount("45.10 DR"), -45.1);
  assert.equal(parseAmount("45.10CR"), 45.1);
  assert.equal(parseAmount("12.5-"), -12.5);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("n/a"), null);
});

test("CSV with quotes, embedded commas and line breaks; header skipping", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n'), [["a", "b"], ["x, y", 'say "hi"\nthere']]);
  const table = parseFile(Buffer.from("Account 12-3456\n\nDate;Amount\n01/01/2026;5\n"), "csv", { skipRows: 1, delimiter: ";" });
  assert.deepEqual(table.columns, ["Date", "Amount"]);
  assert.deepEqual(table.rows, [{ Date: "01/01/2026", Amount: "5" }]);
});

test("JSON rows (nested values become dot paths) and the row limit", () => {
  const table = parseFile(Buffer.from(JSON.stringify({ data: { items: [{ when: "2026-01-02", value: { amount: 3 } }] } })), "json", { rowsPath: "data.items" });
  assert.deepEqual(table.rows, [{ when: "2026-01-02", "value.amount": 3 }]);
  assert.throws(() => parseFile(Buffer.from("a\n1\n2\n3\n"), "csv", {}, { maxRows: 2 }), { code: "ERR-TOO-MANY-ROWS" });
});

test("translators join text parts in order, add amount parts and use fixed values", () => {
  const translators = validateTranslators({
    date: { parts: [{ type: "column", column: "d" }], format: "dd/MM/yyyy" },
    account: { parts: [{ type: "fixed", value: "Visa" }] },
    description: { parts: [{ type: "column", column: "payee" }, { type: "column", column: "memo" }], separator: " - " },
    amount: { parts: [{ type: "column", column: "credit" }, { type: "column", column: "debit", negate: true }] }
  });
  const { rows, rejected } = translateRows([{ d: "02/01/2026", payee: "Shop", memo: "", credit: "", debit: "10.00" }, { d: "bad", payee: "x", memo: "y", credit: "1", debit: "" }], translators);
  assert.deepEqual(rows, [{ account: "Visa", description: "Shop", date: "2026-01-02", amount: -10, row: 1 }]);
  assert.equal(rejected[0].row, 2);
  assert.throws(() => validateTranslators({ date: { parts: [] }, amount: { parts: [] }, description: { parts: [] } }), { code: "ERR-TRANSLATOR" });
});

test("filename filters and text conditions", () => {
  assert.ok(filenameMatches({ type: "wildcard", pattern: "ASB-*-????.csv" }, "asb-everyday-2026.csv"));
  assert.ok(!filenameMatches({ type: "wildcard", pattern: "ASB-*-????.csv" }, "asb-everyday-26.csv"));
  assert.ok(filenameMatches({ type: "regex", pattern: "^kiwi.*\\.xlsx$" }, "Kiwisaver March.xlsx"));
  assert.ok(compileTextCondition({ op: "containsall", values: ["pak", "save"] })("PAK N SAVE Albany"));
  assert.ok(!compileTextCondition({ op: "containsall", values: ["pak", "world"] })("PAK N SAVE Albany"));
  assert.ok(compileTextCondition({ op: "containsany", values: ["pak", "world"] })("New World"));
  assert.ok(compileTextCondition({ op: "exact", value: "rent", not: true })("Rent payment"));
  assert.ok(!compileTextCondition({ op: "startswith", value: "Rent", caseSensitive: true })("rent"));
  assert.throws(() => safeRegex("(a+)+$"), { code: "ERR-REGEX" });
});

test("duplicates: repeats within a statement are kept, overlaps between statements are not", () => {
  const coffee = { date: "2026-03-05", account: "A", description: "Coffee", amount: -4.5 };
  const rent = { date: "2026-03-31", account: "A", description: "Rent", amount: -2000 };
  const march = { fileId: "m", filename: "march.csv", rows: [coffee, coffee, rent] };
  const april = { fileId: "a", filename: "april.csv", rows: [rent, coffee] };
  const merged = mergeFiles([march, april]);
  assert.equal(merged.length, 3);
  assert.ok(merged.every((row) => row.fileId === "m"));
  assert.deepEqual(importReport([march], april.rows), { added: 0, alreadyPresent: 2 });
  assert.deepEqual(importReport([april], march.rows), { added: 1, alreadyPresent: 2 });
});

test("totals are the source of truth: balance adjustments make up the difference", () => {
  const txs = [{ date: "2026-01-05", account: "A", amount: -50 }, { date: "2026-02-05", account: "A", amount: 100 }];
  const adjustments = balanceAdjustments(txs, [{ id: "t1", date: "2026-01-31", account: "A", balance: 950 }, { id: "t2", date: "2026-02-28", account: "A", balance: 1050 }, { id: "t3", date: "2026-02-28", account: "B", balance: 10 }]);
  assert.deepEqual(adjustments.map((tx) => [tx.account, tx.date, tx.amount]), [["A", "2026-01-31", 1000], ["B", "2026-02-28", 10]]);
});
