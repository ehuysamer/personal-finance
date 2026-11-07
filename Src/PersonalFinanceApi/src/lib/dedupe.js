// The same transaction can appear twice in one statement (both are real), but a transaction that appears in two
// statements (they overlap) is one transaction. So per natural key (date, account, description, amount) a
// datasource keeps as many rows as the largest count in any single file; the rows kept come from the files in
// import order, and each keeps its file and row.
export function naturalKey(row) { return [row.date, row.account || "", String(row.description || "").replace(/\s+/g, " ").trim().toLowerCase(), Number(row.amount).toFixed(2)].join("|"); }

function counts(rows) {
  const map = new Map();
  for (const row of rows) { const key = naturalKey(row); map.set(key, (map.get(key) || 0) + 1); }
  return map;
}

// files: [{ fileId, filename, rows }] in import order -> the datasource's rows.
export function mergeFiles(files) {
  const kept = new Map();
  const result = [];
  for (const file of files) {
    const seen = new Map();
    for (const row of file.rows) {
      const key = naturalKey(row);
      const occurrence = (seen.get(key) || 0) + 1;
      seen.set(key, occurrence);
      if (occurrence > (kept.get(key) || 0)) {
        kept.set(key, occurrence);
        result.push({ ...row, fileId: file.fileId, filename: file.filename, occurrence });
      }
    }
  }
  return result;
}

// What importing a file adds to the files already there: rows beyond the largest count so far are new.
export function importReport(existingFiles, rows) {
  const max = new Map();
  for (const file of existingFiles) for (const [key, count] of counts(file.rows)) max.set(key, Math.max(max.get(key) || 0, count));
  let added = 0;
  let present = 0;
  for (const [key, count] of counts(rows)) {
    const before = max.get(key) || 0;
    added += Math.max(0, count - before);
    present += Math.min(count, before);
  }
  return { added, alreadyPresent: present };
}
