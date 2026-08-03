import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMessagesForAPI } from "../../src/llm/messages.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { resumeTurnFromCheckpoint } from "../../src/conversation/thread-manager.js";
import {
  computeCheckpointPrefixHashV2,
} from "../../src/session/durable-checkpoint-reader.js";
import {
  currentBuildId,
  resetBuildIdForTestingOnly,
} from "../../src/session/durable-turns.js";
import {
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
  llmMessageToReplacementResponseItem,
  llmMessageToResponseItem,
  responseItemToLlmMessage,
} from "../../src/session/message-history-conversion.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import {
  DurableCheckpointUpgradeBlockedError,
  RolloutStore,
  ToolPairHistoryBlockedError,
} from "../../src/session/rollout-store.js";
import type { Session } from "../../src/session/session.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type ResponseItem,
  type RolloutItem,
} from "../../src/session/rollout-item.js";
import { rewriteAtomically } from "../../src/session/session-store.js";
import {
  createToolResultIntegrity,
  verifyToolResultIntegrity,
} from "../../src/session/tool-result-integrity.js";
import {
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateToolPairProjection } from "../../src/state/tool-pair-projection.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../fnd/fixtures/checkpoints/", import.meta.url),
);

let agencHome: string;
let cwd: string;
let originalAgencHome: string | undefined;
let driver: StateSqliteDriver;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-a3b-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-a3b-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = agencHome;
  process.env.AGENC_BUILD_ID = "a3b-test-build";
  resetBuildIdForTestingOnly();
  driver = openStateDatabases({ cwd, agencHome });
});

afterEach(() => {
  driver.close();
  if (originalAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = originalAgencHome;
  delete process.env.AGENC_BUILD_ID;
  resetBuildIdForTestingOnly();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("A3b history and provider boundary", () => {
  it("preserves original identity across replacement history and strips it from provider wire", () => {
    const originalContent = "full tool output";
    const integrity = createToolResultIntegrity({
      runId: "session-a3b",
      toolCallId: "call-a3b",
      content: originalContent,
    });
    const original: LLMMessage = {
      role: "tool",
      toolCallId: "call-a3b",
      toolName: "FileRead",
      content: originalContent,
      runtimeOnly: { toolResultIntegrity: integrity },
    };

    const roundTripped = responseItemToLlmMessage(
      llmMessageToResponseItem(original),
    );
    expect(roundTripped.runtimeOnly?.toolResultIntegrity).toEqual(integrity);

    const compacted = { ...roundTripped, content: "[compacted result]" };
    const replacement = llmMessageToReplacementResponseItem(
      compacted,
      "compacted",
    );
    expect(replacement.toolResultIntegrity?.original).toEqual(
      integrity.original,
    );
    expect(replacement.toolResultIntegrity?.persisted.representation).toBe(
      "compacted",
    );
    expect(
      verifyToolResultIntegrity({
        integrity: replacement.toolResultIntegrity,
        toolCallId: "call-a3b",
        content: replacement.content,
      }),
    ).toMatchObject({ status: "valid" });

    const providerMessages = normalizeMessagesForAPI([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-a3b", name: "FileRead", arguments: "{}" }],
      },
      roundTripped,
    ]);
    const providerJson = JSON.stringify(providerMessages);
    expect(providerJson).not.toContain("toolResultIntegrity");
    expect(providerJson).not.toContain(integrity.resultId);
    expect(providerJson).not.toContain(integrity.original.digest);
  });

  it("authenticates the exact redacted body written to disk without changing the provider body", () => {
    const rawSecret = `sk-proj-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const rawContent = `tool output: ${rawSecret}`;
    const sourceIntegrity = createToolResultIntegrity({
      runId: "session-redaction",
      toolCallId: "call-redaction",
      content: rawContent,
    });
    const message: LLMMessage = {
      role: "tool",
      toolCallId: "call-redaction",
      toolName: "exec_command",
      content: rawContent,
      runtimeOnly: { toolResultIntegrity: sourceIntegrity },
    };

    const durable = llmMessageToDurableResponseItem(message);
    expect(durable.content).not.toContain(rawSecret);
    expect(durable.toolResultIntegrity?.original).toEqual(
      sourceIntegrity.original,
    );
    expect(durable.toolResultIntegrity?.persisted.representation).toBe(
      "redacted",
    );
    expect(
      verifyToolResultIntegrity({
        integrity: durable.toolResultIntegrity,
        toolCallId: "call-redaction",
        content: durable.content,
      }),
    ).toMatchObject({ status: "valid" });

    const inMemoryAfterPersistence: LLMMessage = {
      ...message,
      runtimeOnly: {
        toolResultIntegrity: {
          ...sourceIntegrity,
          persisted: durable.toolResultIntegrity!.persisted,
        },
      },
    };
    expect(
      llmMessageToCheckpointResponseItem(inMemoryAfterPersistence),
    ).toEqual(durable);

    const serialized = serializeRolloutItem({
      type: "response_item",
      payload: durable,
    });
    const parsed = parseRolloutLine(serialized);
    expect(parsed?.type).toBe("response_item");
    if (parsed?.type !== "response_item") throw new Error("response item missing");
    expect(
      verifyToolResultIntegrity({
        integrity: parsed.payload.toolResultIntegrity,
        toolCallId: parsed.payload.toolCallId!,
        content: parsed.payload.content,
      }),
    ).toMatchObject({ status: "valid" });

    const providerMessages = normalizeMessagesForAPI([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-redaction", name: "exec_command", arguments: "{}" },
        ],
      },
      message,
    ]);
    expect(providerMessages[1]?.content).toBe(rawContent);
    expect(JSON.stringify(providerMessages)).not.toContain(
      "toolResultIntegrity",
    );
  });
});

describe("A3b raw checkpoint validation", () => {
  it("authenticates before truncation and never executes invalid or deferred resume", async () => {
    const largeBody = `head:${"x".repeat(450_000)}:tail`;
    const prefix: ResponseItem[] = [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "large-call", name: "FileRead", arguments: "{}" }],
      },
      {
        role: "tool",
        content: largeBody,
        toolCallId: "large-call",
        toolName: "FileRead",
        toolResultIntegrity: createToolResultIntegrity({
          runId: "large-session",
          toolCallId: "large-call",
          content: largeBody,
        }),
      },
    ];
    const rollout = v2OrphanRollout("large-turn", prefix);
    const reconstruction = reconstructFromRollout(rollout, {
      checkpointProjection: {
        projection: new StateToolPairProjection(driver),
        projectionId: "raw-before-truncation",
        sourceKey: "large-rollout",
        expectedRunId: "large-session",
      },
    });

    expect(reconstruction.resumableTurns[0]).toMatchObject({
      historyPrefixValid: true,
      checkpointIntegrityStatus: "valid",
    });
    expect(reconstruction.history[2]?.content).not.toBe(largeBody);

    const substituted = rollout.map((item) =>
      item.type === "response_item" && item.payload.role === "tool"
        ? { ...item, payload: { ...item.payload, content: `${largeBody}!` } }
        : item,
    );
    const rejected = reconstructFromRollout(substituted, {
      checkpointProjection: {
        projection: new StateToolPairProjection(driver),
        projectionId: "raw-substitution",
        sourceKey: "large-rollout-substituted",
        expectedRunId: "large-session",
      },
    });
    expect(rejected.resumableTurns[0]).toMatchObject({
      historyPrefixValid: false,
      checkpointIntegrityStatus: "invalid",
    });
    expect(rejected.resumableTurns[0]?.checkpointIntegrityReason).toContain(
      "persisted body digest",
    );

    const runTurn = vi.fn();
    const session = {
      config: { durableTurns: { resume: { onRestart: true } } },
      runTurn,
    } as unknown as Session;
    await expect(resumeTurnFromCheckpoint(session, rejected)).resolves.toEqual({
      resumed: false,
      reason: "integrity-invalid",
    });

    const deferred = reconstructFromRollout(rollout);
    expect(deferred.resumableTurns[0]).toMatchObject({
      checkpointIntegrityStatus: "deferred",
    });
    await expect(resumeTurnFromCheckpoint(session, deferred)).resolves.toEqual({
      resumed: false,
      reason: "integrity-deferred",
    });
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("A3b shared ordered validator cutover", () => {
  it("enforces exact resolved-ID uniqueness on live append and compaction", () => {
    const sessionId = "ordered-live-session";
    const meta = {
      sessionId,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd,
      originator: "a3b-test",
      agencVersion: "0.13.0",
    } as const;
    const store = openRollout({ sessionId, meta });
    const assistant: ResponseItem = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "ordered-call", name: "FileRead", arguments: "{}" }],
    };
    const tool: ResponseItem = {
      role: "tool",
      content: "ordered result",
      toolCallId: "ordered-call",
      toolName: "FileRead",
      toolResultIntegrity: createToolResultIntegrity({
        runId: sessionId,
        toolCallId: "ordered-call",
        content: "ordered result",
      }),
    };

    expect(() => {
      store.appendRollout({ type: "response_item", payload: assistant });
      store.appendRollout({ type: "response_item", payload: tool });
    }).not.toThrow();
    store.flushDurable();

    expect(() =>
      store.appendRollout(
        {
          type: "compacted",
          payload: {
            message: "invalid compaction",
            replacementHistory: [tool, assistant],
          },
        },
        { durable: true },
      ),
    ).toThrowError(
      expect.objectContaining<ToolPairHistoryBlockedError>({
        outcome: expect.objectContaining({
          status: "invalid",
          failure: expect.objectContaining({ code: "tool_result_without_call" }),
        }),
      }),
    );

    expect(() =>
      store.appendRollout({ type: "response_item", payload: assistant }),
    ).toThrowError(
      expect.objectContaining<ToolPairHistoryBlockedError>({
        outcome: expect.objectContaining({
          status: "invalid",
          failure: expect.objectContaining({
            code: "assistant_tool_call_id_duplicate",
          }),
        }),
      }),
    );

    store.close();

    const restarted = openRollout({ sessionId, meta, resume: true });
    const nextAssistant: ResponseItem = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "ordered-call-next", name: "FileRead", arguments: "{}" }],
    };
    const nextTool: ResponseItem = {
      role: "tool",
      content: "next result",
      toolCallId: "ordered-call-next",
      toolName: "FileRead",
      toolResultIntegrity: createToolResultIntegrity({
        runId: sessionId,
        toolCallId: "ordered-call-next",
        content: "next result",
      }),
    };
    expect(() => {
      restarted.appendRollout({ type: "response_item", payload: nextAssistant });
      restarted.appendRollout({ type: "response_item", payload: nextTool });
    }).not.toThrow();
    expect(() =>
      restarted.appendRollout({ type: "response_item", payload: assistant }),
    ).toThrowError(
      expect.objectContaining<ToolPairHistoryBlockedError>({
        outcome: expect.objectContaining({
          status: "invalid",
          failure: expect.objectContaining({
            code: "assistant_tool_call_id_duplicate",
          }),
        }),
      }),
    );
    restarted.close();
  });
});

describe("A3b atomic legacy publication", () => {
  it("leaves v1 intact on a pre-publish crash, then upgrades once and restarts idempotently", () => {
    const sessionId = "atomic-upgrade-session";
    const meta = {
      sessionId,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd,
      originator: "a3b-test",
      agencVersion: "0.13.0",
    } as const;
    const seed = openRollout({ sessionId, meta });
    const rolloutPath = seed.rolloutPath;
    seed.close();

    const legacyItems: RolloutItem[] = [
      {
        type: "session_meta",
        payload: { ...meta, rolloutSchemaVersion: 1 },
      },
      ...loadFixture("legacy-v1-tool-result-a.jsonl"),
    ];
    const legacyBytes = legacyItems.map(serializeRolloutItem).join("");
    rewriteAtomically(rolloutPath, legacyBytes);

    const crashed = new RolloutStore({
      cwd,
      sessionId,
      agencVersion: "0.13.0",
      resume: true,
      autoStartScheduler: false,
      beforeCheckpointUpgradePublishForTestingOnly: () => {
        throw new Error("simulated upgrade crash");
      },
    });
    expect(() => crashed.open(meta)).toThrow("simulated upgrade crash");
    expect(readFileSync(rolloutPath, "utf8")).toBe(legacyBytes);
    expect(existsSync(`${rolloutPath}.tmp`)).toBe(false);

    const upgraded = openRollout({ sessionId, meta, resume: true });
    const upgradedItems = upgraded.readAll();
    expect(
      upgradedItems
        .filter((item) => item.type === "session_meta")
        .every((item) => item.payload.rolloutSchemaVersion === 2),
    ).toBe(true);
    expect(
      upgradedItems.find(
        (item) =>
          item.type === "event_msg" &&
          item.payload.msg.type === "turn_checkpoint",
      ),
    ).toMatchObject({
      payload: {
        msg: {
          payload: {
            checkpointVersion: 2,
            toolResultIntegrityVersion: 1,
          },
        },
      },
    });
    expect(
      upgradedItems.find(
        (item) => item.type === "response_item" && item.payload.role === "tool",
      ),
    ).toMatchObject({
      payload: { toolResultIntegrity: { version: 1, runId: sessionId } },
    });
    const upgradedBytes = readFileSync(rolloutPath, "utf8");
    const checkpointOffset = upgraded.store.getByteOffsetForSeq(2);
    expect(checkpointOffset).toBeTypeOf("number");
    const checkpointLine = upgradedBytes
      .slice(checkpointOffset)
      .split("\n", 1)[0];
    expect(parseRolloutLine(checkpointLine ?? "")).toMatchObject({
      type: "event_msg",
      payload: { seq: 2 },
    });
    upgraded.close();

    const restarted = openRollout({ sessionId, meta, resume: true });
    expect(readFileSync(rolloutPath, "utf8")).toBe(upgradedBytes);
    restarted.close();
  });

  it("fails a malformed legacy sequence closed without publishing v2", () => {
    const sessionId = "invalid-upgrade-session";
    const meta = {
      sessionId,
      timestamp: "2026-08-01T00:00:00.000Z",
      cwd,
      originator: "a3b-test",
      agencVersion: "0.13.0",
    } as const;
    const seed = openRollout({ sessionId, meta });
    const rolloutPath = seed.rolloutPath;
    seed.close();
    const fixture = loadFixture("legacy-v1-tool-result-a.jsonl").filter(
      (item) =>
        item.type !== "event_msg" ||
        item.payload.msg.type !== "turn_checkpoint",
    );
    const assistantIndex = fixture.findIndex(
      (item) => item.type === "response_item" && item.payload.role === "assistant",
    );
    const resultIndex = fixture.findIndex(
      (item) => item.type === "response_item" && item.payload.role === "tool",
    );
    const reordered = [...fixture];
    [reordered[assistantIndex], reordered[resultIndex]] = [
      reordered[resultIndex]!,
      reordered[assistantIndex]!,
    ];
    const legacyItems: RolloutItem[] = [
      {
        type: "session_meta",
        payload: { ...meta, rolloutSchemaVersion: 1 },
      },
      ...reordered,
    ];
    const legacyBytes = legacyItems.map(serializeRolloutItem).join("");
    rewriteAtomically(rolloutPath, legacyBytes);

    const invalid = new RolloutStore({
      cwd,
      sessionId,
      agencVersion: "0.13.0",
      resume: true,
      autoStartScheduler: false,
    });
    let blocked: unknown;
    try {
      invalid.open(meta);
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(DurableCheckpointUpgradeBlockedError);
    const blockedError = blocked as DurableCheckpointUpgradeBlockedError;
    expect(blockedError.runId).toBe(sessionId);
    expect(blockedError.outcome).toMatchObject({ kind: "integrity_failure" });
    expect(blockedError.message).toContain(sessionId);
    expect(blockedError.message).toContain("start a new session");
    expect(readFileSync(rolloutPath, "utf8")).toBe(legacyBytes);
  });
});

function v2OrphanRollout(
  turnId: string,
  prefix: ReadonlyArray<ResponseItem>,
): RolloutItem[] {
  return [
    {
      type: "event_msg",
      payload: {
        id: `${turnId}-started`,
        seq: 1,
        msg: {
          type: "turn_started",
          payload: { turnId, buildId: currentBuildId() },
        },
      },
    },
    ...prefix.map((payload) => ({ type: "response_item" as const, payload })),
    {
      type: "event_msg",
      payload: {
        id: `${turnId}-checkpoint`,
        seq: 2,
        msg: {
          type: "turn_checkpoint",
          payload: {
            turnId,
            iterationIndex: 1,
            boundary: "iteration",
            checkpointSeq: 1,
            persistedMessageCount: prefix.length,
            prefixHash: computeCheckpointPrefixHashV2(prefix, prefix.length),
            checkpointVersion: 2,
            toolResultIntegrityVersion: 1,
            resumableState: {
              turnCount: 1,
              recoveryReentryCount: 0,
              maxOutputTokensRecoveryCount: 0,
              continuationNudgeCount: 0,
              stopHookBlockingCount: 0,
            },
          },
        },
      },
    },
  ];
}

function openRollout(params: {
  readonly sessionId: string;
  readonly meta: {
    readonly sessionId: string;
    readonly timestamp: string;
    readonly cwd: string;
    readonly originator: string;
    readonly agencVersion: string;
  };
  readonly resume?: boolean;
}): RolloutStore {
  const store = new RolloutStore({
    cwd,
    sessionId: params.sessionId,
    agencVersion: params.meta.agencVersion,
    autoStartScheduler: false,
    ...(params.resume === true ? { resume: true } : {}),
  });
  store.open(params.meta);
  return store;
}

function loadFixture(filename: string): RolloutItem[] {
  return readFileSync(join(FIXTURE_ROOT, filename), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseRolloutLine(line))
    .filter((item): item is RolloutItem => item !== null);
}
