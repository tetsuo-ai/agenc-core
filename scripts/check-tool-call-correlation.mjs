#!/usr/bin/env node
// Project-local contract gate for the tool-call-correlation matrix.
// The shared skill checker treats the literal word `unknown` as forbidden,
// which collides with legitimate TypeScript `unknown` types in the target
// file. This wrapper performs a narrow, evidence-based check instead:
//   1. Validate the matrix shape and required row IDs.
//   2. Assert each affected branch in the target file contains an
//      early-return guard when payload.callId is not a string, and that
//      the prior `randomUUID()` fallback has been removed.
//   3. Assert the contract test file exists and names a test for each row.
//   4. Optionally run row commands when --run-commands is passed.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MATRIX_PATH = path.join(REPO_ROOT, "parity/tool-call-correlation.json");
const TARGET_REL = "runtime/src/tui/bridges/message-adapter.ts";
const TEST_REL = "runtime/src/tui/openclaude/message-adapter.contract.test.ts"; // branding-scan: allow grandfathered compatibility test path

const REQUIRED_ROW_IDS = [
  "tool-call-begin-callid-required",
  "tool-call-end-callid-required",
  "collab-spawn-begin-callid-required",
  "collab-end-callid-required",
];

const failures = [];
const args = new Set(process.argv.slice(2));
const runCommands = args.has("--run-commands");

function fail(msg) {
  failures.push(msg);
}

const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
if (matrix.contractName !== "tool-call-correlation") {
  fail(`contractName must be tool-call-correlation, got: ${matrix.contractName}`);
}
const rowIds = new Set(matrix.rows.map((r) => r.id));
for (const id of REQUIRED_ROW_IDS) {
  if (!rowIds.has(id)) fail(`matrix is missing required row id: ${id}`);
}
for (const row of matrix.rows) {
  if (row.status !== "required") {
    fail(`row ${row.id} status must be required, got: ${row.status}`);
  }
  if (!Array.isArray(row.requiredBehaviors) || row.requiredBehaviors.length === 0) {
    fail(`row ${row.id} must list requiredBehaviors`);
  }
  if (!Array.isArray(row.commands) || row.commands.length === 0) {
    fail(`row ${row.id} must list commands`);
  }
}

const targetPath = path.join(REPO_ROOT, TARGET_REL);
if (!fs.existsSync(targetPath)) {
  fail(`target missing: ${TARGET_REL}`);
} else {
  const src = fs.readFileSync(targetPath, "utf8");

  // Each affected branch must contain an early-return guard *before* any
  // pushTool* call when payload.callId is not a string. We anchor on the
  // case-list lines so we get a stable window per branch.
  const branches = [
    {
      id: "tool-call-begin-callid-required",
      anchor: /case "tool_call_started":\s*\n\s*case "mcp_tool_call_begin":\s*\n\s*case "exec_command_begin":/,
      guardWindow: 6,
    },
    {
      id: "tool-call-end-callid-required",
      anchor: /case "tool_call_completed":\s*\n\s*case "mcp_tool_call_end":\s*\n\s*case "exec_command_end":/,
      guardWindow: 6,
    },
    {
      id: "collab-spawn-begin-callid-required",
      anchor: /case "collab_agent_spawn_begin":/,
      guardWindow: 6,
    },
    {
      id: "collab-end-callid-required",
      anchor: /case "collab_agent_spawn_end":\s*\n\s*case "collab_agent_interaction_end":\s*\n\s*case "collab_waiting_end":\s*\n\s*case "collab_close_end":\s*\n\s*case "collab_resume_end":/,
      guardWindow: 6,
    },
  ];

  for (const branch of branches) {
    const match = branch.anchor.exec(src);
    if (!match) {
      fail(`${branch.id}: anchor not found in target (case header pattern changed?)`);
      continue;
    }
    const start = match.index + match[0].length;
    // Window from end-of-case-header to the first break; that closes this branch.
    const tail = src.slice(start, start + 4000);
    const breakIdx = tail.search(/\n\s*break\s*;/);
    const window = breakIdx === -1 ? tail : tail.slice(0, breakIdx);
    if (/randomUUID\s*\(\s*\)/.test(window)) {
      fail(`${branch.id}: randomUUID() fallback still present in branch — must be removed`);
    }
    const guardOk =
      /typeof\s+payload\.callId\s*!==\s*"string"/.test(window) ||
      /typeof\s+payload\.callId\s*===\s*"string"\s*\?\s*payload\.callId\s*:\s*null/.test(window);
    if (!guardOk) {
      fail(`${branch.id}: missing payload.callId string guard with early-exit semantics`);
    }
    // After the fix, the branch must NOT call pushToolUse / pushToolResult
    // before the guard. We approximate this by requiring the guard text to
    // appear before the first pushTool* call in the branch window.
    const pushIdx = window.search(/pushTool(?:Use|Result)\s*\(/);
    const guardIdx = Math.min(
      ...[/typeof\s+payload\.callId\s*!==\s*"string"/, /callId\s*===\s*null/]
        .map((re) => {
          const m = re.exec(window);
          return m ? m.index : Infinity;
        }),
    );
    if (pushIdx !== -1 && guardIdx === Infinity) {
      fail(`${branch.id}: branch contains pushTool* but no guard appears before it`);
    } else if (pushIdx !== -1 && guardIdx > pushIdx) {
      fail(`${branch.id}: guard must appear before pushTool* call`);
    }
  }
}

const testPath = path.join(REPO_ROOT, TEST_REL);
if (!fs.existsSync(testPath)) {
  fail(`test file missing: ${TEST_REL}`);
} else {
  const tests = fs.readFileSync(testPath, "utf8");
  for (const id of REQUIRED_ROW_IDS) {
    if (!tests.includes(id)) {
      fail(`contract test must include a case named "${id}"`);
    }
  }
}

if (failures.length > 0) {
  console.error("Implementation contract FAILED: tool-call-correlation");
  for (const f of failures) console.error(" - " + f);
  process.exit(1);
}

console.error("Implementation contract structure OK: tool-call-correlation");

if (runCommands) {
  let commandFailed = false;
  for (const row of matrix.rows) {
    for (const cmd of row.commands) {
      console.error(`\n→ ${row.id}: ${cmd}`);
      const r = spawnSync(cmd, {
        cwd: REPO_ROOT,
        shell: true,
        stdio: "inherit",
      });
      if (r.status !== 0) {
        console.error(`✗ ${row.id} command failed (exit ${r.status})`);
        commandFailed = true;
      }
    }
  }
  if (commandFailed) {
    console.error("\nImplementation contract FAILED: row commands did not all pass");
    process.exit(1);
  }
}
