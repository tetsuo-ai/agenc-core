/**
 * #2603 reader gate: a recovery window may only leave exact sealed recovery
 * results out of a checkpoint digest. Everything else in the persisted prefix
 * still runs every structural gate, and the digest still covers it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeCheckpointPrefixHashV3,
  computeCheckpointPrefixHashV4,
  readTurnCheckpoint,
  validateRecoveredCheckpointPrefix,
} from "../../src/session/durable-checkpoint-reader.js";
import {
  interruptedToolCallResultContent,
  isRecoveryToolResult,
  resumedToolCallResultContent,
} from "../../src/session/recovery-tool-result.js";
import type { ToolResultIntegrityResponseItem } from "../../src/session/rollout-item.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";

const RUN_ID = "recovery-window-run";

let agencHome: string;
let cwd: string;
let driver: StateSqliteDriver;
let projection: StateToolPairProjection;
let ordinal = 0;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-recovery-window-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-recovery-window-cwd-"));
  mkdirSync(join(cwd, ".git"));
  driver = openStateDatabases({ cwd, agencHome });
  projection = new StateToolPairProjection(driver);
});

afterEach(() => {
  driver.close();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function sealed(callId: string, toolName: string, content: string): ToolResultIntegrityResponseItem {
  return {
    role: "tool",
    content,
    toolCallId: callId,
    toolName,
    toolResultIntegrity: createToolResultIntegrity({ runId: RUN_ID, toolCallId: callId, content }),
  };
}

/** user, read call + sealed result, wait call + recovery result, read call + sealed result. */
function persistedHistory(): ToolResultIntegrityResponseItem[] {
  return [
    { role: "user", content: "spawn a helper and wait for it" },
    { role: "assistant", content: "", toolCalls: [{ id: "read-1", name: "FileRead", arguments: "{}" }] },
    sealed("read-1", "FileRead", "first read"),
    { role: "assistant", content: "", toolCalls: [{ id: "wait-1", name: "wait_agent", arguments: "{}" }] },
    sealed("wait-1", "wait_agent", interruptedToolCallResultContent({ id: "wait-1", name: "wait_agent" })),
    { role: "assistant", content: "", toolCalls: [{ id: "read-2", name: "FileRead", arguments: "{}" }] },
    sealed("read-2", "FileRead", "second read"),
  ];
}

function checkpoint(fields: {
  readonly persistedMessageCount: number;
  readonly prefixHash: string;
  readonly prefixHashVersion?: 3 | 4;
}) {
  const readable = readTurnCheckpoint({
    turnId: "turn-1",
    iterationIndex: 3,
    boundary: "iteration",
    checkpointSeq: 5,
    checkpointVersion: 4,
    toolResultIntegrityVersion: 1,
    prefixHashVersion: fields.prefixHashVersion ?? 3,
    persistedMessageCount: fields.persistedMessageCount,
    prefixHash: fields.prefixHash,
    resumableState: {
      turnCount: 1,
      recoveryReentryCount: 0,
      maxOutputTokensRecoveryCount: 0,
      continuationNudgeCount: 0,
      stopHookBlockingCount: 0,
    },
  });
  if (readable.version !== 4) throw new Error("checkpoint is not v4");
  return readable.checkpoint;
}

function validate(
  messages: ReadonlyArray<ToolResultIntegrityResponseItem>,
  checkpointValue: ReturnType<typeof checkpoint>,
  recoveryWindow: { readonly start: number; readonly length: number },
) {
  ordinal += 1;
  return validateRecoveredCheckpointPrefix({
    checkpoint: checkpointValue,
    expectedRunId: RUN_ID,
    messages,
    projection,
    projectionId: `recovery-window-${ordinal}`,
    sourceKey: "recovery-window",
    recoveryWindow,
  });
}

const without = (messages: ReadonlyArray<ToolResultIntegrityResponseItem>, index: number) =>
  messages.filter((_, at) => at !== index);

describe("checkpoint recovery window", () => {
  it("recognizes only the exact recovery results for their own call", () => {
    const result = sealed("wait-1", "wait_agent", interruptedToolCallResultContent({ id: "wait-1", name: "wait_agent" }));
    expect(isRecoveryToolResult(result)).toBe(true);
    expect(isRecoveryToolResult({ ...result, toolCallId: "wait-2" })).toBe(false);
    expect(isRecoveryToolResult({ ...result, toolName: "spawn_agent" })).toBe(false);
    expect(isRecoveryToolResult({ ...result, content: `${result.content as string} ` })).toBe(false);
    expect(isRecoveryToolResult({ ...result, role: "user" })).toBe(false);
    for (const halt of [false, true]) {
      const paired = sealed("wait-1", "wait_agent", resumedToolCallResultContent("wait_agent", halt));
      expect(isRecoveryToolResult(paired)).toBe(true);
      expect(isRecoveryToolResult({ ...paired, toolName: "FileRead" })).toBe(false);
    }
    expect(isRecoveryToolResult(sealed("read-1", "FileRead", "first read"))).toBe(false);
  });

  it("verifies the digest without the window and every gate with it", () => {
    const history = persistedHistory();
    const writerView = without(history, 4);
    expect(validate(history, checkpoint({
      persistedMessageCount: 6,
      prefixHash: computeCheckpointPrefixHashV3(writerView, 6),
    }), { start: 4, length: 1 })).toMatchObject({ status: "valid" });
  });

  it("refuses a window over a real tool result", () => {
    const history = persistedHistory();
    expect(validate(history, checkpoint({
      persistedMessageCount: 6,
      prefixHash: computeCheckpointPrefixHashV3(without(history, 2), 6),
    }), { start: 2, length: 1 })).toMatchObject({
      status: "invalid",
      failure: { reason: "checkpoint recovery window item 2 is not a sealed recovery result" },
    });
  });

  it("refuses a recovery result without its seal", () => {
    const history = persistedHistory();
    const { toolResultIntegrity: _seal, ...unsealed } = history[4]!;
    const changed = [...history.slice(0, 4), unsealed, ...history.slice(5)];
    expect(validate(changed, checkpoint({
      persistedMessageCount: 6,
      prefixHash: computeCheckpointPrefixHashV3(without(changed, 4), 6),
    }), { start: 4, length: 1 })).toMatchObject({ status: "invalid" });
  });

  it("refuses a window outside the checkpoint prefix", () => {
    const history = persistedHistory();
    expect(validate(history, checkpoint({
      persistedMessageCount: 3,
      prefixHash: computeCheckpointPrefixHashV3(history, 3),
    }), { start: 4, length: 1 })).toMatchObject({
      status: "invalid",
      failure: { reason: "checkpoint recovery window is outside the checkpoint prefix" },
    });
  });

  it("still detects a changed message outside the window", () => {
    const history = persistedHistory();
    const writerView = without(history, 4);
    const tampered = history.map((message, index) =>
      index === 5 ? { ...message, toolCalls: [{ id: "read-2", name: "FileRead", arguments: "{\"x\":1}" }] } : message);
    expect(validate(tampered, checkpoint({
      persistedMessageCount: 6,
      prefixHash: computeCheckpointPrefixHashV3(writerView, 6),
    }), { start: 4, length: 1 })).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_prefix_digest_mismatch" },
    });
  });

  it("still refuses a truncated persisted prefix", () => {
    const history = persistedHistory();
    const writerView = without(history, 4);
    expect(validate(history.slice(0, 6), checkpoint({
      persistedMessageCount: 6,
      prefixHash: computeCheckpointPrefixHashV3(writerView, 6),
    }), { start: 4, length: 1 })).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_prefix_missing" },
    });
  });

  it("binds the window to the checkpoint's own prefix hash version", () => {
    const history = persistedHistory();
    const writerView = without(history, 4);
    expect(validate(history, checkpoint({
      persistedMessageCount: 6,
      prefixHashVersion: 4,
      prefixHash: computeCheckpointPrefixHashV4(writerView, 6),
    }), { start: 4, length: 1 })).toMatchObject({ status: "valid" });
    // A version 3 digest under a version 4 label is still refused.
    expect(validate(history, checkpoint({
      persistedMessageCount: 6,
      prefixHashVersion: 4,
      prefixHash: computeCheckpointPrefixHashV3(writerView, 6),
    }), { start: 4, length: 1 })).toMatchObject({
      status: "invalid",
      failure: { code: "checkpoint_prefix_digest_mismatch" },
    });
  });

  it("accepts a continuation's own pairing as the window", () => {
    const history = persistedHistory().map((message, index) =>
      index === 4 ? sealed("wait-1", "wait_agent", resumedToolCallResultContent("wait_agent", false)) : message);
    expect(validate(history, checkpoint({
      persistedMessageCount: 6,
      prefixHash: computeCheckpointPrefixHashV3(without(history, 4), 6),
    }), { start: 4, length: 1 })).toMatchObject({ status: "valid" });
  });
});
