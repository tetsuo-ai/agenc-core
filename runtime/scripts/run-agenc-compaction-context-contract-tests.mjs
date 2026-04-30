#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const matrixPath = path.join(repoRoot, "runtime/parity/agenc-compaction-context.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const tests = [...new Set(matrix.rows.flatMap((row) => row.tests ?? []))];

if (tests.length === 0) {
  console.error("Implementation contract FAILED: no row tests are listed");
  process.exit(1);
}

const runtimeRelativeTests = [];
for (const testPath of tests) {
  const absolutePath = path.join(repoRoot, testPath);
  if (!fs.existsSync(absolutePath)) {
    console.error(`Implementation contract FAILED: test file missing: ${testPath}`);
    process.exit(1);
  }
  if (!testPath.startsWith("runtime/")) {
    console.error(`Implementation contract FAILED: contract test must live under runtime/: ${testPath}`);
    process.exit(1);
  }
  runtimeRelativeTests.push(testPath.slice("runtime/".length));
}

const result = spawnSync(
  "npm",
  ["exec", "--workspace=@tetsuo-ai/runtime", "--", "vitest", "run", ...runtimeRelativeTests],
  {
    cwd: repoRoot,
    stdio: "inherit"
  }
);

process.exit(result.status ?? 1);
