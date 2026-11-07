import HttpError from "../models/httpError.model.js";
import { readXlsxSheet } from "./xlsx.js";

export const FORMATS = ["csv", "json", "xlsx"];

function invalid(message) { return new HttpError(422, "ERR-PARSE", message); }

// RFC 4180 CSV: quoted fields with "" escapes and line breaks inside quotes.
export function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === "\"") { if (text[i + 1] === "\"") { field += "\""; i += 1; } else quoted = false; }
      else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function dotPath(value, path) { return String(path || "").split(".").filter(Boolean).reduce((current, part) => (current == null ? undefined : current[part]), value); }

function decode(buffer, encoding = "utf-8") {
  const text = new TextDecoder(encoding === "latin1" ? "latin1" : encoding).decode(buffer);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Table rows from a grid: skipRows lines are dropped (bank exports often start with account details), then the
// first row is the header unless hasHeader is false (columns are then "1", "2", ...).
function fromGrid(grid, options) {
  const rest = grid.slice(Number(options.skipRows || 0));
  if (!rest.length) return { columns: [], rows: [] };
  const width = Math.max(...rest.map((cells) => cells.length));
  const header = options.hasHeader === false ? Array.from({ length: width }, (_, i) => String(i + 1)) : rest[0].map((cell, i) => String(cell ?? "").trim() || String(i + 1));
  const columns = header.map((name, i) => (header.indexOf(name) === i ? name : `${name} (${i + 1})`));
  const body = options.hasHeader === false ? rest : rest.slice(1);
  return { columns, rows: body.map((cells) => Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ""]))) };
}

// A file as { columns, rows: [{ column: value }] }. options: csv { delimiter, encoding, skipRows, hasHeader },
// json { rowsPath } (default: the root array or the first array property), xlsx { sheet, skipRows, hasHeader }.
export function parseFile(buffer, format, options = {}, { maxRows = 200000 } = {}) {
  let table;
  if (format === "csv") {
    const text = decode(buffer, options.encoding);
    let delimiter = options.delimiter;
    if (!delimiter) { const first = text.split(/\r?\n/, 1)[0]; delimiter = [",", ";", "\t", "|"].sort((a, b) => first.split(b).length - first.split(a).length)[0]; }
    table = fromGrid(parseCsv(text, delimiter === "\\t" ? "\t" : delimiter), options);
  } else if (format === "xlsx") {
    table = fromGrid(readXlsxSheet(buffer, options.sheet || undefined).map((cells) => cells.map((cell) => (cell === null || cell === undefined ? "" : cell))), options);
  } else if (format === "json") {
    let data;
    try { data = JSON.parse(decode(buffer, options.encoding)); } catch { throw invalid("file is not valid JSON"); }
    let rows = options.rowsPath ? dotPath(data, options.rowsPath) : Array.isArray(data) ? data : Object.values(data || {}).find(Array.isArray);
    if (!Array.isArray(rows)) throw invalid(options.rowsPath ? `${options.rowsPath} is not an array` : "no array of rows found; set rowsPath");
    rows = rows.filter((row) => row && typeof row === "object").map((row) => flatten(row));
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    table = { columns, rows };
  } else throw invalid(`format must be one of ${FORMATS.join(", ")}`);
  if (table.rows.length > maxRows) throw new HttpError(413, "ERR-TOO-MANY-ROWS", `the file has ${table.rows.length} rows; at most ${maxRows} are allowed`);
  return table;
}

// Nested JSON objects become dot-path columns ({ a: { b: 1 } } -> "a.b").
function flatten(value, prefix = "", out = {}) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) flatten(item, name, out);
    else out[name] = Array.isArray(item) ? JSON.stringify(item) : item;
  }
  return out;
}
