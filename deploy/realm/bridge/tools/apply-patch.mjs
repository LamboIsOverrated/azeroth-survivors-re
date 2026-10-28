import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const here = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  target = process.argv[2];
if (!target || process.argv.slice(3).some((arg) => arg !== "--apply"))
  throw new Error("Usage: node apply-patch.mjs /clean/pinned/core [--apply]");
const root = resolve(target),
  manifest = JSON.parse(
    readFileSync(join(here, "core/pinned-sources.json"), "utf8"),
  );
function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr || "Git operation failed");
  return result.stdout.trim();
}
if (
  git(["rev-parse", "HEAD"]) !== manifest.revision ||
  git(["status", "--porcelain"])
)
  throw new Error("Only a clean exact-pinned source checkout is accepted");
for (const [file, want] of Object.entries(manifest.files)) {
  const bytes = readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
  if (createHash("sha256").update(bytes).digest("hex") !== want)
    throw new Error("Pinned source mismatch: " + file);
}
const patch = join(here, "core/world-bridge.patch");
git(["apply", "--check", patch]);
if (process.argv.includes("--apply")) {
  git(["apply", patch]);
  console.log(
    "Source patch applied. Full core compilation and MariaDB fault checks are still required.",
  );
} else
  console.log(
    "Exact revision, clean state, file hashes and patch applicability verified. No source changed.",
  );
