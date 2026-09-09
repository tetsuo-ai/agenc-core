import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LLMMessage } from "../../../src/llm/types.js";
import { findToolTurnValidationIssue } from "../../../src/llm/tool-turn-validator.js";
import { memoryExtractionVisibleRange } from "../../../src/memory/extraction-triggers.js";
import { readMemoryExtractionState } from "../../../src/session/memory-extraction-state.js";
import {
  executeExtractMemories,
  initExtractMemories,
  type ExtractMemoriesChildRequest,
} from "../../../src/services/extractMemories/extractMemories.js";
import { mkCtx, mkSession } from "../../fixtures.js";

function conversationWithParallelTools(visibleCount: number): LLMMessage[] {
  return Array.from({ length: visibleCount }, (_, index): LLMMessage[] => {
    if (index % 12 !== 11) {
      return [{ role: index % 2 === 0 ? "user" : "assistant", content: `visible ${index}` }];
    }
    const calls = Array.from({ length: index === 11 ? 2 : 3 }, (_, parallel) => ({
      id: `read-${index}-${parallel}`,
      name: "FileRead",
      arguments: JSON.stringify({ file_path: `/project/file-${parallel}.ts` }),
    }));
    return [{ role: "assistant", content: `Inspecting files at ${index}`, toolCalls: calls },
      ...calls.toReversed().map((call): LLMMessage => ({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: `Observed contents for ${call.id}`,
      })),
    ];
  }).flat();
}

describe("memory extraction tool history", () => {
  let root = "";
  let memoryDir = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-memory-tool-history-"));
    memoryDir = join(root, "memory");
    await mkdir(memoryDir);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("retains complete parallel results at the twelfth visible-message boundary", () => {
    const messages = conversationWithParallelTools(26);
    expect(findToolTurnValidationIssue(messages)).toBeNull();
    const range = memoryExtractionVisibleRange(messages, 0, 12);
    expect(findToolTurnValidationIssue(range.unprocessedMessages)).toBeNull();
    expect(range.unprocessedMessages).toEqual(messages.slice(0, 14));
    expect(range.currentVisibleCount).toBe(26);
    expect(range.unprocessedVisibleCount).toBe(12);
  });

  test("resumes legacy visible-message cursors without orphaning or replaying results", () => {
    const messages = conversationWithParallelTools(26);
    const range = memoryExtractionVisibleRange(messages, 12, 12);
    expect(findToolTurnValidationIssue(range.unprocessedMessages)).toBeNull();
    expect(range.unprocessedMessages).toEqual(messages.slice(14, 29));
    expect(range.unprocessedVisibleCount).toBe(12);
    const compacted = memoryExtractionVisibleRange(messages.slice(14), 99, 12);
    expect(findToolTurnValidationIssue(compacted.unprocessedMessages)).toBeNull();
    expect(compacted.unprocessedMessages).toEqual(messages.slice(14, 29));
    expect(compacted.currentVisibleCount).toBe(14);
  });

  test("batches and persisted cursor survive lane reinitialization without losing tool outcomes", async () => {
    const { session } = mkSession();
    const messages = conversationWithParallelTools(26);
    const runChild = vi.fn(async (request: ExtractMemoriesChildRequest) => {
      expect(findToolTurnValidationIssue(request.messages)).toBeNull();
      return { outcome: "completed" as const };
    });
    const dependencies = {
      env: {}, minEligibleTurns: 1, runChild,
      resolveMemoryDirectory: async () => ({ enabled: true as const, path: memoryDir }),
    };
    const context = { session, messages, completedToolResults: [], ctx: mkCtx({ cwd: root }) };
    for (const cursor of [12, 24, 26]) {
      initExtractMemories(dependencies);
      await executeExtractMemories(context);
      expect((await readMemoryExtractionState(session, memoryDir))?.processedVisibleCount).toBe(cursor);
    }
    expect(runChild.mock.calls.map(([request]) => request.messages.length)).toEqual([14, 15, 2]);
    expect(runChild.mock.calls.flatMap(([request]) => request.messages)).toEqual(messages);
    await executeExtractMemories(context);
    expect(runChild).toHaveBeenCalledTimes(3);
  });

  test("retries then drops the same complete failed batch without consuming the next exchange", async () => {
    const { session } = mkSession();
    const messages = conversationWithParallelTools(26);
    const runChild = vi.fn(async (request: ExtractMemoriesChildRequest) => {
      expect(findToolTurnValidationIssue(request.messages)).toBeNull();
      return { outcome: "errored" as const, error: new Error("temporary child failure") };
    });
    initExtractMemories({
      env: {}, minEligibleTurns: 1, runChild,
      resolveMemoryDirectory: async () => ({ enabled: true, path: memoryDir }),
    });
    const context = { session, messages, completedToolResults: [], ctx: mkCtx({ cwd: root }) };
    await executeExtractMemories(context);
    expect((await readMemoryExtractionState(session, memoryDir))?.processedVisibleCount).toBe(0);
    await executeExtractMemories(context);
    expect((await readMemoryExtractionState(session, memoryDir))?.processedVisibleCount).toBe(12);
    await executeExtractMemories(context);
    expect(runChild.mock.calls.map(([request]) => request.messages)).toEqual([
      messages.slice(0, 14), messages.slice(0, 14), messages.slice(14, 29),
    ]);
  });
});
