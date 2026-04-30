#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const matrixPath = path.join(repoRoot, "parity", "openclaude-memory-parity.json");
const skillCheckerPath =
  "/home/tetsuo/.codex/skills/implementation-contract/scripts/check_contract.mjs";

const contractResult = spawnSync(
  process.execPath,
  [
    skillCheckerPath,
    "--matrix",
    matrixPath,
    "--require-inventory",
    "--require-source-snapshot",
    ...process.argv.slice(2)
  ],
  { stdio: "inherit" }
);

if ((contractResult.status ?? 1) !== 0) {
  process.exit(contractResult.status ?? 1);
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const matrixDir = path.dirname(matrixPath);
const targetRoot = path.resolve(matrixDir, matrix.targetRoot);
const errors = [];

for (const rel of matrix.removedFiles ?? []) {
  const absolute = path.resolve(targetRoot, rel);
  if (fs.existsSync(absolute)) {
    errors.push(`removedFiles still exists: ${rel}`);
  }
}

const brandPattern =
  /\b(OpenClaude|Claude|CLAUDE|claude|claudemd|getClaudeConfigHomeDir|CLAUDE\.md)\b/;
for (const rel of matrix.targetFiles ?? []) {
  const absolute = path.resolve(targetRoot, rel);
  if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
    continue;
  }
  const text = fs.readFileSync(absolute, "utf8");
  const match = text.match(brandPattern);
  if (match) {
    errors.push(`target file contains non-AgenC branding '${match[0]}': ${rel}`);
  }
}

if (errors.length > 0) {
  console.error("openclaude-memory-parity failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}
