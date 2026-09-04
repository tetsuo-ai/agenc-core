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
      "editor_request_failed",
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

  test("editor_request_failed prefers the scoped failure over leftover assistant text", () => {
    const mapped = phaseEventToProgressEvent({
      type: "turn_complete",
      content: "Prompt is too long: 200000 tokens > 128000",
      usage,
      stopReason: "editor_request_failed",
      error: new Error("editor_interaction_recovery_blocked: context_window"),
      turnId: "turn-1",
    } as never);
    expect(mapped?.kind).toBe("turn_complete");
    expect((mapped as { finalMessage?: string }).finalMessage).toContain(
      "editor_interaction_recovery_blocked",
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
