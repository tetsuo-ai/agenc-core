#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const matrixPath = path.join(repoRoot, "parity", "extract-memories-parity.json");
const agentHome =
  process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", `.co${"dex"}`);
const contractCheckerPath = path.join(
  agentHome,
  "skills",
  "implementation-contract",
  "scripts",
  "check_contract.mjs",
);

const contractResult = spawnSync(
  process.execPath,
  [
    contractCheckerPath,
    "--matrix",
    matrixPath,
    "--require-source-snapshot",
    "--require-commands",
    "--run-commands",
    "--command-timeout-ms",
    "120000",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);

if ((contractResult.status ?? 1) !== 0) {
  process.exit(contractResult.status ?? 1);
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const errors = [];

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function mustExist(rel) {
  if (!fs.existsSync(path.join(repoRoot, rel))) {
    errors.push(`missing file: ${rel}`);
  }
}

function mustContain(rel, pattern, label) {
  const text = read(rel);
  if (!pattern.test(text)) {
    errors.push(`${rel} missing ${label}: ${pattern}`);
  }
}

function mustNotContain(rel, pattern, label) {
  const text = read(rel);
  if (pattern.test(text)) {
    errors.push(`${rel} contains ${label}: ${pattern}`);
  }
}

if (matrix.sourceCommit !== "0ca43335375beec6e58711b797d5b0c4bb5019b8") {
  errors.push(`unexpected sourceCommit: ${matrix.sourceCommit}`);
}

const sourceRoot = path.isAbsolute(matrix.sourceRoot)
  ? matrix.sourceRoot
  : path.resolve(path.dirname(matrixPath), matrix.sourceRoot);
for (const rel of matrix.sourceFiles ?? []) {
  const absolute = path.join(sourceRoot, rel);
  if (!fs.existsSync(absolute)) {
    errors.push(`missing source inventory file: ${absolute}`);
  }
}

for (const rel of matrix.targetInventory ?? []) mustExist(rel);
for (const rel of matrix.testInventory ?? []) mustExist(rel);

mustContain(
  "runtime/src/phases/commit.ts",
  /ensureExtractMemoriesInitialized[\s\S]*executeExtractMemories/,
  "terminal commit extraction scheduling",
);
mustContain(
  "runtime/src/phases/commit.ts",
  /Saved memor(?:y|ies):/,
  "saved-memory status message",
);
mustContain(
  "runtime/src/session/turn-state.ts",
  /completedToolResults/,
  "completed tool result ledger",
);
mustContain(
  "runtime/src/phases/execute-tools.ts",
  /completedToolResults\.push/,
  "completed tool result recording",
);
mustContain(
  "runtime/src/session/run-turn.ts",
  /metadata:\s*completed\.metadata/,
  "tool-result metadata relay",
);
mustContain(
  "runtime/src/session/run-turn.ts",
  /drainPendingExtraction/,
  "terminal extraction drain",
);
mustContain(
  "runtime/src/agents/run-agent.ts",
  /childToolPolicy/,
  "child tool policy parameter",
);
mustContain(
  "runtime/src/agents/run-agent.ts",
  /childPolicyDenied:\s*true/,
  "child policy denial metadata",
);
mustContain(
  "runtime/src/agents/run-agent.ts",
  /metadata:\s*result\.metadata/,
  "wrapped dispatch metadata preservation",
);
mustContain(
  "runtime/src/agents/run-agent.ts",
  /onExternalAbort[\s\S]*externalSignal\.addEventListener[\s\S]*externalSignal\.removeEventListener/,
  "external abort listener cleanup",
);
mustContain(
  "runtime/src/agents/run-agent.ts",
  /silent[\s\S]*sendSubagentNotificationToParent[\s\S]*createChildRolloutStore/,
  "silent child run side-effect suppression",
);
mustContain(
  "runtime/src/agents/delegate.ts",
  /childToolPolicy[\s\S]*maxTurns[\s\S]*externalSignal/,
  "delegate child policy, turn cap, and signal passthrough",
);
mustContain(
  "runtime/src/agents/delegate.ts",
  /parentMessagesOverride[\s\S]*useProvidedParentMessages/,
  "delegate snapshot-backed fork support",
);
mustContain(
  "runtime/src/agents/fork-context.ts",
  /useProvidedParentMessages[\s\S]*input\.parentMessages/,
  "provided parent message fork support",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /READ_TOOL_NAMES[\s\S]*FileRead[\s\S]*Grep[\s\S]*Glob[\s\S]*WRITE_TOOL_NAMES[\s\S]*Edit[\s\S]*MultiEdit[\s\S]*Write/,
  "memory child policy tool sets",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /globPatternStaysInsideMemory[\s\S]*resolve\(basePath[\s\S]*glob_outside_memory/,
  "glob pattern confinement",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /forkMode:\s*{\s*kind:\s*"full_history"\s*}[\s\S]*parentMessagesOverride:\s*request\.messages[\s\S]*externalSignal:\s*request\.signal/,
  "full-history child launch with snapshot and signal",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /silent:\s*true/,
  "silent memory extraction child launch",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /resolveDirectMemoryWritePath[\s\S]*!isAbsolute\(raw\)[\s\S]*return null/,
  "absolute-only direct memory write bypass",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /source === "cli_subagent"/,
  "legacy subagent source exclusion",
);
mustNotContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /toolAllowlist\s*:/,
  "child launch tool catalog narrowing",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /extractionLane[\s\S]*sessionLaneKey[\s\S]*memoryRoot/,
  "session and memory directory scoped extraction lanes",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /MAX_EXTRACTION_LANES[\s\S]*pruneIdleLanes[\s\S]*lanes\.delete/,
  "bounded extraction lane cleanup",
);
mustContain(
  "runtime/src/services/extractMemories/extractMemories.ts",
  /inFlightExtractions[\s\S]*pendingContext[\s\S]*drainPendingExtraction/,
  "coalescing and drain support",
);
mustContain(
  "runtime/src/services/extractMemories/memory-paths.ts",
  /AGENC_COWORK_MEMORY_PATH_OVERRIDE[\s\S]*invalid_memory_path_override/,
  "fail-closed explicit memory path override",
);
mustContain(
  "runtime/src/services/extractMemories/memory-paths.ts",
  /MAX_SANITIZED_PROJECT_KEY_LENGTH[\s\S]*djb2Hash[\s\S]*sanitizePathForProjectKey/,
  "shared project-key sanitization shape",
);
mustContain(
  "runtime/src/services/extractMemories/memory-paths.ts",
  /findCanonicalGitRoot[\s\S]*findProjectRootSync/,
  "canonical project-root resolution",
);
mustContain(
  "runtime/src/services/extractMemories/memory-scan.ts",
  /MAX_MEMORY_FILES[\s\S]*lstat[\s\S]*realpath/,
  "bounded symlink-safe manifest scan",
);
mustContain(
  "runtime/src/services/extractMemories/prompts.ts",
  /Available tools: FileRead, Grep, Glob, Edit, MultiEdit, Write\./,
  "prompt tool surface",
);
mustNotContain(
  "runtime/src/services/extractMemories/prompts.ts",
  /\b(?:system\.bash|exec_command|Bash)\b/,
  "shell tool references",
);

if (errors.length > 0) {
  console.error("extract-memories parity failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("extract-memories parity passed");
