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
import type { LLMContentPart, LLMMessage } from "../src/llm/types.js";

const COMPACT_ENV_KEYS = [
  "AGENC_DISABLE_AUTO_COMPACT",
  "AGENC_USE_OPENAI",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW",
] as const;

const originalEnv: Partial<Record<(typeof COMPACT_ENV_KEYS)[number], string>> = {};
for (const key of COMPACT_ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

afterEach(() => {
  for (const key of COMPACT_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
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
      baseURL: "http://127.0.0.1:18080",
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

  test("manual compact preserves process env when provider override is absent", async () => {
    process.env.AGENC_USE_OPENAI = "1";
    process.env.OPENAI_MODEL = "env-model";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:18081";
    process.env.OPENAI_API_KEY = "env-key";
    process.env.AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW = "1234";
    let seenEnv: Partial<Record<(typeof COMPACT_ENV_KEYS)[number], string | undefined>> = {};
    const provider = mkProvider(
      { content: "env summary" },
      {
        onChat: () => {
          seenEnv = {
            AGENC_USE_OPENAI: process.env.AGENC_USE_OPENAI,
            OPENAI_MODEL: process.env.OPENAI_MODEL,
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW:
              process.env.AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW,
          };
        },
      },
    );
    const { session } = mkSession({
      provider,
      history: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second request" },
        { role: "assistant", content: "second answer" },
      ],
    });

    const result = await compactCommand.execute(commandContext(session));

    expect(result).toMatchObject({ kind: "compact" });
    expect(seenEnv).toEqual({
      AGENC_USE_OPENAI: "1",
      OPENAI_MODEL: "env-model",
      OPENAI_BASE_URL: "http://127.0.0.1:18081",
      OPENAI_API_KEY: "env-key",
      AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW: "1234",
    });
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

  test("overflow recovery passes through short histories", async () => {
    const ctx = mkCtx();
    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      { priorMessages: [{ role: "assistant", content: "short answer" }] },
    );
    state.messagesForQuery = state.messages.map((message) => ({ ...message }));
    const before = state.messagesForQuery.map((message) => ({ ...message }));

    const recovered = await runContextCollapseOverflowRecovery({ state });

    expect(recovered).toEqual({ kind: "pass" });
    expect(state.messagesForQuery).toEqual(before);
  });

  test("overflow recovery preserves multimodal and document tail content", async () => {
    const documentPart: LLMContentPart = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "ZmFrZS1wZGY=",
      },
      title: "notes.pdf",
      filename: "notes.pdf",
      fallbackText: "document fallback",
    };
    const imagePart: LLMContentPart = {
      type: "image_url",
      image_url: { url: "https://agenc.tech/image.png" },
    };
    const ctx = mkCtx();
    const state = buildInitialTurnState(
      ctx,
      { role: "user", content: "continue" },
      {
        priorMessages: [
          { role: "user", content: "first request" },
          { role: "assistant", content: "first answer" },
          {
            role: "user",
            content: [{ type: "text", text: "read this" }, documentPart],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "see this" }, imagePart],
          },
        ],
      },
    );
    state.messagesForQuery = state.messages.map((message) => ({ ...message }));

    const recovered = await runContextCollapseOverflowRecovery({ state });

    expect(recovered).toEqual({ kind: "applied", reason: "context_collapse" });
    const documentMessage = state.messagesForQuery.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "document"),
    );
    const imageMessage = state.messagesForQuery.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image_url"),
    );
    expect(documentMessage?.content).toContainEqual(documentPart);
    expect(imageMessage?.content).toContainEqual(imagePart);
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
