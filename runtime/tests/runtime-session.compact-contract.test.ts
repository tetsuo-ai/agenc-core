import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderHttpClient } from "../src/llm/client.js";
import { compactCommand, contextCommand } from "../src/commands/session-compact.js";
import { runContextCollapseOverflowRecovery } from "../src/phases/post-sample-recovery.js";
import { runTurn } from "../src/session/run-turn.js";
import { buildInitialTurnState } from "../src/session/turn-state.js";
import {
  drain,
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

function commandContext(session: unknown, argsRaw = "") {
  return {
    session,
    argsRaw,
    cwd: "/tmp/project",
    home: "/tmp",
    agencHome: "/tmp/.agenc",
  } as never;
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

    const result = await compactCommand.execute(
      commandContext(session, "Preserve test decisions"),
    );

    expect(result).toMatchObject({ kind: "compact", text: "Conversation compacted" });
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
    const seen: LLMMessage[][] = [];
    const provider = mkProvider(
      { content: "ok" },
      { onChatStream: (messages) => seen.push(messages) },
    );
    const { session } = mkSession({ provider, history });

    await drain(runTurn(session, mkCtx(), "continue"));

    const toolMessages = (seen[0] ?? []).filter(
      (message) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(7);
    expect(toolMessages[0]?.content).toContain(
      "Older tool output compressed",
    );
    expect(String(toolMessages.at(-1)?.content).length).toBeGreaterThan(6_000);
  });

  test("context usage and overflow recovery load compact runtime directly", async () => {
    const history: LLMMessage[] = [
      { role: "user", content: "first request" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second request" },
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third request" },
    ];
    const { session } = mkSession({ history });
    const ctx = mkCtx();
    const usage = await contextCommand.execute(commandContext(session));
    expect(usage).toMatchObject({ kind: "text" });
    if (usage.kind === "text") {
      expect(usage.text).toContain("/ 1,024 tokens");
    }

    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      { priorMessages: history },
    );
    state.messagesForQuery = state.messages.map((message) => ({ ...message }));

    const recovered = await runContextCollapseOverflowRecovery({
      state,
    });

    expect(recovered).toEqual({ kind: "applied", reason: "context_collapse" });
    expect(state.messagesForQuery[0]?.content).toContain("<compact>");
    expect(state.messagesForQuery.at(-1)?.content).toBe("continue");
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
