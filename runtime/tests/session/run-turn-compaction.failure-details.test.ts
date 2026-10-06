import { afterEach, describe, expect, test, vi } from "vitest";
import type { LLMResponse } from "../../src/llm/types.js";
import { CompactionTransactionFailureWithDetails } from "../../src/services/compact/failure-details.js";
import { runTurn, setAutoCompactImplForTests } from "../../src/session/run-turn.js";
import * as debug from "../../src/utils/debug.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => {
  setAutoCompactImplForTests(null);
  vi.restoreAllMocks();
});

/**
 * Terminal-Bench `layout-config-recreation2__RtxCUzj` (#2499): the run died
 * on `auto_compact_failed: context_limit/in_turn: durable compaction commit
 * failed` and nothing recorded why. The warning now carries the cause in
 * its message and as structured details, and the same line goes to the
 * debug log at warn level.
 */
describe("auto_compact_failed carries the failure's cause (#2499)", () => {
  test("a commit failure's cause and size facts reach the warning and the debug log", async () => {
    const logged = vi.spyOn(debug, "logForDebugging").mockImplementation(() => {});
    let streamCount = 0;
    const provider = mkProvider({});
    provider.chatStream = async (): Promise<LLMResponse> => {
      streamCount += 1;
      return {
        content: streamCount === 1 ? "need a tool" : "must not be reached",
        toolCalls: streamCount === 1 ? [{ id: "toolu_commit", name: "Read", arguments: "{}" }] : [],
        usage: { promptTokens: 18_130, completionTokens: 10, totalTokens: 18_140 },
        model: "test-model",
        finishReason: streamCount === 1 ? "tool_calls" : "stop",
      };
    };
    const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
      code: "ENOSPC",
      syscall: "write",
      path: "/work/.agenc/rollout.jsonl",
    });
    setAutoCompactImplForTests(async () => {
      throw new CompactionTransactionFailureWithDetails(
        "commit_failed",
        "durable compaction commit failed: Error: ENOSPC: no space left on device, write (code=ENOSPC, syscall=write, path=/work/.agenc/rollout.jsonl); replacement history 4096 bytes (3 messages), payload bundles 3 (3 chunks, 6000 canonical bytes), summary 900 bytes",
        { replacement_history_bytes: 4096, replacement_history_messages: 3, payload_bundle_count: 3 },
        { cause: enospc },
      );
    });
    const { session, events } = mkSession({
      provider,
      modelInfo: { autoCompactTokenLimit: 18_129 } as never,
    });

    // A typed transaction failure propagates out of the turn (the run in the
    // trial exited 1); the warning must already be on the record by then.
    await expect(drain(runTurn(session, mkCtx({
      modelInfo: { ...mkCtx().modelInfo, autoCompactTokenLimit: 18_129 } as never,
    }), "start"))).rejects.toThrow(/durable compaction commit failed: Error: ENOSPC/);

    expect(streamCount).toBe(1);
    const warnings = events.flatMap((event) =>
      event.msg.type === "warning" && event.msg.payload.cause === "auto_compact_failed"
        ? [event.msg.payload]
        : [],
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("context_limit/in_turn: durable compaction commit failed: Error: ENOSPC");
    expect(warnings[0]?.message).toContain("replacement history 4096 bytes");
    expect(warnings[0]?.details).toMatchObject({
      replacement_history_bytes: 4096,
      payload_bundle_count: 3,
      error_reason: "commit_failed",
      cause_code: "ENOSPC",
      cause_syscall: "write",
      cause_path: "/work/.agenc/rollout.jsonl",
    });
    const warnLines = logged.mock.calls.filter(([, options]) => options?.level === "warn");
    expect(warnLines.some(([line]) =>
      line.includes("auto_compact_failed context_limit/in_turn") &&
      line.includes("ENOSPC") &&
      line.includes('"cause_code":"ENOSPC"'),
    )).toBe(true);
  });
});
