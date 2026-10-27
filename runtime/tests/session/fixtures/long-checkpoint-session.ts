/**
 * A long tool-use session as run-turn persists it, and the checkpoints the
 * writer takes over it, for tests of open-time checkpoint validation.
 */
import { computeCheckpointPrefixHashV4, readTurnCheckpoint } from "../../../src/session/durable-checkpoint-reader.js";
import { ROLLOUT_SCHEMA_VERSION, type TurnCheckpointV4Event } from "../../../src/session/event-log.js";
import type { RolloutItem, ToolResultIntegrityResponseItem } from "../../../src/session/rollout-item.js";
import { createToolResultIntegrity } from "../../../src/session/tool-result-integrity.js";
import type {
  ToolPairProjection,
  ToolPairProjectionRecord,
} from "../../../src/session/tool-pair-validator.js";
import { buildInitialTurnState, toCheckpointSlice } from "../../../src/session/turn-state.js";
import { mkCtx } from "../../fixtures.js";

export const RUN_ID = "conv-incremental-checkpoints";

export type Message = ToolResultIntegrityResponseItem;

export function sealed(callId: string, content: string, runId = RUN_ID): Message {
  return {
    role: "tool",
    content,
    toolCallId: callId,
    toolName: "Read",
    toolResultIntegrity: createToolResultIntegrity({ runId, toolCallId: callId, content }),
  };
}

export function assistant(index: number, callIds: readonly string[]): Message {
  return {
    role: "assistant",
    content: "",
    id: `resp-${index}`,
    phase: "commentary",
    toolCalls: callIds.map((id) => ({
      id,
      name: "Read",
      arguments: JSON.stringify({ file_path: `/workspace/src/module-${index}.ts` }),
    })),
    providerReasoning: {
      version: 2,
      provider: "deepseek",
      model: "deepseek-flash",
      content: `Step ${index}: read the module, then compare it with the test — ✓ 测试.`,
    },
  };
}

/** A session of `windows` tool rounds; round 7 runs two calls in parallel. */
export function longSession(windows: number): Message[] {
  const history: Message[] = [{ role: "user", content: "Refactor the parser modules; keep tests green." }];
  for (let index = 1; index <= windows; index += 1) {
    const calls = index === 7 ? [`call-${index}-a`, `call-${index}-b`] : [`call-${index}`];
    history.push(assistant(index, calls));
    for (const call of calls) {
      history.push(sealed(call, `export const value${index} = compute(${JSON.stringify(call)});\n`.repeat(8)));
    }
  }
  history.push({ role: "assistant", content: "All modules refactored.", phase: "final_answer" });
  return history;
}

const resumableState = toCheckpointSlice(
  buildInitialTurnState(mkCtx(), { role: "user", content: "resume this turn" }),
);

export function checkpoint(
  history: readonly Message[],
  count: number,
  boundary: "postAssistant" | "iteration",
  checkpointSeq: number,
  prefixHash = computeCheckpointPrefixHashV4(history, count),
): TurnCheckpointV4Event {
  const readable = readTurnCheckpoint({
    turnId: "turn-1",
    iterationIndex: checkpointSeq,
    boundary,
    checkpointSeq,
    persistedMessageCount: count,
    prefixHash,
    resumableState,
    checkpointVersion: 4,
    toolResultIntegrityVersion: 1,
    prefixHashVersion: 4,
  });
  if (readable.version !== 4) throw new Error("checkpoint is not v4");
  return readable.checkpoint;
}

/** The checkpoints run-turn writes: after each assistant message and after its results. */
export function writerCheckpoints(history: readonly Message[]): TurnCheckpointV4Event[] {
  const checkpoints: TurnCheckpointV4Event[] = [];
  for (let count = 1; count <= history.length; count += 1) {
    const last = history[count - 1]!;
    const next = history[count];
    if (last.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) {
      checkpoints.push(checkpoint(history, count, "postAssistant", checkpoints.length + 1));
    } else if (last.role === "tool" && next?.role !== "tool") {
      checkpoints.push(checkpoint(history, count, "iteration", checkpoints.length + 1));
    }
  }
  return checkpoints;
}

/** Counts the projection work a planner run performs. */
export class CountingProjection implements ToolPairProjection {
  depth = 0;
  transactions = 0;
  inserts = 0;
  resolves = 0;
  constructor(private readonly inner: ToolPairProjection) {}
  runAtomically<T>(operation: () => T): T {
    if (this.depth === 0) this.transactions += 1;
    this.depth += 1;
    try {
      return this.inner.runAtomically(operation);
    } finally {
      this.depth -= 1;
    }
  }
  reset(params: { readonly projectionId: string; readonly sourceKey: string }): void {
    this.inner.reset(params);
  }
  find(projectionId: string, callId: string): ToolPairProjectionRecord | undefined {
    return this.inner.find(projectionId, callId);
  }
  insertCall(projectionId: string, record: ToolPairProjectionRecord): boolean {
    this.inserts += 1;
    return this.inner.insertCall(projectionId, record);
  }
  resolveCall(params: Parameters<ToolPairProjection["resolveCall"]>[0]): ReturnType<ToolPairProjection["resolveCall"]> {
    this.resolves += 1;
    return this.inner.resolveCall(params);
  }
  complete(...args: Parameters<ToolPairProjection["complete"]>): void {
    this.inner.complete(...args);
  }
  completeDangling(...args: Parameters<ToolPairProjection["completeDangling"]>): void {
    this.inner.completeDangling(...args);
  }
  fail(...args: Parameters<ToolPairProjection["fail"]>): void {
    this.inner.fail(...args);
  }
}

export function rolloutItems(history: readonly Message[], checkpoints: readonly TurnCheckpointV4Event[]): RolloutItem[] {
  const items: RolloutItem[] = [{
    type: "session_meta",
    payload: {
      sessionId: RUN_ID,
      timestamp: "2026-10-20T00:00:00.000Z",
      cwd: "/workspace",
      originator: "test",
      agencVersion: "test",
      rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
    },
  } as RolloutItem];
  let next = 0;
  for (const event of checkpoints) {
    while (next < event.persistedMessageCount) {
      items.push({ type: "response_item", payload: history[next]! } as RolloutItem);
      next += 1;
    }
    items.push({
      type: "event_msg",
      payload: {
        eventId: `checkpoint:${event.checkpointSeq}`,
        id: "checkpoint-event",
        seq: event.checkpointSeq,
        msg: { type: "turn_checkpoint", payload: event },
      },
    } as RolloutItem);
  }
  return items;
}
