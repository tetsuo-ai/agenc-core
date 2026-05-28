#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const matrixPath = path.join(repoRoot, "parity", "agent-surface-contract.json");
const reviewsDir = path.join(repoRoot, "parity", "agent-surface-contract.reviews");
const rowReviewMode = process.env.AGENC_AGENT_SURFACE_CONTRACT_ROW_REVIEW === "1";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function arrayOfStrings(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "");
}

function fail(errors) {
  for (const error of errors) {
    console.error(`agent-surface-contract: ${error}`);
  }
  process.exit(1);
}

function verifyVerdict(filePath, label, errors) {
  if (!existsSync(filePath)) {
    errors.push(`${label} review is missing: ${path.relative(repoRoot, filePath)}`);
    return;
  }
  const verdict = readJson(filePath);
  if (verdict.verdict !== "APPROVED") {
    errors.push(`${label} review must be APPROVED`);
  }
}

const argv = process.argv.slice(2);
const runCommands = argv.includes("--run-commands") || !argv.includes("--no-run-commands");
const requireReviews = !rowReviewMode && !argv.includes("--no-require-reviews");
const commandTimeoutArg = argv.indexOf("--command-timeout-ms");
const commandTimeoutMs =
  commandTimeoutArg >= 0 ? Number(argv[commandTimeoutArg + 1]) : 180_000;
if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
  fail([`invalid --command-timeout-ms value: ${argv[commandTimeoutArg + 1]}`]);
}

const matrix = readJson(matrixPath);
const sourceRoot = path.resolve(path.dirname(matrixPath), matrix.sourceRoot);
const targetRoot = path.resolve(path.dirname(matrixPath), matrix.targetRoot);
const errors = [];

for (const field of ["contractName", "scope", "sourceRoot", "sourceCommit", "targetRoot"]) {
  if (typeof matrix[field] !== "string" || matrix[field].trim() === "") {
    errors.push(`top-level ${field} must be a non-empty string`);
  }
}
if (!existsSync(sourceRoot)) errors.push(`sourceRoot does not exist: ${sourceRoot}`);
if (!existsSync(targetRoot)) errors.push(`targetRoot does not exist: ${targetRoot}`);
if (!Array.isArray(matrix.sourceFiles) || matrix.sourceFiles.length === 0) {
  errors.push("sourceFiles must be a non-empty array");
}
if (!Array.isArray(matrix.targetFiles) || matrix.targetFiles.length === 0) {
  errors.push("targetFiles must be a non-empty array");
}
if (!Array.isArray(matrix.testFiles) || matrix.testFiles.length === 0) {
  errors.push("testFiles must be a non-empty array");
}
if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) {
  errors.push("rows must be a non-empty array");
}

for (const entry of matrix.sourceFiles ?? []) {
  const sourcePath = path.join(sourceRoot, entry.path ?? "");
  if (!entry.path || !existsSync(sourcePath)) {
    errors.push(`source file is missing: ${entry.path}`);
    continue;
  }
  if (entry.sha256 && sha256(sourcePath) !== entry.sha256) {
    errors.push(`source file hash changed: ${entry.path}`);
  }
}

for (const targetFile of matrix.targetFiles ?? []) {
  if (!existsSync(path.join(targetRoot, targetFile))) {
    errors.push(`target file is missing: ${targetFile}`);
  }
}
for (const testFile of matrix.testFiles ?? []) {
  if (!existsSync(path.join(targetRoot, testFile))) {
    errors.push(`test file is missing: ${testFile}`);
  }
}

const seenRows = new Set();
for (const [index, row] of (matrix.rows ?? []).entries()) {
  const label = row?.id ?? `rows[${index}]`;
  if (typeof row?.id !== "string" || row.id.trim() === "") {
    errors.push(`${label}: id must be a non-empty string`);
  } else if (seenRows.has(row.id)) {
    errors.push(`${label}: row id is duplicated`);
  } else {
    seenRows.add(row.id);
  }
  if (row.status !== "required") {
    errors.push(`${label}: status must be required`);
  }
  for (const field of ["requiredBehaviors", "edgeCases", "tests", "commands"]) {
    if (!Array.isArray(row[field]) || row[field].length === 0) {
      errors.push(`${label}: ${field} must be a non-empty array`);
    }
  }
  for (const sourceFile of arrayOfStrings(row.source)) {
    if (!existsSync(path.join(sourceRoot, sourceFile))) {
      errors.push(`${label}: source reference is missing: ${sourceFile}`);
    }
  }
  for (const targetFile of arrayOfStrings(row.target)) {
    if (!existsSync(path.join(targetRoot, targetFile))) {
      errors.push(`${label}: target reference is missing: ${targetFile}`);
    }
  }
  for (const testFile of arrayOfStrings(row.tests)) {
    if (!existsSync(path.join(targetRoot, testFile))) {
      errors.push(`${label}: test reference is missing: ${testFile}`);
    }
  }
  if (requireReviews) {
    verifyVerdict(path.join(reviewsDir, `${row.id}.json`), label, errors);
  }
}
if (requireReviews) {
  verifyVerdict(path.join(reviewsDir, "_contract.json"), "contract", errors);
}

if (errors.length > 0) fail(errors);

if (runCommands) {
  for (const row of matrix.rows) {
    for (const [index, command] of row.commands.entries()) {
      console.log(`agent-surface-contract: running ${row.id} command ${index + 1}`);
      const result = spawnSync(command, {
        cwd: targetRoot,
        shell: true,
        encoding: "utf8",
        stdio: "inherit",
        env: {
          ...process.env,
          CI: process.env.CI ?? "1",
          NO_COLOR: process.env.NO_COLOR ?? "1",
        },
        timeout: commandTimeoutMs,
      });
      if (result.error) {
        const reason =
          result.error.code === "ETIMEDOUT"
            ? `timed out after ${commandTimeoutMs}ms`
            : result.error.message;
        fail([`${row.id}: command ${index + 1} ${reason}`]);
      }
      if (result.status !== 0) {
        fail([`${row.id}: command ${index + 1} exited ${result.status}`]);
      }
    }
  }
}

console.log("agent-surface-contract: ok");
