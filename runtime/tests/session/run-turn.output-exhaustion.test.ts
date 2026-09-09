import { describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { findToolTurnValidationIssue } from "../../src/llm/tool-turn-validator.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";

describe("output exhaustion cleanup", () => {
  test("aborts an in-flight read and closes queued writes before the failed terminal", async () => {
    const readStarted = Promise.withResolvers<void>();
    const readFinished = Promise.withResolvers<{ content: string; isError: boolean }>();
    let readAborted = false;
    const read = vi.fn(async (args: Record<string, unknown>) => {
      const signal = args.__abortSignal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        readAborted = true;
        readFinished.resolve({ content: "read aborted", isError: true });
      }, { once: true });
      readStarted.resolve();
      return await readFinished.promise;
    });
    const write = vi.fn(async () => ({ content: "must not write", isError: false }));
    const registry = {
      tools: [{
        name: "stream_read",
        description: "Read a file",
        inputSchema: { type: "object" },
        requiresApproval: false,
        concurrencyClass: { kind: "shared_read" },
        recoveryCategory: "read-only",
        isReadOnly: true,
        execute: read,
      }, {
        name: "stream_write",
        description: "Write a file",
        inputSchema: { type: "object" },
        requiresApproval: false,
        concurrencyClass: { kind: "exclusive" },
        execute: write,
      }],
      toLLMTools: () => [],
      dispatch: write,
    } as unknown as ToolRegistry;
    const provider = mkProvider();
    let samples = 0;
    provider.chatStream = async (_messages, onChunk) => {
      samples += 1;
      if (samples === 4) {
        onChunk({
          content: "working",
          done: false,
          toolCalls: [
            { id: "read-final", name: "stream_read", arguments: "{}" },
            { id: "write-final", name: "stream_write", arguments: "{}" },
          ],
        });
        await readStarted.promise;
      }
      return {
        content: "truncated output",
        toolCalls: [],
        usage: { promptTokens: 128, completionTokens: 32, totalTokens: 160 },
        model: "test-model",
        finishReason: "length",
      };
    };
    const { session, events } = mkSession({ provider, registry });
    const ctx = mkCtx();
    try {
      await drain(runTurn(session, {
        ...ctx,
        modelInfo: { ...ctx.modelInfo, maxOutputTokens: 32, maxOutputTokensExplicit: true },
      }, "finish the task"));

      expect(samples).toBe(4);
      expect(read).toHaveBeenCalledTimes(1);
      expect(readAborted).toBe(true);
      expect(write).not.toHaveBeenCalled();
      const terminalIndex = events.findIndex((event) => classifyTurnTerminal(event.msg)?.outcome === "errored");
      expect(terminalIndex).toBeGreaterThan(-1);
      for (const callId of ["read-final", "write-final"]) {
        const closures = events.flatMap((event, index) =>
          event.msg.type === "tool_call_completed" && event.msg.payload.callId === callId
            ? [index]
            : [],
        );
        expect(closures).toHaveLength(1);
        expect(closures[0]).toBeLessThan(terminalIndex);
      }
      expect(findToolTurnValidationIssue(session.snapshotHistoryMessages())).toBeNull();
    } finally {
      readFinished.resolve({ content: "test cleanup", isError: true });
    }
  });
});
