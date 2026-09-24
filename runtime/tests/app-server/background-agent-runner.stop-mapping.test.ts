import { describe, expect, test } from "vitest";
import { phaseEventToProgressEvent } from "../../src/app-server/background-agent-runner.js";
import { terminalResultFromThread } from "../../src/app-server/background-agent-runner/turn-lifecycle.js";

const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 } as never;

function turnComplete(stopReason: string, content = ""): never {
  return {
    type: "turn_complete",
    content,
    usage,
    stopReason,
    turnId: "turn-1",
  } as never;
}

describe("stop-reason mapping decides turn versus run scope", () => {

  test("serializes string and object terminal thread statuses", () => {
    const active = { lastActiveAt: "2026-09-23T10:00:00.000Z",
      thread: { totalTokenUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }) },
      bootstrap: { session: { services: {} } } } as never;
    expect(terminalResultFromThread(active, "run-1", "shutdown")).toMatchObject({
      status: "cancelled", stopReason: "shutdown", finishedAt: "2026-09-23T10:00:00.000Z",
    });
    expect(terminalResultFromThread(active, "run-1", {
      status: "completed", turnId: "turn-1", lastMessage: "done", endedAtMs: 1_000,
    })).toMatchObject({ status: "completed", finalMessage: "done", finishedAt: "1970-01-01T00:00:01.000Z" });
  });

  test("compact_failed prefers the skip message over leftover assistant text", () => {
    const mapped = phaseEventToProgressEvent({
      type: "turn_complete",
      content: "need a tool",
      usage,
      stopReason: "compact_failed",
      error: new Error(
        "mid_turn_compact_skipped: lastSamplePromptTokens=200000 limit=180000",
      ),
      turnId: "turn-1",
    } as never);
    expect(mapped?.kind).toBe("turn_complete");
    expect((mapped as { finalMessage?: string }).finalMessage).toContain(
      "mid_turn_compact_skipped",
    );
  });

  test("the backstop's own message travels as the turn's final message", () => {
    const mapped = phaseEventToProgressEvent(
      turnComplete("no_progress", "Turn stopped by the no-progress backstop."),
    );
    expect((mapped as { finalMessage?: string }).finalMessage).toBe(
      "Turn stopped by the no-progress backstop.",
    );
  });

  test("effect_review_required names the review the operator must run (#2501)", () => {
    const mapped = phaseEventToProgressEvent(turnComplete("effect_review_required"));
    expect(mapped?.kind).toBe("turn_complete");
    expect((mapped as { finalMessage?: string }).finalMessage).toContain("/resolve");
  });

  test("a turn error ends the turn with the failure spelled out, never the run", () => {
    const mapped = phaseEventToProgressEvent({
      type: "turn_complete",
      content: "",
      usage,
      stopReason: "error",
      error: new Error("grok error: Connection error."),
      turnId: "turn-1",
    } as never);
    expect(mapped?.kind).toBe("turn_complete");
    expect((mapped as { finalMessage?: string }).finalMessage).toBe(
      "Turn failed: grok error: Connection error. Send a new prompt to retry.",
    );
    const bare = phaseEventToProgressEvent(turnComplete("error"));
    expect(bare?.kind).toBe("turn_complete");
    expect((bare as { finalMessage?: string }).finalMessage).toBe(
      "Turn failed: turn errored. Send a new prompt to retry.",
    );
  });

  test("completed stays a plain turn completion", () => {
    const mapped = phaseEventToProgressEvent(turnComplete("completed", "done"));
    expect(mapped?.kind).toBe("turn_complete");
  });
});
