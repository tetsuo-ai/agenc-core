import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderHttpClient } from "../src/llm/client.js";
import {
  prepareAgenCTurnContext,
  runAgenCManualCompact,
} from "../src/agenc/adapters/runtime-session.js";
import { buildInitialTurnState } from "../src/session/turn-state.js";
import {
  mkCtx,
  mkProvider,
  mkSession,
} from "./fixtures.js";
import type { LLMMessage } from "../src/llm/types.js";

const originalEnv = {
  AGENC_DISABLE_AUTO_COMPACT: process.env.AGENC_DISABLE_AUTO_COMPACT,
};

afterEach(() => {
  if (originalEnv.AGENC_DISABLE_AUTO_COMPACT === undefined) {
    delete process.env.AGENC_DISABLE_AUTO_COMPACT;
  } else {
    process.env.AGENC_DISABLE_AUTO_COMPACT = originalEnv.AGENC_DISABLE_AUTO_COMPACT;
  }
});

function longToolExchange(id: number): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: `calling Read ${id}`,
      toolCalls: [{ id: `toolu_${id}`, name: "Read", arguments: "{}" }],
    },
    {
      role: "tool",
      toolCallId: `toolu_${id}`,
      toolName: "Read",
      content: `tool ${id}: ${"x".repeat(7_000)}`,
    },
  ];
}

describe("runtime session compact contract", () => {
  test("manual compact writes replacement history and clears provider continuation", async () => {
    const client = new ProviderHttpClient({
      providerName: "contract-provider",
      baseURL: "http://example.test",
    });
    const clearSpy = vi.spyOn(client, "clearResponsesResponseId");
    const provider = mkProvider(
      { content: "summary from compact provider" },
      { client },
    );
    const { session, state } = mkSession({
      provider,
      history: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second request" },
        { role: "assistant", content: "second answer" },
        { role: "user", content: "third request" },
      ],
    });

    const result = await runAgenCManualCompact({
      session,
      ctx: mkCtx(),
      customInstructions: "Preserve test decisions",
    });

    expect(result.displayText).toBe("Conversation compacted");
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(state.history.map((message) => message.content).join("\n")).toContain(
      "summary from compact provider",
    );
    expect(state.history[0]?.content).toContain("<compact>");
    expect(
      state.history.some((message) =>
        String(message.content).includes("<command-name>/compact</command-name>") &&
        String(message.content).includes("Preserve test decisions"),
      ),
    ).toBe(true);
  });

  test("preflight microcompact compresses older compactable tool results while preserving recent ones", async () => {
    process.env.AGENC_DISABLE_AUTO_COMPACT = "1";
    const history = Array.from({ length: 7 }, (_, index) => longToolExchange(index))
      .flat();
    const { session } = mkSession({ history });
    const ctx = mkCtx();
    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      { priorMessages: history },
    );

    await prepareAgenCTurnContext(state, ctx, session);

    const toolMessages = state.messagesForQuery.filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(7);
    expect(toolMessages[0]?.content).toContain(
      "Older tool output compressed",
    );
    expect(String(toolMessages.at(-1)?.content).length).toBeGreaterThan(6_000);
  });

  test("compact worktree does not edit durable memory implementation files", () => {
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "--",
        "runtime/src/prompts/memory",
        "runtime/src/commands/memory.ts",
      ],
      { encoding: "utf8" },
    ).trim();

    expect(diff).toBe("");
  });
});
