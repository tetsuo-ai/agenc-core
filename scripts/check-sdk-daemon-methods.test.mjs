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

const requestMethods = ["initialize", "agent.logs"];
const notificationMethods = ["commandExec.outputDelta", "event.message_chunk"];

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
  const args = [scriptPath, "--root", root];
  if (sdkRoot) args.push("--sdk", sdkRoot);
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function createFixture(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-sdk-method-gate-"));
  const sdkRoot = path.join(root, "agenc-sdk");
  mkdirSync(path.join(root, "runtime/src/app-server/protocol"), {
    recursive: true,
  });
  mkdirSync(path.join(sdkRoot, "src"), { recursive: true });
  writeProtocol(root);
  writeSdkDaemon(sdkRoot, overrides);
  return { root, sdkRoot };
}

function createMainCheckoutFallbackFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "agenc-sdk-main-fallback-"));
  const mainRoot = path.join(parent, "AgenC", "agenc-core");
  const sdkRoot = path.join(parent, "AgenC", "agenc-sdk");
  const worktreeRoot = path.join(parent, "worktrees", "PK-10");
  mkdirSync(path.join(mainRoot, "runtime/src/app-server/protocol"), {
    recursive: true,
  });
  mkdirSync(path.join(sdkRoot, "src"), { recursive: true });
  writeProtocol(mainRoot);
  writeSdkDaemon(sdkRoot);
  runGit(parent, ["init", "-b", "main", mainRoot]);
  runGit(mainRoot, ["config", "user.email", "test@localhost"]);
  runGit(mainRoot, ["config", "user.name", "AgenC Test"]);
  runGit(mainRoot, ["add", "."]);
  runGit(mainRoot, ["commit", "-m", "baseline"]);
  mkdirSync(path.dirname(worktreeRoot), { recursive: true });
  runGit(mainRoot, ["worktree", "add", "-b", "port/PK-10", worktreeRoot]);
  return { root: parent, worktreeRoot };
}

function writeProtocol(root) {
  writeFileSync(
    path.join(root, "runtime/src/app-server/protocol/index.ts"),
    `
export const AGENC_DAEMON_METHODS = [
${requestMethods.map((method) => `  "${method}",`).join("\n")}
] as const;

export const AGENC_DAEMON_NOTIFICATION_METHODS = [
${notificationMethods.map((method) => `  "${method}",`).join("\n")}
] as const;
`,
  );
}

function writeSdkDaemon(sdkRoot, overrides = {}) {
  const methods = overrides.sdkMethods ?? requestMethods;
  const paramsMethods = overrides.sdkParamsMethods ?? requestMethods;
  const resultMethods = overrides.sdkResultMethods ?? requestMethods;
  const notifications = overrides.sdkNotificationMethods ?? notificationMethods;
  const notificationParams =
    overrides.sdkNotificationParamsMethods ?? notificationMethods;

  writeFileSync(
    path.join(sdkRoot, "src/daemon.ts"),
    `
export type AgenCDaemonMethod =
${typeUnionLines(methods)}

export type AgenCDaemonNotificationMethod =
${typeUnionLines(notifications)}

export interface AgenCDaemonParamsByMethod {
${interfaceLines(paramsMethods, "Params")}
}

export interface AgenCDaemonResultByMethod {
${interfaceLines(resultMethods, "Result")}
}

export interface AgenCDaemonNotificationParamsByMethod {
${interfaceLines(notificationParams, "NotificationParams")}
}
`,
  );
}

function typeUnionLines(values) {
  return `${values.map((value) => `  | "${value}"`).join("\n")};`;
}

function interfaceLines(values, suffix) {
  return values
    .map((value) =>
      /^[A-Za-z_$][\w$]*$/.test(value)
        ? `  readonly ${value}: ${suffix};`
        : `  readonly "${value}": ${suffix};`,
    )
    .join("\n");
}

function assertCheckerFails(name, overrides, expectedText) {
  const fixture = createFixture(overrides);
  try {
    const result = runChecker(fixture.root, fixture.sdkRoot);
    assert(name, result.status === 1, `${result.stderr}${result.stdout}`);
    assert(
      `${name} reports expected method`,
      result.stderr.includes(expectedText),
      result.stderr,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
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

  const clean = createFixture();
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

  assertCheckerFails(
    "missing request method fails",
    { sdkMethods: ["initialize"] },
    "agent.logs",
  );
  assertCheckerFails(
    "extra SDK method fails",
    { sdkMethods: [...requestMethods, "extra.method"] },
    "extra.method",
  );
  assertCheckerFails(
    "missing params map entry fails",
    { sdkParamsMethods: ["initialize"] },
    "agent.logs",
  );
  assertCheckerFails(
    "missing result map entry fails",
    { sdkResultMethods: ["initialize"] },
    "agent.logs",
  );
  assertCheckerFails(
    "missing notification method fails",
    { sdkNotificationMethods: ["commandExec.outputDelta"] },
    "event.message_chunk",
  );
  assertCheckerFails(
    "missing notification params map entry fails",
    { sdkNotificationParamsMethods: ["commandExec.outputDelta"] },
    "event.message_chunk",
  );

  const absentSdk = createFixture();
  try {
    rmSync(absentSdk.sdkRoot, { recursive: true, force: true });
    const result = runChecker(absentSdk.root, absentSdk.sdkRoot);
    assert(
      "absent explicit SDK root fails",
      result.status === 2,
      `${result.stderr}${result.stdout}`,
    );
    assert(
      "absent SDK failure names missing daemon file",
      result.stderr.includes("src/daemon.ts"),
      result.stderr,
    );
  } finally {
    rmSync(absentSdk.root, { recursive: true, force: true });
  }

  const fallback = createMainCheckoutFallbackFixture();
  try {
    const result = runChecker(fallback.worktreeRoot);
    assert(
      "main-checkout sibling fallback passes from linked worktree",
      result.status === 0,
      `${result.stderr}${result.stdout}`,
    );
  } finally {
    rmSync(fallback.root, { recursive: true, force: true });
  }
} catch (error) {
  assert("unexpected test exception", false, error.message);
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
