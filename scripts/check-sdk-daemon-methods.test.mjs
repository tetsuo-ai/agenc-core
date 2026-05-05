#!/usr/bin/env node
// Contract tests for scripts/check-sdk-daemon-methods.mjs.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  compareOrderedLiterals,
  extractInterfaceMethodKeys,
  extractStringArrayConst,
  extractTypeUnionStringLiterals,
} from "./check-sdk-daemon-methods.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-sdk-daemon-methods.mjs",
);

let passed = 0;
let failed = 0;

function assert(name, condition, detail = "") {
  if (condition) {
    process.stdout.write(`✓ ${name}\n`);
    passed += 1;
  } else {
    process.stderr.write(`✗ ${name}\n`);
    if (detail) process.stderr.write(`    ${detail}\n`);
    failed += 1;
  }
}

function runChecker(root, sdkRoot) {
  return spawnSync(
    process.execPath,
    [scriptPath, "--root", root, "--sdk", sdkRoot],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function createFixture({ sdkNotificationMethods }) {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-sdk-method-gate-"));
  const sdkRoot = path.join(root, "agenc-sdk");
  mkdirSync(path.join(root, "runtime/src/app-server/protocol"), {
    recursive: true,
  });
  mkdirSync(path.join(sdkRoot, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "runtime/src/app-server/protocol/index.ts"),
    `
export const AGENC_DAEMON_METHODS = [
  "initialize",
  "agent.logs",
] as const;

export const AGENC_DAEMON_NOTIFICATION_METHODS = [
  "commandExec.outputDelta",
  "event.message_chunk",
] as const;
`,
  );
  writeFileSync(
    path.join(sdkRoot, "src/daemon.ts"),
    `
export type AgenCDaemonMethod =
  | "initialize"
  | "agent.logs";

export type AgenCDaemonNotificationMethod =
${sdkNotificationMethods.map((method) => `  | "${method}"`).join("\n")};

export interface AgenCDaemonParamsByMethod {
  readonly initialize: InitializeParams;
  readonly "agent.logs": AgentLogsParams;
}

export interface AgenCDaemonResultByMethod {
  readonly initialize: InitializeResult;
  readonly "agent.logs": AgentLogsResult;
}

export interface AgenCDaemonNotificationParamsByMethod {
${sdkNotificationMethods
  .map((method) => `  readonly "${method}": NotificationParams;`)
  .join("\n")}
}
`,
  );
  return { root, sdkRoot };
}

try {
  assert(
    "const array extraction reads ordered literals",
    extractStringArrayConst(
      `export const AGENC_DAEMON_METHODS = ["a", "b"] as const;`,
      "AGENC_DAEMON_METHODS",
    ).join(",") === "a,b",
  );
  assert(
    "type union extraction reads ordered literals",
    extractTypeUnionStringLiterals(
      `export type AgenCDaemonMethod = "a" | "b";`,
      "AgenCDaemonMethod",
    ).join(",") === "a,b",
  );
  assert(
    "interface key extraction handles quoted and identifier keys",
    extractInterfaceMethodKeys(
      `export interface Map {\n  readonly initialize: A;\n  readonly "agent.logs": B;\n}`,
      "Map",
    ).join(",") === "initialize,agent.logs",
  );

  const comparison = compareOrderedLiterals("x", ["a", "b"], ["b", "a"]);
  assert(
    "ordered comparison catches same-set order drift",
    comparison.missing.length === 0 &&
      comparison.extra.length === 0 &&
      comparison.orderMatches === false &&
      comparison.ok === false,
  );

  const clean = createFixture({
    sdkNotificationMethods: ["commandExec.outputDelta", "event.message_chunk"],
  });
  try {
    const result = runChecker(clean.root, clean.sdkRoot);
    assert(
      "matching SDK daemon surface passes",
      result.status === 0,
      `${result.stderr}${result.stdout}`,
    );
  } finally {
    rmSync(clean.root, { recursive: true, force: true });
  }

  const drift = createFixture({
    sdkNotificationMethods: ["commandExec.outputDelta"],
  });
  try {
    const result = runChecker(drift.root, drift.sdkRoot);
    assert(
      "missing notification method fails",
      result.status === 1,
      `${result.stderr}${result.stdout}`,
    );
    assert(
      "failure reports missing method",
      result.stderr.includes("event.message_chunk"),
      result.stderr,
    );
  } finally {
    rmSync(drift.root, { recursive: true, force: true });
  }
} catch (error) {
  assert("unexpected test exception", false, error.message);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
