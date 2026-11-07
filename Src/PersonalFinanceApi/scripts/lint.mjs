import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function visit(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) visit(full);
    if (item.isFile() && item.name.endsWith(".js")) {
      const text = fs.readFileSync(full, "utf8");
      if (/\t/.test(text)) failures.push(`${path.relative(root, full)} contains tabs`);
      if (/[ \t]+$/m.test(text)) failures.push(`${path.relative(root, full)} contains trailing whitespace`);
    }
  }
}
visit(path.join(root, "src"));
if (failures.length) throw new Error(failures.join("\n"));
process.stdout.write("Basic source checks passed.\n");
