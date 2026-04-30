#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const codexRoot = path.resolve(
  process.env.CODEX_SOURCE_ROOT ?? path.join(repoRoot, "..", "codex"),
);
const inventoryPath = path.join(
  repoRoot,
  "parity",
  "codex-v2-agent-source-inventory.json",
);
const topContractPath = path.join(repoRoot, "parity", "codex-v2-agent-contract.json");
const contractCheckerPath = path.join(
  os.homedir(),
  ".codex/skills/implementation-contract/scripts/check_contract.mjs",
);

const REQUIRED_SOURCE_FILES = Object.freeze([
  "codex-rs/core/src/agent/agent_names.txt",
  "codex-rs/core/src/agent/agent_resolver.rs",
  "codex-rs/core/src/agent/builtins/awaiter.toml",
  "codex-rs/core/src/agent/builtins/explorer.toml",
  "codex-rs/core/src/agent/control.rs",
  "codex-rs/core/src/agent/control_tests.rs",
  "codex-rs/core/src/agent/mailbox.rs",
  "codex-rs/core/src/agent/mod.rs",
  "codex-rs/core/src/agent/registry.rs",
  "codex-rs/core/src/agent/registry_tests.rs",
  "codex-rs/core/src/agent/role.rs",
  "codex-rs/core/src/agent/role_tests.rs",
  "codex-rs/core/src/agent/status.rs",
  "codex-rs/core/src/config/mod.rs",
  "codex-rs/core/src/session/multi_agents.rs",
  "codex-rs/core/src/session/turn_context.rs",
  "codex-rs/core/src/thread_manager.rs",
  "codex-rs/core/src/thread_manager_tests.rs",
  "codex-rs/core/src/tools/handlers/agent_jobs.rs",
  "codex-rs/core/src/tools/handlers/agent_jobs_tests.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_common.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/close_agent.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs",
  "codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs",
  "codex-rs/protocol/src/agent_path.rs",
  "codex-rs/protocol/src/protocol.rs",
  "codex-rs/tools/src/agent_job_tool.rs",
  "codex-rs/tools/src/agent_job_tool_tests.rs",
  "codex-rs/tools/src/agent_tool.rs",
  "codex-rs/tools/src/agent_tool_tests.rs",
  "codex-rs/tools/src/tool_config.rs",
  "codex-rs/tools/src/tool_registry_plan.rs",
  "codex-rs/tools/src/tool_registry_plan_tests.rs",
  "codex-rs/tools/src/tool_registry_plan_types.rs",
]);

const MATRIX_FILES = Object.freeze([
  "parity/codex-v2-agent-contract.json",
  "parity/codex-control-parity.json",
  "parity/codex-registry-parity.json",
  "parity/codex-mailbox-parity.json",
  "parity/codex-status-parity.json",
  "parity/codex-role-parity.json",
  "parity/codex-thread-manager-parity.json",
  "parity/codex-fork-context-parity.json",
  "parity/codex-thread-parity.json",
  "parity/codex-run-agent-parity.json",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function joined(parts) {
  return parts.join("");
}

function wordPattern(...words) {
  const source = words
    .map((word) => escapeRegExp(Array.isArray(word) ? joined(word) : word))
    .join("\\s+");
  return new RegExp(`\\b${source}\\b`, "i");
}

const FORBIDDEN_MATRIX_PATTERNS = Object.freeze([
  wordPattern("out", "of", "scope"),
  wordPattern("known", "gap"),
  wordPattern(["sk", "ip", "ped"]),
  wordPattern("intentionally", "not", ["imple", "mented"]),
  wordPattern(["TO", "DO"], "parity"),
  new RegExp(`\\bfuture\\s+follow-?up\\b`, "i"),
  new RegExp(`\\bfollow-?up\\s+commit\\b`, "i"),
  wordPattern("not", "yet"),
  wordPattern("not", ["imple", "mented"]),
  wordPattern(["par", "tial"]),
  wordPattern(["st", "ub"]),
  wordPattern(["place", "holder"]),
  wordPattern(["defer", "red"]),
  wordPattern(["block", "ed"]),
  wordPattern(["un", "known"]),
]);

function usage() {
  console.error(
    "Usage: verify-codex-v2-agent-contract.mjs [--update-inventory]",
  );
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `${cmd} ${args.join(" ")} failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function extractSurface(pathInCodex, text) {
  const symbols = [];
  const toolNames = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const symbol = line.match(
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    );
    if (symbol) symbols.push(symbol[1]);
    const toolName = line.match(/name:\s*"([^"]+)"/);
    if (toolName) toolNames.push(toolName[1]);
  }
  return {
    path: pathInCodex,
    symbols: sortedUnique(symbols),
    toolNames: sortedUnique(toolNames),
  };
}

function buildInventory() {
  const codexCommit = run("git", ["-C", codexRoot, "rev-parse", "HEAD"]);
  const files = REQUIRED_SOURCE_FILES.map((sourcePath) => {
    const absolutePath = path.join(codexRoot, sourcePath);
    const bytes = fs.readFileSync(absolutePath);
    const text = bytes.toString("utf8");
    return {
      path: sourcePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      extractedSurface: extractSurface(sourcePath, text),
    };
  });
  return {
    contractName: "codex-v2-agent-source-inventory",
    sourceRoot: codexRoot,
    codexCommit,
    generatedBy: "scripts/verify-codex-v2-agent-contract.mjs --update-inventory",
    sourceFiles: files,
  };
}

function loadInventory() {
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(
      `source inventory missing: ${path.relative(repoRoot, inventoryPath)}; run scripts/verify-codex-v2-agent-contract.mjs --update-inventory`,
    );
  }
  return readJson(inventoryPath);
}

function validateInventory(errors) {
  const inventory = loadInventory();
  const currentCommit = run("git", ["-C", codexRoot, "rev-parse", "HEAD"]);
  if (inventory.codexCommit !== currentCommit) {
    errors.push(
      `Codex commit changed: inventory=${inventory.codexCommit} current=${currentCommit}`,
    );
  }

  const expected = sortedUnique(REQUIRED_SOURCE_FILES);
  const actual = sortedUnique(
    Array.isArray(inventory.sourceFiles)
      ? inventory.sourceFiles.map((file) => file.path)
      : [],
  );
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    errors.push("source inventory file list differs from verifier REQUIRED_SOURCE_FILES");
  }

  for (const file of inventory.sourceFiles ?? []) {
    const absolutePath = path.join(codexRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      errors.push(`Codex source file missing: ${file.path}`);
      continue;
    }
    const bytes = fs.readFileSync(absolutePath);
    const currentHash = sha256(bytes);
    if (file.sha256 !== currentHash) {
      errors.push(`Codex source hash changed: ${file.path}`);
    }
  }

  return inventory;
}

function resolveFrom(root, maybePath) {
  if (typeof maybePath !== "string" || maybePath.trim() === "") return null;
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(root, maybePath);
}

function validateMatrixFile(matrixFile, allRows, errors) {
  const absoluteMatrixPath = path.join(repoRoot, matrixFile);
  if (!fs.existsSync(absoluteMatrixPath)) {
    errors.push(`matrix missing: ${matrixFile}`);
    return null;
  }

  const checker = spawnSync(process.execPath, [contractCheckerPath, "--matrix", absoluteMatrixPath], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (checker.status !== 0) {
    errors.push(
      `matrix checker failed for ${matrixFile}:\n${checker.stderr.trim() || checker.stdout.trim()}`,
    );
  }

  const matrix = readJson(absoluteMatrixPath);
  if (path.isAbsolute(matrix.targetRoot) && path.resolve(matrix.targetRoot) !== repoRoot) {
    errors.push(`${matrixFile}: targetRoot must not point at a stale absolute worktree`);
  }
  if (path.isAbsolute(matrix.sourceRoot) && path.resolve(matrix.sourceRoot) !== codexRoot) {
    errors.push(`${matrixFile}: sourceRoot must point at the active Codex source root`);
  }
  if (typeof matrix.scope === "string") {
    for (const pattern of FORBIDDEN_MATRIX_PATTERNS) {
      if (pattern.test(matrix.scope)) {
        errors.push(`${matrixFile}: forbidden shortcut language in scope`);
      }
    }
  }

  for (const [index, row] of (matrix.rows ?? []).entries()) {
    const rowId = `${matrix.contractName}:${row.id ?? `row-${index}`}`;
    if (allRows.has(rowId)) {
      errors.push(`duplicate row id: ${rowId}`);
    }
    allRows.set(rowId, { matrixFile, matrix, row });
    if (row.status !== "required") {
      errors.push(`${rowId}: status must be required`);
    }
    if (!Array.isArray(row.tests) || row.tests.length === 0) {
      errors.push(`${rowId}: tests must be non-empty`);
    }
    if (Array.isArray(row.requiredBehaviors)) {
      for (const behavior of row.requiredBehaviors) {
        if (typeof behavior === "string") {
          for (const pattern of FORBIDDEN_MATRIX_PATTERNS) {
            if (pattern.test(behavior)) {
              errors.push(`${rowId}: forbidden shortcut language in requiredBehaviors`);
            }
          }
        }
      }
    }
  }
  return matrix;
}

function validateMatrices(inventory, errors) {
  const allRows = new Map();
  const matrices = MATRIX_FILES.map((matrixFile) =>
    validateMatrixFile(matrixFile, allRows, errors),
  ).filter(Boolean);

  const coveredSources = new Set();
  for (const matrix of matrices) {
    const sourceRoot = resolveFrom(path.dirname(path.join(repoRoot, "parity", "x")), matrix.sourceRoot);
    for (const row of matrix.rows ?? []) {
      if (typeof row.source === "string") coveredSources.add(row.source);
      for (const source of row.sourceFiles ?? []) {
        if (typeof source === "string") coveredSources.add(source);
      }
      if (sourceRoot && path.resolve(sourceRoot) !== codexRoot) {
        errors.push(`${matrix.contractName}: sourceRoot resolves away from active Codex root`);
      }
    }
  }

  for (const file of inventory.sourceFiles ?? []) {
    if (!coveredSources.has(file.path)) {
      errors.push(`Codex source file lacks matrix coverage: ${file.path}`);
    }
  }
}

function validatePackageScripts(errors) {
  const rootPackage = readJson(path.join(repoRoot, "package.json"));
  const runtimePackage = readJson(path.join(repoRoot, "runtime", "package.json"));
  const requiredRootScripts = [
    "check:codex-v2-agent-contract",
    "install:codex-v2-agent-contract-hook",
  ];
  const requiredRuntimeScripts = [
    "check:codex-v2-agent-contract",
    "test:codex-v2-agent-contract",
    "validate:codex-v2-agent-contract",
  ];
  for (const script of requiredRootScripts) {
    if (!rootPackage.scripts?.[script]) {
      errors.push(`root package.json missing script ${script}`);
    }
  }
  for (const script of requiredRuntimeScripts) {
    if (!runtimePackage.scripts?.[script]) {
      errors.push(`runtime/package.json missing script ${script}`);
    }
  }
  if (
    !String(runtimePackage.scripts?.["validate:required"] ?? "").includes(
      "validate:codex-v2-agent-contract",
    )
  ) {
    errors.push("runtime validate:required must include validate:codex-v2-agent-contract");
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }
  if (args.length > 1 || (args[0] && args[0] !== "--update-inventory")) {
    usage();
    process.exit(2);
  }

  if (args[0] === "--update-inventory") {
    writeJson(inventoryPath, buildInventory());
    console.log(`updated ${path.relative(repoRoot, inventoryPath)}`);
    return;
  }

  const errors = [];
  if (!fs.existsSync(codexRoot)) {
    errors.push(`Codex source root missing: ${codexRoot}`);
  }
  if (!fs.existsSync(contractCheckerPath)) {
    errors.push(`implementation-contract checker missing: ${contractCheckerPath}`);
  }
  if (errors.length === 0) {
    const inventory = validateInventory(errors);
    validateMatrices(inventory, errors);
    validatePackageScripts(errors);
  }

  if (errors.length > 0) {
    console.error("Codex V2 agent implementation contract FAILED");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Codex V2 agent implementation contract passed");
}

main();
