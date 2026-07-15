#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const matrixPath = path.join(repoRoot, "parity", "agent-surface-contract.json");
const reviewsDir = path.join(repoRoot, "parity", "agent-surface-contract.reviews");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sourceGitEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

const gitEnv = sourceGitEnvironment();

function arrayOfStrings(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "");
}

function isNormalizedRelativeFile(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.endsWith("/") &&
    !path.posix.isAbsolute(value) &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    path.posix.normalize(value) === value
  );
}

function fail(errors) {
  for (const error of errors) {
    console.error(`agent-surface-contract: ${error}`);
  }
  process.exit(1);
}

function verifyVerdict(filePath, label, errors, expected = {}) {
  if (!existsSync(filePath)) {
    errors.push(`${label} review is missing: ${path.relative(repoRoot, filePath)}`);
    return;
  }
  const verdict = readJson(filePath);
  if (verdict.verdict !== "APPROVED") {
    errors.push(`${label} review must be APPROVED`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (verdict[field] !== value) {
      errors.push(`${label} review ${field} does not match the current contract`);
    }
  }
}

function verifySourceGitCheckout(sourceRoot, sourceCommit, errors) {
  const result = spawnSync(
    "git",
    ["--no-replace-objects", "-C", sourceRoot, "rev-parse", "--show-toplevel", "HEAD"],
    { encoding: "utf8", env: gitEnv },
  );
  if (result.error) {
    errors.push(`source Git checkout could not be inspected: ${result.error.message}`);
    return null;
  }
  if (result.status !== 0) {
    errors.push(`sourceRoot is not a Git checkout: ${sourceRoot}`);
    return null;
  }
  const [reportedRoot, head, ...extra] = result.stdout.trim().split(/\r?\n/);
  if (!reportedRoot || !head || extra.length > 0) {
    errors.push(`source Git checkout returned an unexpected identity: ${sourceRoot}`);
    return null;
  }
  let gitRoot;
  let resolvedSourceRoot;
  try {
    gitRoot = realpathSync(reportedRoot);
    resolvedSourceRoot = realpathSync(sourceRoot);
    const relativeSourceRoot = path.relative(gitRoot, resolvedSourceRoot);
    if (
      relativeSourceRoot === ".." ||
      relativeSourceRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeSourceRoot)
    ) {
      errors.push(`sourceRoot is outside its reported Git checkout: ${sourceRoot}`);
      return null;
    }
  } catch (error) {
    errors.push(`source Git checkout identity could not be resolved: ${error.message}`);
    return null;
  }
  if (head !== sourceCommit) {
    errors.push(`source Git HEAD ${head} does not match sourceCommit ${sourceCommit}`);
  }
  return {
    gitRoot,
    sourceRoot: resolvedSourceRoot,
    sourcePrefix: path.relative(gitRoot, resolvedSourceRoot).split(path.sep).join("/"),
  };
}

function verifySourceFile(sourceGit, sourceCommit, entry, errors) {
  const gitPath = sourceGit.sourcePrefix
    ? path.posix.join(sourceGit.sourcePrefix, entry.path)
    : entry.path;
  const blob = spawnSync(
    "git",
    [
      "--no-replace-objects",
      "-C",
      sourceGit.gitRoot,
      "cat-file",
      "blob",
      `${sourceCommit}:${gitPath}`,
    ],
    { encoding: null, env: gitEnv, maxBuffer: 32 * 1024 * 1024 },
  );
  if (blob.error) {
    errors.push(`source Git blob could not be read: ${entry.path}: ${blob.error.message}`);
  } else if (blob.status !== 0) {
    errors.push(`source file is missing from sourceCommit: ${entry.path}`);
  } else {
    const blobDigest = createHash("sha256").update(blob.stdout).digest("hex");
    if (blobDigest !== entry.sha256) {
      errors.push(`sourceCommit blob hash does not match pinned SHA-256: ${entry.path}`);
    }
  }

  const committedOid = spawnSync(
    "git",
    ["--no-replace-objects", "-C", sourceGit.gitRoot, "rev-parse", `${sourceCommit}:${gitPath}`],
    { encoding: "utf8", env: gitEnv },
  );
  if (committedOid.error || committedOid.status !== 0) return;

  const sourcePath = path.join(sourceGit.sourceRoot, entry.path);
  try {
    if (!lstatSync(sourcePath).isFile()) {
      errors.push(`source worktree path is not a regular file: ${entry.path}`);
      return;
    }
  } catch (error) {
    errors.push(`source worktree file could not be inspected: ${entry.path}: ${error.message}`);
    return;
  }
  const worktreeOid = spawnSync(
    "git",
    [
      "--no-replace-objects",
      "-C",
      sourceGit.gitRoot,
      "hash-object",
      `--path=${gitPath}`,
      sourcePath,
    ],
    { encoding: "utf8", env: gitEnv },
  );
  if (worktreeOid.error) {
    errors.push(`source worktree could not be hashed: ${entry.path}: ${worktreeOid.error.message}`);
  } else if (worktreeOid.status !== 0) {
    errors.push(`source worktree hashing failed: ${entry.path}`);
  } else if (worktreeOid.stdout.trim() !== committedOid.stdout.trim()) {
    errors.push(`source worktree differs from sourceCommit: ${entry.path}`);
  }
}

function parseArguments(argv) {
  const booleanOptions = new Set([
    "--run-commands",
    "--no-run-commands",
    "--require-reviews",
    "--no-require-reviews",
    "--verify-source",
  ]);
  const valueOptions = new Set(["--source-root", "--command-timeout-ms"]);
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (booleanOptions.has(argument)) {
      if (flags.has(argument)) fail([`duplicate option: ${argument}`]);
      flags.add(argument);
      continue;
    }
    if (valueOptions.has(argument)) {
      if (values.has(argument)) fail([`duplicate option: ${argument}`]);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail([`missing ${argument} value`]);
      values.set(argument, value);
      index += 1;
      continue;
    }
    fail([`unknown option: ${argument}`]);
  }
  for (const [enabled, disabled] of [
    ["--run-commands", "--no-run-commands"],
    ["--require-reviews", "--no-require-reviews"],
  ]) {
    if (flags.has(enabled) && flags.has(disabled)) {
      fail([`conflicting options: ${enabled} and ${disabled}`]);
    }
  }
  return { flags, values };
}

function terminateCommandTree(child, force) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkill = systemRoot
      ? path.join(systemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(
      taskkill,
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    if (!result.error && result.status === 0) return;
  } else {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch (error) {
      if (error?.code === "ESRCH") return;
    }
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The close/error handlers below own final classification.
  }
}

let activeCommand = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (activeCommand) terminateCommandTree(activeCommand, true);
    process.removeListener(signal, handler);
    process.kill(process.pid, signal);
  };
  process.on(signal, handler);
}

function runCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "inherit",
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    activeCommand = child;
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeCommand === child) activeCommand = null;
      resolve({ ...result, timedOut });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateCommandTree(child, true);
    }, timeoutMs);
    child.once("error", (error) => finish({ error, status: null, signal: null }));
    child.once("close", (status, signal) => finish({ error: null, status, signal }));
  });
}

const argv = process.argv.slice(2);
const { flags, values } = parseArguments(argv);
const runCommands = !flags.has("--no-run-commands");
const requireReviews =
  flags.has("--require-reviews") && !flags.has("--no-require-reviews");
const verifySource = flags.has("--verify-source");
const sourceRootOverride = values.get("--source-root");
if (sourceRootOverride && !verifySource) {
  fail(["--source-root requires --verify-source"]);
}
const commandTimeoutValue = values.get("--command-timeout-ms");
const commandTimeoutMs = commandTimeoutValue === undefined ? 180_000 : Number(commandTimeoutValue);
if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
  fail([`invalid --command-timeout-ms value: ${commandTimeoutValue}`]);
}

const matrix = readJson(matrixPath);
const sourceRoot = sourceRootOverride
  ? path.resolve(process.cwd(), sourceRootOverride)
  : path.resolve(path.dirname(matrixPath), matrix.sourceRoot);
const targetRoot = path.resolve(path.dirname(matrixPath), matrix.targetRoot);
const errors = [];

for (const field of ["contractName", "scope", "sourceRoot", "sourceCommit", "targetRoot"]) {
  if (typeof matrix[field] !== "string" || matrix[field].trim() === "") {
    errors.push(`top-level ${field} must be a non-empty string`);
  }
}
if (
  typeof matrix.sourceCommit === "string" &&
  !/^[0-9a-f]{40}$/.test(matrix.sourceCommit)
) {
  errors.push("top-level sourceCommit must be a lowercase 40-character Git SHA");
}
const sourceRootExists = verifySource && existsSync(sourceRoot);
let sourceGit = null;
if (verifySource && !sourceRootExists) {
  errors.push(`sourceRoot does not exist: ${sourceRoot}`);
} else if (verifySource) {
  sourceGit = verifySourceGitCheckout(sourceRoot, matrix.sourceCommit, errors);
}
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

const declaredSourceFiles = new Set();
for (const entry of matrix.sourceFiles ?? []) {
  if (!isNormalizedRelativeFile(entry?.path)) {
    errors.push(`sourceFiles entry path must be a normalized relative file: ${entry?.path}`);
    continue;
  }
  if (declaredSourceFiles.has(entry.path)) {
    errors.push(`source file is duplicated: ${entry.path}`);
    continue;
  }
  declaredSourceFiles.add(entry.path);
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    errors.push(`source file hash must be a lowercase SHA-256: ${entry.path}`);
  }
  if (sourceGit) verifySourceFile(sourceGit, matrix.sourceCommit, entry, errors);
}

const declaredTargetFiles = new Set();
for (const targetFile of matrix.targetFiles ?? []) {
  if (!isNormalizedRelativeFile(targetFile)) {
    errors.push(`targetFiles entry must be a normalized relative file: ${targetFile}`);
    continue;
  }
  if (declaredTargetFiles.has(targetFile)) {
    errors.push(`target file is duplicated: ${targetFile}`);
    continue;
  }
  declaredTargetFiles.add(targetFile);
  if (!existsSync(path.join(targetRoot, targetFile))) {
    errors.push(`target file is missing: ${targetFile}`);
  }
}
const declaredTestFiles = new Set();
for (const testFile of matrix.testFiles ?? []) {
  if (!isNormalizedRelativeFile(testFile)) {
    errors.push(`testFiles entry must be a normalized relative file: ${testFile}`);
    continue;
  }
  if (declaredTestFiles.has(testFile)) {
    errors.push(`test file is duplicated: ${testFile}`);
    continue;
  }
  declaredTestFiles.add(testFile);
  if (!existsSync(path.join(targetRoot, testFile))) {
    errors.push(`test file is missing: ${testFile}`);
  }
}

const seenRows = new Set();
for (const [index, row] of (matrix.rows ?? []).entries()) {
  const label = row?.id ?? `rows[${index}]`;
  const rowIdIsSafe =
    typeof row?.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id);
  if (!rowIdIsSafe) {
    errors.push(`${label}: id must use lowercase kebab-case`);
  } else if (seenRows.has(row.id)) {
    errors.push(`${label}: row id is duplicated`);
  } else {
    seenRows.add(row.id);
  }
  if (row.status !== "required") {
    errors.push(`${label}: status must be required`);
  }
  for (const field of [
    "source",
    "target",
    "requiredBehaviors",
    "edgeCases",
    "tests",
    "commands",
  ]) {
    if (!Array.isArray(row[field]) || row[field].length === 0) {
      errors.push(`${label}: ${field} must be a non-empty array`);
    } else if (row[field].some((item) => typeof item !== "string" || item.trim() === "")) {
      errors.push(`${label}: ${field} entries must be non-empty strings`);
    }
  }
  for (const sourceFile of arrayOfStrings(row.source)) {
    if (!isNormalizedRelativeFile(sourceFile)) {
      errors.push(`${label}: source reference must be a normalized relative file: ${sourceFile}`);
      continue;
    }
    if (!declaredSourceFiles.has(sourceFile)) {
      errors.push(`${label}: source reference is not declared in sourceFiles: ${sourceFile}`);
    }
  }
  for (const targetFile of arrayOfStrings(row.target)) {
    if (!isNormalizedRelativeFile(targetFile)) {
      errors.push(`${label}: target reference must be a normalized relative file: ${targetFile}`);
      continue;
    }
    if (!declaredTargetFiles.has(targetFile)) {
      errors.push(`${label}: target reference is not declared in targetFiles: ${targetFile}`);
    }
  }
  for (const testFile of arrayOfStrings(row.tests)) {
    if (!isNormalizedRelativeFile(testFile)) {
      errors.push(`${label}: test reference must be a normalized relative file: ${testFile}`);
      continue;
    }
    if (!declaredTestFiles.has(testFile)) {
      errors.push(`${label}: test reference is not declared in testFiles: ${testFile}`);
    }
  }
  if (requireReviews && rowIdIsSafe) {
    verifyVerdict(path.join(reviewsDir, `${row.id}.json`), label, errors, {
      contractName: matrix.contractName,
      rowId: row.id,
    });
  }
}
if (requireReviews) {
  verifyVerdict(path.join(reviewsDir, "_contract.json"), "contract", errors, {
    contractName: matrix.contractName,
    sourceCommit: matrix.sourceCommit,
    contractSha256: canonicalJsonSha256(matrix),
  });
}

if (errors.length > 0) fail(errors);

if (verifySource) {
  console.log(`agent-surface-contract: source checkout verified at ${matrix.sourceCommit}`);
} else {
  console.log(
    "agent-surface-contract: frozen source ledger validated; " +
      "source checkout verification skipped (use --verify-source)",
  );
}

if (runCommands) {
  for (const row of matrix.rows) {
    for (const [index, command] of row.commands.entries()) {
      console.log(`agent-surface-contract: running ${row.id} command ${index + 1}`);
      const result = await runCommand(command, {
        cwd: targetRoot,
        env: {
          ...process.env,
          CI: process.env.CI ?? "1",
          NO_COLOR: process.env.NO_COLOR ?? "1",
        },
        timeoutMs: commandTimeoutMs,
      });
      if (result.error) {
        fail([`${row.id}: command ${index + 1} ${result.error.message}`]);
      }
      if (result.timedOut) {
        fail([`${row.id}: command ${index + 1} timed out after ${commandTimeoutMs}ms`]);
      }
      if (result.status !== 0) {
        const reason = result.signal
          ? `terminated by ${result.signal}`
          : `exited ${result.status}`;
        fail([`${row.id}: command ${index + 1} ${reason}`]);
      }
    }
  }
}

console.log("agent-surface-contract: ok");
