import { describe, expect, test } from "vitest";
import { phaseEventToProgressEvent } from "../../src/app-server/background-agent-runner.js";

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
  test("bounded stops end the turn, never the run", () => {
    for (const reason of [
      "no_progress",
      "max_turns",
      "max_budget_usd",
      "compact_failed",
    ]) {
      const mapped = phaseEventToProgressEvent(turnComplete(reason));
      expect(mapped?.kind, reason).toBe("turn_complete");
      expect(
        (mapped as { finalMessage?: string }).finalMessage,
        reason,
      ).toBeTruthy();
    }
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

  test("a genuine error still ends the run", () => {
    const mapped = phaseEventToProgressEvent(turnComplete("error"));
    expect(mapped?.kind).toBe("run_error");
  });

  test("completed stays a plain turn completion", () => {
    const mapped = phaseEventToProgressEvent(turnComplete("completed", "done"));
    expect(mapped?.kind).toBe("turn_complete");
  });
});
