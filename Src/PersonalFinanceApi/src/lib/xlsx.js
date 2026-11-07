import { inflateRawSync } from "node:zlib";
import HttpError from "../models/httpError.model.js";
import { entryData, readZipEntries } from "./zip.js";

// Minimal, dependency-free reader for .xlsx workbooks (a zip of SpreadsheetML parts).
// It returns cell values as stored: shared and inline strings, numbers as written (Excel dates
// stay serial day numbers), booleans as true/false, and error codes such as #N/A.

const MAX_PART_BYTES = 256 * 1024 * 1024;

function invalid(message) {
  return new HttpError(422, "ERR-XLSX", message);
}

function readPart(buffer, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const { method, size } = entry;
  if (size > MAX_PART_BYTES) throw invalid(`workbook part ${name} is too large`);
  const data = entryData(buffer, name, entry, (message) => invalid(message.replace("zip entry", "workbook part")));
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString("utf8");
  throw invalid(`workbook part ${name} uses unsupported compression ${method}`);
}

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, entity) => {
    const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[entity.toLowerCase()];
    if (named) return named;
    return String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  });
}

function attributes(text) {
  const result = {};
  for (const [, name, value] of text.matchAll(/([\w:]+)="([^"]*)"/g)) result[name] = decodeXml(value);
  return result;
}

// Concatenates the <t> runs of a string item, ignoring phonetic (<rPh>) runs.
function textRuns(xml) {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((match) => decodeXml(match[1] || "")).join("");
}

function columnIndex(reference) {
  let number = 0;
  for (const char of /^[A-Z]+/.exec(reference)[0]) number = number * 26 + char.charCodeAt(0) - 64;
  return number - 1;
}

function partPath(target) {
  const clean = target.replace(/^\//, "");
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

// Returns the worksheet as an array of rows (arrays of strings). Missing rows are empty arrays so
// row positions match the workbook.
export function readXlsxSheet(buffer, sheetName) {
  const entries = readZipEntries(buffer, (message) => invalid(message.replace("zip archive", "zip-based .xlsx workbook").replace("zip directory", "workbook zip directory").replace("ZIP64 archives", "ZIP64 workbooks")));
  const workbook = readPart(buffer, entries, "xl/workbook.xml");
  const relationships = readPart(buffer, entries, "xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw invalid("file is not an .xlsx workbook");
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((match) => attributes(match[1]));
  const sheet = sheetName ? sheets.find((item) => item.name === sheetName) : sheets[0];
  if (!sheet) throw invalid(`worksheet ${sheetName || "1"} was not found; available: ${sheets.map((item) => item.name).join(", ")}`);
  const targets = Object.fromEntries([...relationships.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((match) => attributes(match[1])).map((item) => [item.Id, item.Target]));
  const sheetXml = readPart(buffer, entries, partPath(targets[sheet["r:id"]] || ""));
  if (!sheetXml) throw invalid(`worksheet ${sheet.name} is missing from the workbook`);
  const sharedXml = readPart(buffer, entries, "xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((match) => textRuns(match[1] || "")) : [];

  const rows = [];
  let nextRow = 0;
  for (const [, rowAttributes, rowBody = ""] of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = attributes(rowAttributes).r ? Number(attributes(rowAttributes).r) - 1 : nextRow;
    nextRow = rowNumber + 1;
    const cells = [];
    let nextColumn = 0;
    for (const [, cellAttributes, cellBody = ""] of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cell = attributes(cellAttributes);
      const column = cell.r ? columnIndex(cell.r) : nextColumn;
      nextColumn = column + 1;
      const value = /<v>([\s\S]*?)<\/v>/.exec(cellBody)?.[1];
      let text = "";
      if (cell.t === "s") text = shared[Number(value)] ?? "";
      else if (cell.t === "inlineStr") text = textRuns(/<is>([\s\S]*?)<\/is>/.exec(cellBody)?.[1] || "");
      else if (cell.t === "b") text = value === "1" ? "true" : value === "0" ? "false" : "";
      else text = value === undefined ? "" : decodeXml(value);
      cells[column] = text;
    }
    rows[rowNumber] = Array.from(cells, (cell) => cell ?? "");
  }
  return Array.from(rows, (row) => row ?? []);
}

// Converts a zero-based column number to its Excel letters (0 -> A, 56 -> BE).
export function columnLetters(index) {
  let letters = "";
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) letters = String.fromCharCode(65 + ((number - 1) % 26)) + letters;
  return letters;
}

function csvField(value) {
  const text = String(value).replace(/\r?\n|\r/g, " ");
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// Renders a worksheet as CSV lines (one per worksheet row) for the line-based mapping engine.
export function xlsxToCsv(buffer, sheetName) {
  return readXlsxSheet(buffer, sheetName).map((row) => row.map(csvField).join(",")).join("\n");
}
