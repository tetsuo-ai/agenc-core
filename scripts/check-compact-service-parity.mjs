#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const matrixPath = path.join(repoRoot, "parity/compact-service-parity.json");

const args = process.argv.slice(2);
const runCommands = args.includes("--run-commands");
const requireSourceSnapshot = args.includes("--require-source-snapshot");
const requireInventory = args.includes("--require-inventory");
const requireCommands = args.includes("--require-commands");
const timeoutIndex = args.indexOf("--command-timeout-ms");
const commandTimeoutMs = timeoutIndex >= 0
  ? Number.parseInt(args[timeoutIndex + 1] ?? "", 10)
  : 180_000;

function fail(message) {
  process.stderr.write(`compact-service parity FAILED: ${message}\n`);
  process.exit(1);
}

function pass(message) {
  process.stdout.write(`compact-service parity: ${message}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveTarget(relativePath) {
  return path.resolve(repoRoot, relativePath);
}

function resolveSource(matrix, relativePath) {
  return path.resolve(matrix.sourceRoot, relativePath);
}

function readTarget(relativePath) {
  return readFileSync(resolveTarget(relativePath), "utf8");
}

function walkFiles(scope) {
  const absolute = resolveTarget(scope);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return [absolute];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    files.push(...walkFiles(path.join(scope, entry.name)));
  }
  return files;
}

if (!existsSync(matrixPath)) {
  fail(`matrix missing: ${path.relative(repoRoot, matrixPath)}`);
}

const matrix = readJson(matrixPath);

if (requireInventory) {
  for (const field of ["sourceFiles", "targetFiles", "testFiles", "rows"]) {
    if (!Array.isArray(matrix[field]) || matrix[field].length === 0) {
      fail(`matrix field ${field} must be a non-empty array`);
    }
  }
}

if (requireCommands && (!Array.isArray(matrix.commands) || matrix.commands.length === 0)) {
  fail("matrix commands must be present");
}

if (requireSourceSnapshot) {
  if (typeof matrix.sourceRoot !== "string" || !existsSync(matrix.sourceRoot)) {
    fail(`sourceRoot missing: ${matrix.sourceRoot}`);
  }
  if (typeof matrix.sourceCommit !== "string" || matrix.sourceCommit.length < 12) {
    fail("sourceCommit must be recorded");
  }
  const rev = spawnSync("git", ["-C", matrix.sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (rev.status !== 0) {
    fail(`could not read source commit: ${rev.stderr || rev.stdout}`);
  }
  if (rev.stdout.trim() !== matrix.sourceCommit) {
    fail(`source checkout at ${matrix.sourceRoot} is ${rev.stdout.trim()}, expected ${matrix.sourceCommit}`);
  }

  for (const target of matrix.targetFiles ?? []) {
    if (!target.startsWith("runtime/src/services/compact/")) continue;
    if (!/\.(ts|tsx|md)$/.test(target)) continue;
    const body = readTarget(target);
    if (!body.includes(matrix.sourceCommit)) {
      fail(`${target} does not cite source commit ${matrix.sourceCommit}`);
    }
  }
}

for (const source of matrix.sourceFiles ?? []) {
  if (!existsSync(resolveSource(matrix, source))) {
    fail(`source file missing: ${source}`);
  }
}

for (const target of [...(matrix.targetFiles ?? []), ...(matrix.testFiles ?? [])]) {
  if (!existsSync(resolveTarget(target))) {
    fail(`target file missing: ${target}`);
  }
}

for (const target of matrix.forbiddenFiles ?? []) {
  if (existsSync(resolveTarget(target))) {
    fail(`forbidden target exists: ${target}`);
  }
}

for (const row of matrix.rows ?? []) {
  for (const field of ["id", "source", "target"]) {
    if (typeof row[field] !== "string" || row[field].trim() === "") {
      fail(`row missing ${field}`);
    }
  }
  if (!Array.isArray(row.requiredBehaviors) || row.requiredBehaviors.length === 0) {
    fail(`row ${row.id} has no required behaviors`);
  }
  if (!Array.isArray(row.tests) || row.tests.length === 0) {
    fail(`row ${row.id} has no tests`);
  }
  if (!existsSync(resolveSource(matrix, row.source))) {
    fail(`row ${row.id} source missing: ${row.source}`);
  }
  if (!existsSync(resolveTarget(row.target))) {
    fail(`row ${row.id} target missing: ${row.target}`);
  }
  for (const testFile of row.tests) {
    if (!existsSync(resolveTarget(testFile))) {
      fail(`row ${row.id} test missing: ${testFile}`);
    }
  }
}

for (const entry of matrix.forbiddenRuntimePatterns ?? []) {
  const pattern = new RegExp(entry.pattern);
  const matches = [];
  for (const absolute of walkFiles(entry.scope)) {
    const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
    if (entry.excludePrefix && relative.startsWith(entry.excludePrefix)) {
      continue;
    }
    if (!/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(relative)) continue;
    const body = readFileSync(absolute, "utf8");
    if (pattern.test(body)) matches.push(relative);
  }
  if (matches.length > 0) {
    fail(`${entry.id} matched ${matches.length} file(s): ${matches.join(", ")}`);
  }
}

const loaders = readTarget("runtime/src/agenc/adapters/dynamic-loaders.js");
for (const importPath of matrix.loaderImports ?? []) {
  if (!loaders.includes(importPath)) {
    fail(`dynamic loaders missing service import ${importPath}`);
  }
}
if (!loaders.includes("./compact-runtime.js")) {
  fail("dynamic loaders must keep context helpers on compact-runtime.js");
}

const compactRuntime = readTarget("runtime/src/agenc/adapters/compact-runtime.ts");
for (const name of matrix.runtimeAdapterRetainedExports ?? []) {
  if (!new RegExp(`export\\s+async\\s+function\\s+${name}\\b`).test(compactRuntime)) {
    fail(`compact-runtime missing retained export ${name}`);
  }
}
for (const name of matrix.runtimeAdapterRetiredExports ?? []) {
  if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(compactRuntime)) {
    fail(`compact-runtime still exports retired compact service helper ${name}`);
  }
}

for (const entry of matrix.requiredImplementationMarkers ?? []) {
  const body = readTarget(entry.file);
  for (const marker of entry.markers ?? []) {
    if (!body.includes(marker)) {
      fail(`${entry.file} missing implementation marker for ${entry.id}: ${marker}`);
    }
  }
}

if (runCommands) {
  for (const command of matrix.commands ?? []) {
    const cmd = command.cmd;
    const commandArgs = command.args ?? [];
    if (typeof cmd !== "string" || !Array.isArray(commandArgs)) {
      fail("command entries must include cmd and args");
    }
    const result = spawnSync(cmd, commandArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      encoding: "utf8",
      timeout: Number.isFinite(commandTimeoutMs) ? commandTimeoutMs : 180_000,
    });
    if (result.error) {
      fail(`${cmd} ${commandArgs.join(" ")} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(`${cmd} ${commandArgs.join(" ")} exited ${result.status}`);
    }
  }
}

pass("all checks passed");
