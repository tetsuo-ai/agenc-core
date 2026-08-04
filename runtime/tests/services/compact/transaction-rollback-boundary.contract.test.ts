import { describe, expect, it, vi } from "vitest";

import { commit } from "../../../src/phases/commit.js";
import { compactConversation } from "../../../src/services/compact/compact.js";
import { finalizeCompactionTransaction } from "../../../src/services/compact/finalize-transaction.js";
import type { RuntimeMessage } from "../../../src/services/compact/types.js";
import { buildInitialTurnState } from "../../../src/session/turn-state.js";
import { reconstructFromRollout } from "../../../src/session/rollout-reconstruction.js";
import { responseItemToLlmMessage } from "../../../src/session/message-history-conversion.js";
import { SessionStore } from "../../../src/session/session-store.js";
import type { TurnContext } from "../../../src/session/turn-context.js";
import {
  createCompactionTransactionHarness,
  type CompactionTransactionHarness,
} from "../../helpers/compaction-transaction-harness.js";

const SOURCE_MESSAGE_COUNT = 8;
const SOURCE_MESSAGE_BYTES = 4_000;

describe("automatic compaction rollback boundary contract", () => {
  it("restores the exact source across the normal commit boundary in the same session", async () => {
    const source = createSourceMessages();
    const harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: "automatic-boundary-same-session",
    });
    try {
      const attemptId = await runAutomaticCompactionThroughCommit(harness, source);

      const beforeRollback = harness.store.readAll();
      const boundaries = beforeRollback.filter(
        (item) =>
          item.type === "event_msg" &&
          item.payload.msg.type === "context_compacted",
      );
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0]).toMatchObject({
        type: "event_msg",
        payload: {
          msg: {
            type: "context_compacted",
            payload: {
              summary: "auto-compact boundary (turnId=automatic-contract-turn)",
            },
          },
        },
      });
      expect(beforeRollback.at(-1)?.type).toBe("session_meta");

      const rollback = harness.store.rollbackCompaction({
        attemptId,
        nowMs: Date.now(),
      });

      expect(rollback.rollback_mode).toBe("same_session");
      expect(rollback.source_history).toEqual(expectedSourceHistory(source));
      expect(
        reconstructFromRollout(harness.store.readAll()).history,
      ).toEqual(expectedSourceHistory(source));
    } finally {
      harness.close();
    }
  });

  it("requires a reviewed branch after genuine later semantic work", async () => {
    const source = createSourceMessages();
    const harness = createCompactionTransactionHarness(source, {
      compactionMode: "automatic",
      sessionId: "automatic-boundary-reviewed-source",
    });
    const targetSessionId = "automatic-boundary-reviewed-target";
    try {
      const attemptId = await runAutomaticCompactionThroughCommit(harness, source);
      harness.store.appendRollout(
        {
          type: "response_item",
          payload: {
            role: "user",
            content: "genuine later semantic work",
          },
        },
        { durable: true },
      );
      const sourceProjectionBeforeRollback = reconstructFromRollout(
        harness.store.readAll(),
      ).history;

      expect(() =>
        harness.store.rollbackCompaction({
          attemptId,
          nowMs: Date.now(),
        })
      ).toThrow(/requires an explicit reviewed branch target/i);

      const rollback = harness.store.rollbackCompaction({
        attemptId,
        nowMs: Date.now(),
        reviewedBranchTargetSessionId: targetSessionId,
      });
      expect(rollback.rollback_mode).toBe("reviewed_branch");
      expect(rollback.source_history).toEqual(expectedSourceHistory(source));
      expect(
        reconstructFromRollout(harness.store.readAll()).history,
      ).toEqual(sourceProjectionBeforeRollback);

      const target = new SessionStore({
        cwd: harness.store.store.cwd,
        sessionId: targetSessionId,
        agencVersion: "0.13.0",
        resume: true,
      });
      try {
        expect(reconstructFromRollout(target.readAll()).history).toEqual(
          expectedSourceHistory(source),
        );
      } finally {
        target.close();
      }
    } finally {
      harness.close();
    }
  });
});

async function runAutomaticCompactionThroughCommit(
  harness: CompactionTransactionHarness,
  source: readonly RuntimeMessage[],
): Promise<string> {
  const result = await compactConversation(source, harness.context);
  const transaction = result.transaction;
  if (transaction === undefined) {
    throw new Error("automatic contract requires a durable transaction");
  }

  const ctx = commitContext(harness.store.store.cwd);
  const state = buildInitialTurnState(ctx, {
    role: "user",
    content: "commit automatic compaction",
  });
  const cleanup = vi.fn();
  await finalizeCompactionTransaction({
    store: harness.store,
    attemptId: transaction.attempt_id,
    applyProjection: () => {
      state.messages = transaction.committed.replacement_history.map(
        responseItemToLlmMessage,
      );
      state.messagesForQuery = [...state.messages];
      state.autoCompactTracking = {
        compacted: true,
        turnId: "automatic-contract-turn",
        turnCounter: 0,
        consecutiveFailures: 0,
      };
    },
    cleanup,
  });
  expect(cleanup).toHaveBeenCalledOnce();

  stampHarnessEventIds(harness);
  await commit(state, ctx, harness.session);
  await commit(state, ctx, harness.session);
  expect(state.autoCompactTracking?.turnCounter).toBe(1);
  return transaction.attempt_id;
}

function stampHarnessEventIds(harness: CompactionTransactionHarness): void {
  type HarnessEvent = {
    readonly id: string;
    readonly eventId?: string;
    readonly [key: string]: unknown;
  };
  type HarnessEmitter = {
    emit(
      event: HarnessEvent,
      options?: { readonly durable?: boolean },
    ): unknown;
  };
  const session = harness.session as unknown as HarnessEmitter;
  const emit = session.emit.bind(session);
  session.emit = (event, options) =>
    emit({ ...event, eventId: event.eventId ?? event.id }, options);
}

function commitContext(cwd: string): TurnContext {
  return {
    cwd,
    subId: "automatic-contract-turn",
    editorInteraction: {
      interactionId: "automatic-contract-editor",
      kind: "ask",
      policy: "read_only",
      editorInstanceId: "automatic-contract-editor",
      bufferHandle: 1,
      changedtick: 1,
      contentSha256: "a".repeat(64),
      path: `${cwd}/automatic-contract.ts`,
      range: {
        start: { line: 1, column: 0 },
        end: { line: 1, column: 1 },
      },
    },
  } as TurnContext;
}

function createSourceMessages(): readonly RuntimeMessage[] {
  return Array.from({ length: SOURCE_MESSAGE_COUNT }, (_, index) => ({
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    content: `source-${index}:${"x".repeat(SOURCE_MESSAGE_BYTES)}`,
  }));
}

function expectedSourceHistory(source: readonly RuntimeMessage[]) {
  return source.map((message) => ({
    role: message.role ?? "user",
    content: message.content ?? "",
  }));
}
