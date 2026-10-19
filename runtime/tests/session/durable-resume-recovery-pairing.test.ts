/**
 * #2603 writer side: a turn continued after a restart must carry exactly the
 * durable history, so every checkpoint it writes verifies on the next open.
 *
 * A continuation pairs each call its checkpoint left open and persists that
 * pairing before its first checkpoint. When it is interrupted in between, the
 * next continuation resumes from the same checkpoint and must treat that
 * pairing as durable history of the checkpoint. A result it cannot place must
 * stop the continuation instead of being dropped from the resumed history.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { resumeTurnFromCheckpoint } from "../../src/conversation/thread-manager.js";
import { computeCheckpointPrefixHashV4 } from "../../src/session/durable-checkpoint-reader.js";
import { resetBuildIdForTestingOnly } from "../../src/session/durable-turns.js";
import { resumedToolCallResultContent } from "../../src/session/recovery-tool-result.js";
import type { ResponseItem, RolloutItem } from "../../src/session/rollout-item.js";
import { reconstructFromRollout } from "../../src/session/rollout-reconstruction.js";
import type { Session } from "../../src/session/session.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import type {
  ToolPairIntegrityFailure,
  ToolPairOperationalDeferral,
  ToolPairProjection,
  ToolPairProjectionRecord,
  ToolPairProjectionSummary,
} from "../../src/session/tool-pair-validator.js";

const RUN_ID = "recovery-pairing-run";
const TURN_ID = "recovery-pairing-turn";
const CALL = { id: "wait-1", name: "wait_agent" } as const;

class MemoryToolPairProjection implements ToolPairProjection {
  private records = new Map<string, ToolPairProjectionRecord>();
  runAtomically<T>(operation: () => T): T { return operation(); }
  reset(): void { this.records.clear(); }
  find(_projectionId: string, callId: string): ToolPairProjectionRecord | undefined {
    return this.records.get(callId);
  }
  insertCall(_projectionId: string, record: ToolPairProjectionRecord): boolean {
    if (this.records.has(record.callId)) return false;
    this.records.set(record.callId, record);
    return true;
  }
  resolveCall(params: {
    readonly callId: string;
    readonly resultIndex: number;
    readonly resultId?: string;
    readonly originalResultDigest?: string;
  }): "resolved" | "already_resolved" | "missing" {
    const record = this.records.get(params.callId);
    if (record === undefined) return "missing";
    if (record.resultIndex !== undefined) return "already_resolved";
    this.records.set(params.callId, { ...record, ...params });
    return "resolved";
  }
  complete(): void {}
  completeDangling(): void {}
  fail(
    _projectionId: string,
    _summary: ToolPairProjectionSummary,
    _failure: ToolPairIntegrityFailure | ToolPairOperationalDeferral,
  ): void {}
}

afterEach(() => {
  delete process.env.AGENC_BUILD_ID;
  resetBuildIdForTestingOnly();
});

function pinBuild(): string {
  process.env.AGENC_BUILD_ID = "recovery-pairing-build";
  resetBuildIdForTestingOnly();
  return "recovery-pairing-build";
}

function projectionContext(purpose: string) {
  return {
    projection: new MemoryToolPairProjection(),
    projectionId: purpose,
    sourceKey: "recovery-pairing-rollout",
    expectedRunId: RUN_ID,
  };
}

function event(seq: number, msg: unknown): RolloutItem {
  return { type: "event_msg", payload: { id: `event-${seq}`, seq, msg } } as RolloutItem;
}

/** A turn checkpointed right after the model called wait_agent. */
function checkpointedTurn(buildId: string): RolloutItem[] {
  const prefix: ResponseItem[] = [
    { role: "user", content: "spawn a helper and wait for it" },
    { role: "assistant", content: "", toolCalls: [{ id: CALL.id, name: CALL.name, arguments: "{}" }] },
  ];
  return [
    event(1, { type: "turn_started", payload: { turnId: TURN_ID, buildId } }),
    ...prefix.map((payload): RolloutItem => ({ type: "response_item", payload })),
    event(2, {
      type: "turn_checkpoint",
      payload: {
        turnId: TURN_ID,
        iterationIndex: 1,
        boundary: "postAssistant",
        checkpointSeq: 1,
        persistedMessageCount: prefix.length,
        prefixHash: computeCheckpointPrefixHashV4(prefix, prefix.length),
        checkpointVersion: 4,
        toolResultIntegrityVersion: 1,
        prefixHashVersion: 4,
        resumableState: {
          turnCount: 1,
          recoveryReentryCount: 0,
          maxOutputTokensRecoveryCount: 0,
          continuationNudgeCount: 0,
          stopHookBlockingCount: 0,
        },
      },
    }),
  ];
}

/** The pairing a first continuation persisted before it was interrupted. */
function earlierContinuation(): RolloutItem[] {
  const content = resumedToolCallResultContent(CALL.name, false);
  return [
    event(3, { type: "turn_started", payload: { turnId: TURN_ID, buildId: "recovery-pairing-build" } }),
    event(4, { type: "turn_resumed", payload: { turnId: TURN_ID, fromCheckpointSeq: 1, fromIteration: 1 } }),
    {
      type: "response_item",
      payload: {
        role: "tool",
        content,
        toolCallId: CALL.id,
        toolName: CALL.name,
        toolResultIntegrity: createToolResultIntegrity({ runId: RUN_ID, toolCallId: CALL.id, content }),
      },
    },
  ];
}

function sessionFor(items: RolloutItem[], resolved: ReadonlySet<string>) {
  const runTurn = vi.fn(async function* () {});
  const session = {
    conversationId: RUN_ID,
    config: { durableTurns: { resume: { requireLease: false } } },
    services: { registry: { tools: [{ name: CALL.name, recoveryCategory: "idempotent" }] } },
    rolloutStore: {
      rootHasOnlyTerminalDescendants: () => true,
      readAll: () => items,
      checkpointProjectionContext: projectionContext,
      liveToolCallResolved: (callId: string) => resolved.has(callId),
      appendRollout: vi.fn(),
    },
    runTurn,
    emit: vi.fn(),
    nextInternalSubId: () => "recovery-pairing-event",
  } as unknown as Session;
  return { session, runTurn };
}

describe("#2603 continuing a turn whose open call already has a durable result", () => {
  test("a pairing persisted by an interrupted earlier continuation belongs to the checkpoint", () => {
    const items = [...checkpointedTurn(pinBuild()), ...earlierContinuation()];
    const turn = reconstructFromRollout(items, {
      checkpointProjection: projectionContext("reconstruct"),
    }).resumableTurns.at(-1);
    expect(turn).toMatchObject({
      turnId: TURN_ID,
      checkpointIntegrityStatus: "valid",
      resumeHistoryMessageCount: 3,
      danglingToolUses: [],
    });
  });

  test("the next continuation resumes with that pairing in its durable history", async () => {
    const items = [...checkpointedTurn(pinBuild()), ...earlierContinuation()];
    const { session, runTurn } = sessionFor(items, new Set([CALL.id]));
    const reconstruction = reconstructFromRollout(items, {
      checkpointProjection: projectionContext("bootstrap"),
    });
    await expect(resumeTurnFromCheckpoint(session, reconstruction))
      .resolves.toMatchObject({ resumed: true });
    expect(runTurn).toHaveBeenCalledTimes(1);
    const options = runTurn.mock.calls[0]![1] as {
      readonly history: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
      readonly resume: { readonly persistedMessageCount: number; readonly danglingPairings?: unknown };
    };
    expect(options.history.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(options.history[2]!.content).toBe(resumedToolCallResultContent(CALL.name, false));
    expect(options.resume.persistedMessageCount).toBe(3);
    expect(options.resume.danglingPairings).toBeUndefined();
  });

  test("a durable result the continuation cannot place stops it instead of being dropped", async () => {
    // The live tool-pair projection already holds a result for the call, but
    // the rollout read for the continuation does not place it after the
    // checkpoint. Continuing would keep the pairing out of durable history.
    const items = checkpointedTurn(pinBuild());
    const { session, runTurn } = sessionFor(items, new Set([CALL.id]));
    const reconstruction = reconstructFromRollout(items, {
      checkpointProjection: projectionContext("bootstrap"),
    });
    await expect(resumeTurnFromCheckpoint(session, reconstruction))
      .resolves.toEqual({ resumed: false, reason: "integrity-deferred" });
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("an open call without any durable result is still paired and continued", async () => {
    const items = checkpointedTurn(pinBuild());
    const { session, runTurn } = sessionFor(items, new Set());
    const reconstruction = reconstructFromRollout(items, {
      checkpointProjection: projectionContext("bootstrap"),
    });
    await expect(resumeTurnFromCheckpoint(session, reconstruction))
      .resolves.toMatchObject({ resumed: true });
    const options = runTurn.mock.calls[0]![1] as {
      readonly resume: { readonly danglingPairings?: ReadonlyArray<{ readonly callId: string }> };
    };
    expect(options.resume.danglingPairings).toEqual([
      expect.objectContaining({ callId: CALL.id, halt: false }),
    ]);
  });
});
