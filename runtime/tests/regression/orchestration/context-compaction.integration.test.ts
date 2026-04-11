import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteBackend } from "../../../src/memory/sqlite/backend.js";
import { ChatExecutor } from "../../../src/llm/chat-executor.js";
import type { LLMMessage, LLMProvider, LLMResponse } from "../../../src/llm/types.js";
import {
  SessionManager,
  type SessionLookupParams,
} from "../../../src/gateway/session.js";
import {
  buildSessionStatefulOptions,
  hydrateWebSessionRuntimeState,
  persistWebSessionRuntimeState,
} from "../../../src/gateway/daemon-session-state.js";

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  const response: LLMResponse = {
    content: "ok",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
  };
  return {
    name,
    chat: vi.fn().mockResolvedValue(response),
    chatStream: vi.fn().mockResolvedValue(response),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function createLookupParams(): SessionLookupParams {
  return {
    channel: "webchat",
    senderId: "user-1",
    scope: "dm",
    workspaceId: "shell-ws",
  };
}

function createMessage(content: string) {
  return {
    id: "msg-1",
    channel: "webchat",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm" as const,
  };
}

describe("context compaction integration", () => {
  const backends: SqliteBackend[] = [];

  afterEach(async () => {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
  });

  it("preserves artifact-backed context across repeated compaction and resume", async () => {
    const tempDir = await mkdtemp(
      path.join(tmpdir(), "agenc-context-compaction-"),
    );
    const dbPath = path.join(tempDir, "context.sqlite");
    const backend = new SqliteBackend({ dbPath });
    backends.push(backend);

    const summarizer = vi
      .fn()
      .mockResolvedValue(
        "PLAN.md remains the canonical shell roadmap and parser tests are passing.",
      );
    const manager = new SessionManager(
      {
        scope: "per-channel-peer",
        reset: { mode: "never" },
        compaction: "summarize",
        maxHistoryLength: 50,
      },
      { summarizer },
    );
    const session = manager.getOrCreate(createLookupParams());

    const initialHistory: LLMMessage[] = [
      {
        role: "user",
        content:
          "Review PLAN.md and use it to implement the shell parser in src/main.c.",
      },
      {
        role: "assistant",
        content:
          "I will align src/main.c with PLAN.md and keep parser milestones correct.",
      },
      {
        role: "tool",
        toolName: "system.readFile",
        content:
          "PLAN.md defines parser, executor, and job control milestones for src/main.c.",
      },
      {
        role: "assistant",
        content: "Open loop: verify parser tests before touching job control.",
      },
      {
        role: "tool",
        toolName: "system.bash",
        content:
          "vitest run parser.test.ts passed after the quote-handling fix in src/main.c",
      },
      {
        role: "assistant",
        content: "Decision: keep parser work incremental and preserve PLAN.md accuracy.",
      },
    ];
    session.history.push(...initialHistory);
    const firstCompaction = await manager.compact(session.id);
    expect(firstCompaction?.artifactCount).toBeGreaterThan(0);

    session.history.push(
      {
        role: "user",
        content:
          "Re-review PLAN.md and parser.test.ts before finalizing AGENC.md for the shell repo.",
      },
      {
        role: "tool",
        toolName: "system.readFile",
        content:
          "AGENC.md should describe PLAN.md, parser.test.ts, and src/main.c without inventing files.",
      },
      {
        role: "assistant",
        content: "Remaining: verify PLAN.md and parser.test.ts stay aligned after compaction.",
      },
      {
        role: "tool",
        toolName: "system.bash",
        content:
          "vitest run parser.test.ts --run passed 8 assertions against src/main.c",
      },
      {
        role: "assistant",
        content:
          "Decision: summarize the repo around PLAN.md, parser.test.ts, and src/main.c only.",
      },
      {
        role: "user",
        content: "Resume later if needed.",
      },
    );
    const secondCompaction = await manager.compact(session.id);
    expect(secondCompaction?.artifactCount).toBeGreaterThan(0);

    await persistWebSessionRuntimeState(backend, "web-session-1", session);
    await backend.flush();

    manager.destroy(session.id);
    const resumed = manager.getOrCreate(createLookupParams());
    resumed.history = [...session.history];
    await hydrateWebSessionRuntimeState(backend, "web-session-1", resumed);

    const stateful = buildSessionStatefulOptions(resumed);
    expect(stateful?.artifactContext?.artifactRefs.length).toBeGreaterThan(0);
    expect(
      stateful?.artifactContext?.artifactRefs.some((artifact) =>
        artifact.title.includes("PLAN.md"),
      ),
    ).toBe(true);

    const provider = createMockProvider();
    const executor = new ChatExecutor({ providers: [provider] });
    await executor.execute({
      message: createMessage(
        "Update AGENC.md from the compacted shell context and keep it accurate.",
      ),
      history: resumed.history,
      systemPrompt: "You are a helpful assistant.",
      sessionId: "session-1",
      stateful,
      // After the regex pre-call classifier rip-out, implementation-class
      // detection on the message text alone now triggers a workflow-
      // implementation contract that fails-close on missing workspace.
      // Pass an explicit workspace root so the executor falls through to
      // the dialogue path the test was originally exercising.
      runtimeContext: { workspaceRoot: "/workspace" },
    });

    const messages = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | LLMMessage[]
      | undefined;
    const artifactContextMessage = messages?.find(
      (message) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes("Compacted artifact context:"),
    );
    expect(artifactContextMessage).toBeDefined();
    expect(String(artifactContextMessage?.content)).toContain("PLAN.md");
    expect(String(artifactContextMessage?.content)).toContain("parser.test.ts");
    expect(String(artifactContextMessage?.content).split("\n").length).toBeLessThan(
      resumed.history
        .map((message) => String(message.content).split("\n").length)
        .reduce((sum, count) => sum + count, 0),
    );
  });
});
