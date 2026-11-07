// Files from a drop, with their paths. The browser empties the drop's item list at the first await, so every item's
// entry (and plain file, for browsers without entries) is taken synchronously first; folders are then read
// recursively. Returns [{ file, path }] where path keeps a dropped folder's structure ("2026/visa-jan.csv").
export async function filesFromDrop(dataTransfer) {
  const taken = [...(dataTransfer?.items || [])].filter((item) => item.kind === "file").map((item) => ({ entry: item.webkitGetAsEntry?.() || null, file: item.getAsFile() }));
  if (!taken.length) return [...(dataTransfer?.files || [])].map((file) => ({ file, path: file.name }));
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) { out.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path: `${prefix}${entry.name}` }); return; }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  }
  for (const { entry, file } of taken) {
    if (entry) await walk(entry, "");
    else if (file) out.push({ file, path: file.name });
  }
  return out.filter(({ file }) => file && !file.name.startsWith("."));
}
