import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  hasSemanticPtyReadiness,
  observePtySession,
  runImportProbe,
} from "./check-tui-runtime-startup.mjs";

async function probeFixture(source) {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-tui-import-proof-"));
  const artifactPath = path.join(root, "main.mjs");
  writeFileSync(artifactPath, source, { mode: 0o600 });
  try {
    return await runImportProbe({ artifactPath, containmentRoot: root, timeoutMs: 5_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("import proof succeeds only after the expected export returns", async () => {
  const result = await probeFixture("export function bootTUI() {}\n");
  assert.equal(result.ok, true, result.error?.stack ?? result.output);
});

test("top-level process.exit(0) cannot falsely green the import probe", async () => {
  const result = await probeFixture(
    "process.exit(0); export function bootTUI() {}\n",
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /without a verified completion proof/u);
});

test("candidate code cannot forge a fixed IPC proof frame", async () => {
  const result = await probeFixture([
    "process.send?.({",
    "  type: 'proof',",
    "  protocol: 'agenc-tui-import-proof-v1',",
    "  signature: Buffer.alloc(64).toString('base64'),",
    "});",
    "export function bootTUI() {}",
    "",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /signature verification failed/u);
});

test("missing bootTUI fails even when the module imports cleanly", async () => {
  const result = await probeFixture("export const notTheTui = true;\n");
  assert.equal(result.ok, false);
  assert.match(`${result.error.message}\n${result.output}`, /bootTUI/u);
});

test("candidate global monkeypatches cannot erase export requirements", async () => {
  const result = await probeFixture([
    "Object.entries = () => [];",
    "export const notTheTui = true;",
    "",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(`${result.error.message}\n${result.output}`, /bootTUI/u);
});

test("candidate iterator poisoning cannot skip export requirements", async () => {
  const result = await probeFixture([
    "Array.prototype[Symbol.iterator] = function* () {};",
    "export const notTheTui = true;",
    "",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(`${result.error.message}\n${result.output}`, /bootTUI/u);
});

const SEMANTIC_PAINT = `\x1b[?2004h${" ".repeat(128)}AgenC interactive screen`;

function fakeTerm({ earlyExit = false, terminationExit, paint = SEMANTIC_PAINT, spontaneousExitMs } = {}) {
  const dataHandlers = [];
  const exitHandlers = [];
  let exited = false;
  const emitExit = (value) => {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler(value);
  };
  return {
    onData(handler) {
      dataHandlers.push(handler);
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandlers.push(handler);
      if (earlyExit) setTimeout(() => emitExit({ exitCode: 0, signal: 0 }), 0);
      else {
        setTimeout(() => dataHandlers.forEach((emit) => emit(paint)), 0);
        if (spontaneousExitMs !== undefined) {
          setTimeout(() => emitExit({ exitCode: 0, signal: 0 }), spontaneousExitMs);
        }
      }
      return { dispose() {} };
    },
    write() {},
    kill(signal) {
      emitExit(terminationExit ?? { exitCode: 0, signal: signal === "SIGKILL" ? 9 : 15 });
    },
  };
}

test("a clean PTY exit before first paint is a failure", async () => {
  const passed = await observePtySession(fakeTerm({ earlyExit: true }), {
    label: "early-exit",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 20,
    postReplyMs: 20,
    sigtermGraceMs: 20,
    forceKillGraceMs: 20,
  });
  assert.equal(passed, false);
});

test("one byte followed by a hang is not a functional TUI startup", async () => {
  assert.equal(hasSemanticPtyReadiness("x"), false);
  const passed = await observePtySession(fakeTerm({ paint: "x" }), {
    label: "one-byte-hang",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 10,
    postReplyMs: 10,
    sigtermGraceMs: 10,
    forceKillGraceMs: 10,
  });
  assert.equal(passed, false);
});

test("a spontaneous clean exit at the post-reply boundary cannot race green", async () => {
  const passed = await observePtySession(fakeTerm({ spontaneousExitMs: 9 }), {
    label: "post-reply-exit-race",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 5,
    postReplyMs: 10,
    sigtermGraceMs: 10,
    forceKillGraceMs: 10,
  });
  assert.equal(passed, false);
});

test("a painted PTY that stays alive until requested termination passes", async () => {
  const passed = await observePtySession(fakeTerm(), {
    label: "healthy",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 20,
    postReplyMs: 20,
    sigtermGraceMs: 20,
    forceKillGraceMs: 20,
  });
  assert.equal(passed, true);
});

test("a PTY crash during the requested termination grace is a failure", async () => {
  for (const terminationExit of [
    { exitCode: 1, signal: 0 },
    { exitCode: 0, signal: 11 },
  ]) {
    const passed = await observePtySession(
      fakeTerm({ terminationExit }),
      {
        label: "termination-race",
        viewport: { cols: 80, rows: 24 },
        firstPaintMs: 20,
        postReplyMs: 20,
        sigtermGraceMs: 20,
        forceKillGraceMs: 20,
      },
    );
    assert.equal(passed, false);
  }
});
