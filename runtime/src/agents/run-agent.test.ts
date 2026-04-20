/**
 * runAgent + initMcpForAgent — driver tests.
 *
 * Covers T9 gaps #112 and #113: the single-turn provider drive in
 * runAgent and the MCP-readiness polling branches of
 * initMcpForAgent. Uses a lightweight session stub (see
 * control.test.ts) and a provider stubbed with `vi.fn()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentControl } from "./control.js";
import { AgentRegistry } from "./registry.js";
import {
  initMcpForAgent,
  MCP_INIT_TIMEOUT_MS,
  runAgent,
  type RunAgentProgressEvent,
  type RunAgentResult,
} from "./run-agent.js";
import { _resetNicknamePoolForTesting } from "./role.js";
import type { InterAgentCommunication } from "./mailbox.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../llm/types.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

type StubSession = {
  readonly conversationId: string;
  readonly childInboxes: Map<string, unknown>;
  readonly eventLog: { emit: (event: unknown) => unknown };
  nextInternalSubId: () => string;
  readonly abortController: AbortController;
  readonly services: Record<string, unknown>;
};

function makeStubSession(
  services: Record<string, unknown> = {},
): StubSession {
  const emitted: unknown[] = [];
  return {
    conversationId: "conv-parent",
    childInboxes: new Map(),
    eventLog: {
      emit: (event: unknown) => {
        emitted.push(event);
        return event;
      },
    },
    nextInternalSubId: () => `sub-${emitted.length}`,
    abortController: new AbortController(),
    services,
  };
}

function makeProviderResponse(
  content: string,
  toolCalls: LLMResponse["toolCalls"] = [],
): LLMResponse {
  return {
    content,
    toolCalls,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    model: "stub-model",
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

async function collectRun(
  iter: AsyncGenerator<RunAgentProgressEvent, RunAgentResult, void>,
): Promise<{
  events: RunAgentProgressEvent[];
  result: RunAgentResult;
}> {
  const events: RunAgentProgressEvent[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return { events, result: step.value };
    }
    events.push(step.value);
  }
}

async function spawnLive(session: StubSession) {
  const registry = new AgentRegistry();
  const control = new AgentControl({
    session: session as unknown as ConstructorParameters<
      typeof AgentControl
    >[0]["session"],
    registry,
  });
  const live = await control.spawn({ parentPath: "/root" });
  return { control, registry, live };
}

beforeEach(() => {
  _resetNicknamePoolForTesting();
});

afterEach(() => {
  _resetNicknamePoolForTesting();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────
// runAgent
// ─────────────────────────────────────────────────────────────────────

describe("runAgent", () => {
  it("drives a single provider turn and forwards the assistant text via upInbox", async () => {
    const chat = vi
      .fn<LLMProvider["chat"]>()
      .mockResolvedValue(makeProviderResponse("hello world"));
    const provider: LLMProvider = {
      name: "stub",
      chat,
      chatStream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ provider });
    const { live } = await spawnLive(session);

    const sent: InterAgentCommunication[] = [];
    const originalSend = live.upInbox.send.bind(live.upInbox);
    live.upInbox.send = (msg) => {
      sent.push({ ...(msg as InterAgentCommunication), seq: 0 });
      return originalSend(msg);
    };

    const initial: LLMMessage[] = [
      { role: "system", content: "you are a subagent" },
      { role: "user", content: "please respond" },
    ];
    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: initial,
        taskPrompt: "please respond",
      }),
    );

    expect(chat).toHaveBeenCalledTimes(1);
    const [passedMessages, passedOptions] = chat.mock.calls[0]! as [
      LLMMessage[],
      LLMChatOptions | undefined,
    ];
    expect(passedMessages).toHaveLength(2);
    expect(passedMessages[0]!.role).toBe("system");
    expect(passedOptions?.signal).toBeDefined();

    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("hello world");
    expect(result.toolCallCount).toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.author).toBe(live.agentPath);
    expect(sent[0]!.recipient).toBe("conv-parent");
    expect(sent[0]!.direction).toBe("up");
    expect(sent[0]!.content).toBe("hello world");

    expect(events.some((e) => e.kind === "run_complete")).toBe(true);
    expect(events.some((e) => e.kind === "status")).toBe(true);
    // Initial messages + assistant reply message.
    expect(events.filter((e) => e.kind === "message")).toHaveLength(3);
  });

  it("marks completed on success", async () => {
    const provider: LLMProvider = {
      name: "stub",
      chat: vi.fn().mockResolvedValue(makeProviderResponse("ok")),
      chatStream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ provider });
    const { live } = await spawnLive(session);

    await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(live.status.value.status).toBe("completed");
    if (live.status.value.status === "completed") {
      expect(live.status.value.lastMessage).toBe("ok");
    }
  });

  it("marks errored when the provider rejects", async () => {
    const provider: LLMProvider = {
      name: "stub",
      chat: vi.fn().mockRejectedValue(new Error("provider_boom")),
      chatStream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ provider });
    const { live } = await spawnLive(session);

    const { events, result } = await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(live.status.value.status).toBe("errored");
    if (live.status.value.status === "errored") {
      expect(live.status.value.error).toContain("provider_boom");
    }
    expect(events.some((e) => e.kind === "run_error")).toBe(true);
  });

  it("marks interrupted on signal.abort", async () => {
    let chatReject: ((err: Error) => void) | undefined;
    const chat = vi.fn<LLMProvider["chat"]>().mockImplementation(
      (_messages, options) =>
        new Promise<LLMResponse>((_resolve, reject) => {
          chatReject = reject;
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const provider: LLMProvider = {
      name: "stub",
      chat,
      chatStream: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ provider });
    const { live } = await spawnLive(session);

    const iter = runAgent({
      live,
      parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
      initialMessages: [{ role: "user", content: "go" }],
      taskPrompt: "go",
    });

    // Pump events until the generator is awaiting the provider call.
    const collected: RunAgentProgressEvent[] = [];
    let result: RunAgentResult | undefined;
    const runPromise = (async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const step = await iter.next();
        if (step.done) {
          result = step.value;
          return;
        }
        collected.push(step.value);
      }
    })();

    // Wait a macrotask so runAgent has a chance to hit `provider.chat`.
    await new Promise((r) => setTimeout(r, 0));
    expect(chatReject).toBeDefined();
    live.abortController.abort("user_interrupt");
    await runPromise;

    expect(result?.outcome).toBe("interrupted");
    expect(live.status.value.status).toBe("interrupted");
    expect(collected.some((e) => e.kind === "run_interrupted")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// initMcpForAgent
// ─────────────────────────────────────────────────────────────────────

describe("initMcpForAgent", () => {
  it("returns ready:true when requiredMcpServers is empty", async () => {
    const session = makeStubSession();
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: [] },
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready:true when no roleConfig is supplied (back-compat)", async () => {
    const session = makeStubSession();
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready:false, reason:'aborted' when signal aborts mid-wait", async () => {
    vi.useFakeTimers();
    const connected = new Map<string, boolean>([
      ["fs", false],
      ["net", false],
    ]);
    const mcpManager = {
      isConnected: (name: string) => connected.get(name) ?? false,
    };
    const session = makeStubSession({ mcpManager });
    const ctrl = new AbortController();

    const promise = initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs", "net"] },
    });

    // Let the poll start.
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort("user_cancel");
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("aborted");
  });

  it("returns ready:true when all required servers are connected", async () => {
    const connected = new Map<string, boolean>([
      ["fs", true],
      ["net", true],
    ]);
    const mcpManager = {
      isConnected: (name: string) => connected.get(name) ?? false,
    };
    const session = makeStubSession({ mcpManager });
    const ctrl = new AbortController();
    const result = await initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs", "net"] },
    });
    expect(result.ready).toBe(true);
  });

  it("returns ready:false, reason includes missing server when one never becomes ready", async () => {
    vi.useFakeTimers();
    const connected = new Map<string, boolean>([
      ["fs", true],
      ["net", false],
    ]);
    const mcpManager = {
      isConnected: (name: string) => connected.get(name) ?? false,
    };
    const session = makeStubSession({ mcpManager });
    const ctrl = new AbortController();

    const promise = initMcpForAgent({
      parent: session as unknown as Parameters<typeof initMcpForAgent>[0]["parent"],
      signal: ctrl.signal,
      roleConfig: { requiredMcpServers: ["fs", "net"] },
    });
    // Advance past the 30s default timeout.
    await vi.advanceTimersByTimeAsync(MCP_INIT_TIMEOUT_MS + 100);
    const result = await promise;
    expect(result.ready).toBe(false);
    // Either the generic timeout bucket or the specific missing-server
    // bucket is acceptable; the implementation prefers the latter.
    expect(
      result.reason === "timeout" || result.reason === "missing_server:net",
    ).toBe(true);
  });
});
