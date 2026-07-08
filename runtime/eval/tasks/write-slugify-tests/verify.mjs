import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const testPath = path.resolve("slugify.test.mjs");
assert.ok(existsSync(testPath), "slugify.test.mjs must exist in the repo root");

const good = spawnSync(process.execPath, [testPath], {
  cwd: process.cwd(),
  encoding: "utf8",
});
assert.equal(
  good.status,
  0,
  "tests must pass against the real slugify: " + good.stderr,
);

const mutated = mkdtempSync(path.join(os.tmpdir(), "slugify-mutation-"));
try {
  cpSync(process.cwd(), mutated, { recursive: true });
  cpSync(path.join(taskDir, "broken-slugify.js"), path.join(mutated, "slugify.js"));
  const bad = spawnSync(process.execPath, [path.join(mutated, "slugify.test.mjs")], {
    cwd: mutated,
    encoding: "utf8",
  });
  assert.notEqual(
    bad.status,
    0,
    "tests must fail against a broken slugify (they do not assert behavior)",
  );
} finally {
  rmSync(mutated, { recursive: true, force: true });
}
process.stdout.write("slugify tests are revert-sensitive\n");
