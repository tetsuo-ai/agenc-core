import { describe, expect, test } from "vitest";
import {
  buildCompactedHistory,
  reconstructFromRollout,
} from "./rollout-reconstruction.js";
import { DEFAULT_MAX_TOOL_RESULT_BYTES } from "../tools/execution.js";
import {
  parseRolloutLine,
  type RolloutItem,
} from "./rollout-item.js";
import type { IndexSnapshot } from "./session-store.js";
import {
  REALTIME_CONVERSATION_CLOSE_TAG,
  REALTIME_CONVERSATION_OPEN_TAG,
} from "../conversation/realtime/instructions/markers.js";

describe("rollout-reconstruction", () => {
  test("replays response_items into history", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "1",
          seq: 1,
          msg: {
            type: "turn_started",
            payload: { turnId: "t1" },
          },
        },
      },
      { type: "response_item", payload: { role: "user", content: "hello" } },
      { type: "response_item", payload: { role: "assistant", content: "hi" } },
      {
        type: "event_msg",
        payload: {
          id: "2",
          seq: 2,
          msg: {
            type: "turn_complete",
            payload: { turnId: "t1" },
          },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.history).toHaveLength(2);
    expect(r.orphanedTurnIds).toHaveLength(0);
  });

  test("compacted.replacementHistory becomes baseline", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "old" } },
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [{ role: "user", content: "boundary" }],
        },
      },
      { type: "response_item", payload: { role: "assistant", content: "new" } },
    ];
    const r = reconstructFromRollout(items);
    expect(r.history[0]?.content).toBe("boundary");
    expect(r.history[1]?.content).toBe("new");
  });

  test("replays the full persisted compacted replacement history, including boundary and preserved tail", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "discard me" } },
      {
        type: "compacted",
        payload: {
          message: "summary",
          replacementHistory: [
            { role: "system", content: "boundary" },
            { role: "assistant", content: "summary text" },
            { role: "user", content: "kept tail" },
          ],
        },
      },
      { type: "response_item", payload: { role: "assistant", content: "after compact" } },
    ];

    const r = reconstructFromRollout(items);
    expect(r.history).toEqual([
      { role: "system", content: "boundary" },
      { role: "assistant", content: "summary text" },
      { role: "user", content: "kept tail" },
      { role: "assistant", content: "after compact" },
    ]);
  });

  test("newest surviving replacementHistory wins and only the suffix replays", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "discard me" } },
      {
        type: "compacted",
        payload: {
          message: "old summary",
          replacementHistory: [{ role: "user", content: "old baseline" }],
        },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "discard after old compact" },
      },
      {
        type: "compacted",
        payload: {
          message: "new summary",
          replacementHistory: [{ role: "user", content: "new baseline" }],
        },
      },
      { type: "response_item", payload: { role: "assistant", content: "kept tail" } },
    ];

    const r = reconstructFromRollout(items);
    expect(r.history).toEqual([
      { role: "user", content: "new baseline" },
      { role: "assistant", content: "kept tail" },
    ]);
  });

  test("I-48 orphan TurnStarted synthesizes process_killed abort", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t-orphan" } },
        },
      },
      { type: "response_item", payload: { role: "user", content: "mid-turn" } },
      // No TurnComplete/Aborted for t-orphan.
    ];
    const r = reconstructFromRollout(items);
    expect(r.orphanedTurnIds).toContain("t-orphan");
    const synthTypes = r.synthesizedEvents.map((ev) =>
      ev.type === "event_msg" ? ev.payload.msg.type : ev.type,
    );
    expect(synthTypes).toContain("turn_aborted");
    expect(synthTypes).toContain("warning");
  });

  test("I-25: snapshot.seq < rollout.lastSeq → snapshotBehindRollout + warning", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
      {
        type: "event_msg",
        payload: {
          id: "b",
          seq: 5,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
    ];
    const staleSnapshot: IndexSnapshot = {
      snapshotSequenceNumber: 2, // behind
      fileSize: 100,
      rolloutPath: "x",
      toolResultBytesByTurn: {},
      offsetsBySeq: {},
      writtenAtMs: Date.now(),
      agencVersion: "0.2.0",
      schemaVersion: 1,
    };
    const r = reconstructFromRollout(items, { indexSnapshot: staleSnapshot });
    expect(r.snapshotBehindRollout).toBe(true);
    expect(r.consumedSnapshot).toBeUndefined();
    const hasWarning = r.synthesizedEvents.some(
      (ev) =>
        ev.type === "event_msg" &&
        ev.payload.msg.type === "warning" &&
        (ev.payload.msg.payload as { cause?: string }).cause ===
          "snapshot_behind_rollout",
    );
    expect(hasWarning).toBe(true);
  });

  test("I-25: snapshot.seq ≥ rollout.lastSeq is accepted", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: { type: "warning", payload: { cause: "x", message: "y" } },
        },
      },
    ];
    const freshSnapshot: IndexSnapshot = {
      snapshotSequenceNumber: 1,
      fileSize: 100,
      rolloutPath: "x",
      toolResultBytesByTurn: {},
      offsetsBySeq: {},
      writtenAtMs: Date.now(),
      agencVersion: "0.2.0",
      schemaVersion: 1,
    };
    const r = reconstructFromRollout(items, { indexSnapshot: freshSnapshot });
    expect(r.snapshotBehindRollout).toBe(false);
    expect(r.consumedSnapshot).toBe(freshSnapshot);
  });

  test("isUserTurnBoundary excludes tool-result response_items", () => {
    // AgenC behavior: a role='user' response_item carrying a
    // function_call_output / tool_use_result must NOT count as a
    // user-turn boundary during reverse-scan. We verify this via
    // the thread_rolled_back drop logic, which counts boundaries
    // the same way. agenc runtime `trim_pre_turn_context_updates`
    // (history.rs:428-456) additionally strips contextual user
    // injections sitting *above* the cut index, so the
    // `<environment_context>` fragment between real-u1 and real-u2
    // is trimmed along with the rolled-back turn (history.rs:260).
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "real-u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
      // Tool-role (function_call_output analogue): NOT a boundary.
      {
        type: "response_item",
        payload: {
          role: "tool",
          content: "tool result blob",
          toolCallId: "call-1",
          toolName: "shell",
        },
      },
      // Contextual user injection: NOT a boundary; trimmed by
      // `trim_pre_turn_context_updates` when it sits above the cut.
      {
        type: "response_item",
        payload: {
          role: "user",
          content: "<environment_context>cwd=/tmp</environment_context>",
        },
      },
      { type: "response_item", payload: { role: "user", content: "real-u2" } },
      { type: "response_item", payload: { role: "assistant", content: "a2" } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    const userTexts = r.history
      .filter((h) => h.role === "user")
      .map((h) => h.content);
    // real-u1 survives: the rolled-back turn is real-u2, not real-u1.
    expect(userTexts).toContain("real-u1");
    expect(userTexts).not.toContain("real-u2");
    // agenc runtime `trim_pre_turn_context_updates` (history.rs:428-456)
    // strips the contextual <environment_context> injection that
    // sat immediately above the rollback cut, so the fragment is
    // dropped too.
    expect(userTexts).not.toContain(
      "<environment_context>cwd=/tmp</environment_context>",
    );
  });

  test("thread rollback trims realtime developer context without counting it as a user turn", () => {
    const realtimeDeveloper = `${REALTIME_CONVERSATION_OPEN_TAG}\nstarted\n${REALTIME_CONVERSATION_CLOSE_TAG}`;
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "real-u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
      {
        type: "response_item",
        payload: {
          role: "developer",
          content: [{ type: "input_text", text: realtimeDeveloper }],
        },
      },
      { type: "response_item", payload: { role: "user", content: "real-u2" } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];

    const r = reconstructFromRollout(items);

    expect(r.history.map((item) => item.content)).toEqual(["real-u1", "a1"]);
  });

  test("rollback clears reduced turn context when trimming mixed developer context", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "real-u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
      {
        type: "turn_context",
        payload: {
          turnId: "t2",
          cwd: "/tmp",
          approvalPolicy: "never",
          sandboxPolicy: "workspace-write",
          model: "grok-4",
          realtimeActive: true,
        } as unknown as import("./event-log.js").TurnContextItem,
      },
      {
        type: "response_item",
        payload: {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: `${REALTIME_CONVERSATION_OPEN_TAG}\nstarted\n${REALTIME_CONVERSATION_CLOSE_TAG}`,
            },
            { type: "input_text", text: "persistent developer text" },
          ],
        },
      },
      { type: "response_item", payload: { role: "user", content: "real-u2" } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];

    const r = reconstructFromRollout(items);

    expect(r.history.map((item) => item.content)).toEqual(["real-u1", "a1"]);
    expect(r.state.lastTurnContext).toBeUndefined();
  });

  test("realtimeActive flows from turn_context into previousTurnSettings", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "1",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t1" } },
        },
      },
      {
        type: "turn_context",
        payload: {
          turnId: "t1",
          cwd: "/tmp",
          approvalPolicy: "never",
          sandboxPolicy: "workspace-write",
          model: "grok-4",
          realtimeActive: true,
        } as unknown as import("./event-log.js").TurnContextItem,
      },
      { type: "response_item", payload: { role: "user", content: "hi" } },
      {
        type: "event_msg",
        payload: {
          id: "2",
          seq: 2,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.previousTurnSettings).toBeDefined();
    expect(r.previousTurnSettings?.model).toBe("grok-4");
    expect(r.previousTurnSettings?.realtimeActive).toBe(true);
  });

  test("legacy compacted (no replacementHistory) rebuilds history via buildCompactedHistory", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "first ask" } },
      {
        type: "response_item",
        payload: { role: "assistant", content: "first answer" },
      },
      { type: "response_item", payload: { role: "user", content: "second ask" } },
      // Legacy compaction: message only, no replacementHistory.
      { type: "compacted", payload: { message: "summary blob" } },
    ];
    const r = reconstructFromRollout(items);
    // buildCompactedHistory must preserve real user messages + a
    // final user-role summary message. The assistant message is
    // dropped because the rebuild seeds only user-message context.
    expect(r.history.every((h) => h.role === "user")).toBe(true);
    const texts = r.history.map((h) => h.content);
    expect(texts).toContain("first ask");
    expect(texts).toContain("second ask");
    expect(texts[texts.length - 1]).toBe("summary blob");
    // Reference context cleared per agenc runtime legacy-compaction branch.
    expect(r.referenceContextItem).toBeUndefined();
  });

  test("parseRolloutLine normalizes legacy task_* event aliases before replay", () => {
    const started = parseRolloutLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          id: "legacy-start",
          msg: { type: "task_started", payload: { turnId: "turn-1" } },
        },
      }),
    );
    const completed = parseRolloutLine(
      JSON.stringify({
        type: "event_msg",
        payload: {
          id: "legacy-complete",
          msg: { type: "task_complete", payload: { turnId: "turn-1" } },
        },
      }),
    );

    expect(started?.type).toBe("event_msg");
    expect(completed?.type).toBe("event_msg");
    if (started?.type === "event_msg" && completed?.type === "event_msg") {
      expect(started.payload.msg.type).toBe("turn_started");
      expect(completed.payload.msg.type).toBe("turn_complete");
    }
  });

  test("replay truncation caps oversized tool-output text only (tool item)", () => {
    // agenc runtime `ContextManager::process_item` (history.rs:375-409)
    // only truncates FunctionCallOutput / CustomToolCallOutput on
    // replay — plain Message (role=assistant/user) content passes
    // through unchanged. Verify both branches.
    const big = "x".repeat(DEFAULT_MAX_TOOL_RESULT_BYTES + 10_000);
    const items: RolloutItem[] = [
      // Assistant Message: must NOT be truncated.
      { type: "response_item", payload: { role: "assistant", content: big } },
      // Tool-role output: MUST be truncated (agenc runtime FunctionCallOutput).
      {
        type: "response_item",
        payload: {
          role: "tool",
          content: big,
          toolCallId: "call-big",
          toolName: "shell",
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.history).toHaveLength(2);

    // Assistant Message payload must be preserved byte-for-byte.
    const assistant = r.history[0];
    expect(assistant?.role).toBe("assistant");
    expect(typeof assistant?.content).toBe("string");
    expect((assistant?.content as string).length).toBe(big.length);

    // Tool-output payload must be capped to the I-15 ceiling.
    const toolOut = r.history[1];
    expect(toolOut?.role).toBe("tool");
    expect(typeof toolOut?.content).toBe("string");
    expect((toolOut?.content as string).length).toBeLessThanOrEqual(
      DEFAULT_MAX_TOOL_RESULT_BYTES,
    );
    expect(toolOut?.content as string).toContain("[truncated:");
  });

  test("reductionReport surfaces processed count + propagates to result", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
    ];
    const r = reconstructFromRollout(items);
    expect(r.reductionReport).toBeDefined();
    expect(r.reductionReport?.processed).toBe(2);
    expect(r.reductionReport?.unknownVariantCount).toBe(0);
    expect(r.reductionReport?.seqGapCount).toBe(0);
  });

  test("buildCompactedHistory: summary always last, user messages preserved", () => {
    const rebuilt = buildCompactedHistory(["a", "b", "c"], "summary");
    expect(rebuilt).toHaveLength(4);
    expect(rebuilt.map((h) => h.content)).toEqual(["a", "b", "c", "summary"]);
    expect(rebuilt.every((h) => h.role === "user")).toBe(true);
  });

  test("thread_rolled_back drops user turns in forward replay", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "u1" } },
      { type: "response_item", payload: { role: "assistant", content: "a1" } },
      { type: "response_item", payload: { role: "user", content: "u2" } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 3,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    expect(r.state.history.length).toBeLessThanOrEqual(2);
  });

  /**
   * Port of agenc runtime
   * `reconstruct_history_rollback_counts_inter_agent_assistant_turns`
   * (agenc-rs/core/src/session/rollout_reconstruction_tests.rs:479-571).
   *
   * agenc runtime `is_user_turn_boundary` (history.rs:703-710) counts an
   * assistant-role message whose content is an inter-agent
   * instruction JSON payload as a user-turn boundary. Rolling back
   * one user turn must therefore drop the inter-agent assistant turn
   * (second turn) while keeping the first real user turn.
   */
  test("thread_rolled_back counts inter-agent-assistant turns", () => {
    const interAgentPayload = JSON.stringify({
      author: "root",
      recipient: "root/worker",
      other_recipients: [],
      content: "continue",
      trigger_turn: true,
    });

    const items: RolloutItem[] = [
      // Turn 1: real user turn.
      {
        type: "event_msg",
        payload: {
          id: "1",
          seq: 1,
          msg: { type: "turn_started", payload: { turnId: "t1" } },
        },
      },
      {
        type: "response_item",
        payload: { role: "user", content: "turn 1 user" },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "turn 1 assistant" },
      },
      {
        type: "event_msg",
        payload: {
          id: "2",
          seq: 2,
          msg: { type: "turn_complete", payload: { turnId: "t1" } },
        },
      },
      // Turn 2: inter-agent assistant-instruction turn (counts as a
      // user-turn boundary per agenc runtime).
      {
        type: "event_msg",
        payload: {
          id: "3",
          seq: 3,
          msg: { type: "turn_started", payload: { turnId: "t2" } },
        },
      },
      {
        type: "response_item",
        payload: {
          role: "assistant",
          content: [{ type: "output_text", text: interAgentPayload }],
        },
      },
      {
        type: "response_item",
        payload: { role: "assistant", content: "worker reply" },
      },
      {
        type: "event_msg",
        payload: {
          id: "4",
          seq: 4,
          msg: { type: "turn_complete", payload: { turnId: "t2" } },
        },
      },
      // Roll back 1 user turn → the inter-agent-assistant turn + its
      // tail must be dropped, leaving only turn 1's history.
      {
        type: "event_msg",
        payload: {
          id: "5",
          seq: 5,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];

    const r = reconstructFromRollout(items);
    // After rollback, only turn 1's items survive.
    const texts = r.history.map((h) =>
      typeof h.content === "string"
        ? h.content
        : h.content.map((f) => f.text ?? "").join(""),
    );
    expect(texts).toContain("turn 1 user");
    expect(texts).toContain("turn 1 assistant");
    expect(texts).not.toContain(interAgentPayload);
    expect(texts).not.toContain("worker reply");
  });

  /**
   * AGENC.md fragments use AgenC-owned markers
   * (`# AGENC.md instructions for ` / `</INSTRUCTIONS>`). A
   * content-array fragment whose text matches both the start and
   * end markers is contextual and must NOT count as a user-turn
   * boundary. The matcher is case-insensitive per
   * `fragment.rs:23-33`.
   */
  test("AGENC.md-style contextual fragments require matching close tag", () => {
    const agencMdBody =
      "# AGENC.md instructions for project\nsome body\n</INSTRUCTIONS>";
    const fakeOpenOnly = "# AGENC.md instructions for project\nsome body"; // no close → real user turn
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: agencMdBody } },
      { type: "response_item", payload: { role: "user", content: fakeOpenOnly } },
      {
        type: "event_msg",
        payload: {
          id: "r",
          seq: 1,
          msg: { type: "thread_rolled_back", payload: { numTurns: 1 } },
        },
      },
    ];
    const r = reconstructFromRollout(items);
    // Only the fakeOpenOnly message counts as a boundary, so
    // rollback=1 drops it. The contextual AGENC.md fragment stays.
    const texts = r.history.map((h) => h.content as string);
    expect(texts).toContain(agencMdBody);
    expect(texts).not.toContain(fakeOpenOnly);
  });

  /**
   * `collectUserMessages` / legacy compaction rebuild must skip a
   * previously-emitted summary message (agenc runtime `is_summary_message`
   * at `compact.rs:410-412`). We feed a history with the rendered
   * summary prefix verbatim and assert that a subsequent legacy
   * compaction rebuild does not re-feed it.
   */
  test("legacy compaction rebuild skips a prior summary_prefix message", () => {
    const summaryPrefix =
      "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
    const priorSummary = `${summaryPrefix}\nprevious summary body`;
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "real ask" } },
      // A previous compaction summary now sitting in history:
      { type: "response_item", payload: { role: "user", content: priorSummary } },
      // Legacy compaction (no replacement history):
      { type: "compacted", payload: { message: "new summary blob" } },
    ];
    const r = reconstructFromRollout(items);
    const texts = r.history.map((h) => h.content as string);
    // Real user message is preserved, prior summary is not re-fed.
    expect(texts).toContain("real ask");
    expect(texts).not.toContain(priorSummary);
    // New summary is the tail.
    expect(texts[texts.length - 1]).toBe("new summary blob");
  });
});
