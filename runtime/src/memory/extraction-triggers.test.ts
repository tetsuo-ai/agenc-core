import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../llm/types.js";
import type { CompletedToolResultRecord } from "../session/turn-state.js";
import {
  createMemoryExtractionTriggerState,
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

  it("applies eligible-turn cadence but never defers trailing runs", () => {
    const state = createMemoryExtractionTriggerState();
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 2,
        isTrailingRun: false,
      }),
    ).toBe(true);
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 2,
        isTrailingRun: false,
      }),
    ).toBe(false);
    expect(state.turnsSinceLastExtraction).toBe(0);
    expect(
      shouldDeferForEligibleTurnCadence({
        state,
        minEligibleTurns: 99,
        isTrailingRun: true,
      }),
    ).toBe(false);
  });

  it("parses invalid tool arguments as an empty object", () => {
    expect(parseMemoryToolArguments("{nope")).toEqual({});
    expect(parseMemoryToolArguments(JSON.stringify(["not", "object"]))).toEqual({});
  });
});
