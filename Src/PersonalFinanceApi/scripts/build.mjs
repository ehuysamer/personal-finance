import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const build = path.join(root, "build");
await fs.rm(build, { recursive: true, force: true });
await fs.mkdir(build, { recursive: true });
for (const entry of ["src", "package.json", "package-lock.json"]) {
  await fs.cp(path.join(root, entry), path.join(build, entry), { recursive: true });
}
// Stamps the deployment for /v1/status: DEPLOY_FROM is set by the deploy script ("cobalt" on that host).
function git(...args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } }
const deployment = { from: process.env.DEPLOY_FROM || "desktop", date: new Date().toISOString(), sha: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD") };
await fs.writeFile(path.join(build, "src", "deployment.json"), `${JSON.stringify(deployment, null, 2)}\n`);
await new Promise((resolve, reject) => {
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev"], { cwd: build, stdio: "inherit", shell: process.platform === "win32" });
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`npm ci exited with ${code}`)));
  child.on("error", reject);
});
process.stdout.write(`Created ${build}\n`);
