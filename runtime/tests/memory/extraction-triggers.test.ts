import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import type { CompletedToolResultRecord } from "../session/turn-state.js";
import {
  createMemoryExtractionTriggerState,
  DEFAULT_MIN_ELIGIBLE_TURNS,
  hasSuccessfulMemoryWrite,
  isMainMemoryExtractionContext,
  isMemoryExtractionDisabledByEnv,
  memoryExtractionVisibleRange,
  parseMemoryToolArguments,
  shouldDeferForEligibleTurnCadence,
} from "./extraction-triggers.js";

describe("memory extraction triggers", () => {
  it("falls back to retained visible messages when compaction shrinks history", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "hidden" },
      { role: "user", content: "remember this" },
      { role: "assistant", content: "ok" },
    ];

    const range = memoryExtractionVisibleRange(messages, 10);

    expect(range.currentVisibleCount).toBe(2);
    expect(range.unprocessedMessages).toEqual(messages.slice(1));
  });

  it("detects successful absolute memory writes and ignores failed or relative writes", () => {
    const messages: LLMMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-failed",
            name: "Write",
            arguments: JSON.stringify({ file_path: "/memory/failed.md" }),
          },
          {
            id: "write-relative",
            name: "Write",
            arguments: JSON.stringify({ file_path: "relative.md" }),
          },
          {
            id: "write-success",
            name: "MultiEdit",
            arguments: JSON.stringify({ file_path: "/memory/saved.md" }),
          },
        ],
      },
    ];
    const completedToolResults: CompletedToolResultRecord[] = [
      {
        callId: "write-failed",
        toolName: "Write",
        arguments: "{}",
        content: "failed",
        isError: true,
      },
      {
        callId: "write-relative",
        toolName: "Write",
        arguments: "{}",
        content: "ok",
        isError: false,
      },
      {
        callId: "write-success",
        toolName: "MultiEdit",
        arguments: "{}",
        content: "ok",
        isError: false,
      },
    ];
    const resolveMemoryPath = (value: unknown) =>
      typeof value === "string" && value.startsWith("/memory/")
        ? value
        : null;

    expect(
      hasSuccessfulMemoryWrite({
        messages,
        completedToolResults,
        writeToolNames: new Set(["Write", "MultiEdit"]),
        resolveMemoryPath,
      }),
    ).toBe(true);

    expect(
      hasSuccessfulMemoryWrite({
        messages,
        completedToolResults: completedToolResults.slice(0, 2),
        writeToolNames: new Set(["Write", "MultiEdit"]),
        resolveMemoryPath,
      }),
    ).toBe(false);
  });

  it("classifies main-agent and disabled contexts", () => {
    expect(
      isMainMemoryExtractionContext({
        depth: 0,
        sessionSource: "cli_main",
      } as never),
    ).toBe(true);
    expect(
      isMainMemoryExtractionContext({
        depth: 1,
        sessionSource: "cli_main",
      } as never),
    ).toBe(false);
    expect(
      isMainMemoryExtractionContext({
        depth: 0,
        sessionSource: { kind: "subagent" },
      } as never),
    ).toBe(false);
    expect(
      isMemoryExtractionDisabledByEnv({
        AGENC_DISABLE_EXTRACT_MEMORIES: "1",
      }),
    ).toBe(true);
  });

  it("defers two eligible turns by default before the third runs", () => {
    const state = createMemoryExtractionTriggerState();
    expect(DEFAULT_MIN_ELIGIBLE_TURNS).toBe(3);
    const outcomes = [0, 1, 2].map(
      () =>
        shouldDeferForEligibleTurnCadence({
          state,
          minEligibleTurns: undefined,
          isTrailingRun: false,
        }).defer,
    );
    expect(outcomes).toEqual([true, true, false]);
    expect(state.turnsSinceLastExtraction).toBe(0);
  });

  it("applies eligible-turn cadence but never defers trailing runs", () => {
    const state = createMemoryExtractionTriggerState();
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 2,
        isTrailingRun: false,
      }).defer,
    ).toBe(true);
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 2,
        isTrailingRun: false,
      }).defer,
    ).toBe(false);
    expect(state.turnsSinceLastExtraction).toBe(0);
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 99,
        isTrailingRun: true,
      }).defer,
    ).toBe(false);
  });

  it("gives a lane no head start for being new to this process", () => {
    // An earlier version let the first decision in a process read the
    // unprocessed backlog, so a restart would not wait a further cadence. A
    // single turn with tool calls and attachments produces more messages than
    // any threshold that heuristic could use, so it fired on the first turn of
    // every new session and ran a full-history child there. The cadence is
    // turn-based only; a fresh lane waits like any other.
    const fresh = createMemoryExtractionTriggerState();
    const decisions = [1, 2, 3].map(() =>
      shouldDeferForEligibleTurnCadence({
        state: fresh,
        minEligibleTurns: undefined,
        isTrailingRun: false,
      }),
    );
    expect(decisions.map((decision) => decision.defer)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("reports the waiting count it actually used", () => {
    // The warning used to print the counter after the call, which is 0 on the
    // turn a run is allowed; it now prints what the decision was made on.
    const state = createMemoryExtractionTriggerState();
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: undefined,
        isTrailingRun: false,
      }),
    ).toEqual({ defer: true, waiting: 1 });
  });

  it("parses invalid tool arguments as an empty object", () => {
    expect(parseMemoryToolArguments("{nope")).toEqual({});
    expect(parseMemoryToolArguments(JSON.stringify(["not", "object"]))).toEqual({});
  });
});
