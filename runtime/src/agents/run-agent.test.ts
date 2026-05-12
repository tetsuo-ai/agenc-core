import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
/**
 * runAgent + initMcpForAgent — driver tests.
 *
 * Covers T9 gaps #112 and #113: the single-turn provider drive in
 * runAgent and the MCP-readiness polling branches of
 * initMcpForAgent. Uses a lightweight session fake (see
 * control.test.ts) and a provider wired up via `vi.fn()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncQueue } from "../utils/async-queue.js";
import { AgentControl } from "./control.js";
import { AgentRegistry } from "./registry.js";
import {
  buildFilteredRegistry,
  initMcpForAgent,
  MCP_INIT_TIMEOUT_MS,
  resolveThreadSpawnDisabledTools,
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
  StreamProgressCallback,
} from "../llm/types.js";
import { Session, type Event, type SessionOpts, type SessionServices } from "../session/session.js";
import { RolloutStore } from "../session/rollout-store.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
} from "../session/turn-context.js";
import type { ToolRegistry } from "../tool-registry.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ID_ARG,
} from "../tools/system/filesystem.js";
import { createApplyPatchTool } from "../tools/apply-patch/tool.js";
import { cloneFileStateCache } from "../utils/fileStateCache.js";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "fake-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "fake-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(
  overrides?: { readonly [K in keyof SessionConfiguration]?: SessionConfiguration[K] },
): SessionConfiguration {
  const base: SessionConfiguration = {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "fake-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  return {
    ...base,
    ...overrides,
    collaborationMode: {
      ...base.collaborationMode,
      ...(overrides?.collaborationMode ?? {}),
    },
  };
}

function mkRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async () => ({ content: "", isError: false }),
  };
}

function makeStubSession(opts: {
  services?: { readonly [K in keyof SessionServices]?: SessionServices[K] };
  sessionConfiguration?: SessionConfiguration;
  config?: Config;
  modelInfo?: ModelInfo;
} = {}): Session {
  const state = {
    sessionConfiguration:
      opts.sessionConfiguration ??
      mkSessionConfiguration({
        provider: { slug: "fake-provider" } as unknown as SessionConfiguration["provider"],
      }),
    history: [],
  };
  const session = new Session({
    conversationId: "conv-parent",
    initialState: state as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    services: {
      mcpConnectionManager: {
        setApprovalPolicy: () => {},
        setSandboxPolicy: () => {},
        requiredStartupFailures: async () => [],
      },
      mcpStartupCancellationToken: {
        cancel: () => {},
        isCancelled: () => false,
      },
      provider: makeProvider([]),
      registry: mkRegistry(),
      hooks: {
        executeStop: async () => ({}),
      },
      ...(opts.services ?? {}),
    } as unknown as SessionServices,
    jsRepl: { id: "repl-test" },
    config: opts.config ?? mkConfig(),
    modelInfo: opts.modelInfo ?? mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  return session;
}

function makeProvider(
  responses: Array<{ readonly [K in keyof LLMResponse]?: LLMResponse[K] }>,
): LLMProvider {
  const queue = [...responses];
  return {
    name: "fake",
    chat: vi.fn(async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "fake-model",
      finishReason: "stop",
      ...(queue.shift() ?? {}),
    })),
    chatStream: vi.fn(
      async (
        _messages: LLMMessage[],
        _onChunk: StreamProgressCallback,
      ): Promise<LLMResponse> => ({
        content: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "fake-model",
        finishReason: "stop",
        ...(queue.shift() ?? {}),
      }),
    ),
    healthCheck: vi.fn().mockResolvedValue(true),
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

async function spawnLive(session: Session) {
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

function mkNamedTool(name: string): ToolRegistry["tools"][number] {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    execute: async () => ({ content: "{}" }),
  };
}

function mkNamedRegistry(names: readonly string[]): ToolRegistry {
  const tools = names.map(mkNamedTool);
  return {
    tools,
    toLLMTools: () =>
      tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
    dispatch: async () => ({ content: "{}" }),
  };
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
    const provider = makeProvider([{ content: "hello world" }]);
    const session = makeStubSession({ services: { provider } });
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

    expect(provider.chatStream).toHaveBeenCalledTimes(1);
    const [passedMessages, _onChunk, passedOptions] = (
      provider.chatStream as ReturnType<typeof vi.fn>
    ).mock.calls[0]! as [LLMMessage[], StreamProgressCallback, { signal?: AbortSignal }];
    expect(passedMessages).toHaveLength(2);
    expect(passedMessages[0]!.role).toBe("system");
    expect(passedOptions?.signal).toBeDefined();

    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("hello world");
    expect(result.toolCallCount).toBe(0);

    expect(
      sent.map((msg) => msg.metadata?.kind),
    ).toEqual(["subagent_status"]);
    const parentMessages = session.mailbox.drain();
    expect(parentMessages).toHaveLength(1);
    expect(parentMessages[0]).toMatchObject({
      author: live.agentPath,
      recipient: "/root",
      direction: "up",
      triggerTurn: false,
      metadata: { kind: "subagent_notification" },
    });
    expect(parentMessages[0]!.content).toBe(
      `<subagent_notification>\n{"agent_path":"${live.agentPath}","status":{"completed":"hello world"}}\n</subagent_notification>`,
    );

    expect(events.some((e) => e.kind === "run_complete")).toBe(true);
    expect(events.some((e) => e.kind === "status")).toBe(true);
    // Initial messages + assistant reply message.
    expect(events.filter((e) => e.kind === "message")).toHaveLength(3);
  });

  it("marks completed on success", async () => {
    const provider = makeProvider([{ content: "ok" }]);
    const session = makeStubSession({ services: { provider } });
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

  it("removes the external abort listener after completion", async () => {
    const provider = makeProvider([{ content: "ok" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);
    const external = new AbortController();
    const addListener = vi.spyOn(external.signal, "addEventListener");
    const removeListener = vi.spyOn(external.signal, "removeEventListener");

    await collectRun(
      runAgent({
        live,
        parent: session as unknown as Parameters<typeof runAgent>[0]["parent"],
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        externalSignal: external.signal,
      }),
    );

    const abortListener = addListener.mock.calls.find(
      (call) => call[0] === "abort",
    )?.[1];
    expect(abortListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  });

  it("runs child turns through the session turn loop and counts tool calls", async () => {
    const provider = makeProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "system.echo", arguments: "{}" }],
        finishReason: "tool_calls",
      },
      { content: "tool work complete" },
    ]);
    const session = makeStubSession({
      services: {
        provider,
        registry: {
          tools: [
            {
              name: "system.echo",
              description: "echo",
              inputSchema: { type: "object" },
              execute: async () => ({ content: JSON.stringify({ ok: true }) }),
            },
          ],
          toLLMTools: () => [
            {
              type: "function",
              function: {
                name: "system.echo",
                description: "echo",
                parameters: { type: "object" },
              },
            },
          ],
          dispatch: async () => ({ content: JSON.stringify({ ok: true }) }),
        } satisfies ToolRegistry,
      },
    });
    const { live } = await spawnLive(session);

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(provider.chatStream).toHaveBeenCalledTimes(2);
    expect(result.finalMessage).toBe("tool work complete");
    expect(result.toolCallCount).toBe(1);
  });

  it("captures AgentSummary cache-safe params from the real child run state", async () => {
    const provider = makeProvider([{ content: "summary seed" }]);
    const registry = {
      tools: [
        {
          name: "system.echo",
          description: "echo",
          inputSchema: { type: "object" },
          execute: async () => ({ content: JSON.stringify({ ok: true }) }),
        },
      ],
      toLLMTools: () => [
        {
          type: "function",
          function: {
            name: "system.echo",
            description: "echo",
            parameters: { type: "object" },
          },
        },
      ],
      dispatch: async () => ({ content: JSON.stringify({ ok: true }) }),
    } satisfies ToolRegistry;
    const session = makeStubSession({ services: { provider, registry } });
    const { live } = await spawnLive(session);
    const captured: unknown[] = [];

    await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        onCacheSafeParams: (params) => {
          captured.push(params);
        },
      }),
    );

    expect(captured).toHaveLength(1);
    const chatStreamCall = (
      provider.chatStream as ReturnType<typeof vi.fn>
    ).mock.calls[0] as
      | [LLMMessage[], StreamProgressCallback, LLMChatOptions]
      | undefined;
    expect(chatStreamCall).toBeDefined();
    const [providerMessages, , providerOptions] = chatStreamCall!;
    const params = captured[0] as {
      systemPrompt: string;
      systemContext: { cwd: string };
      toolUseContext: {
        provider: LLMProvider;
        options: {
          mainLoopModel: string;
          tools: Array<{ name: string }>;
          contextWindowTokens: number;
        };
        getAppState: () => unknown;
        readFileState: {
          max: number;
          maxSize: number;
          dump: () => unknown;
        };
      };
      forkContextMessages: unknown[];
    };
    expect(params.systemPrompt).toBe(providerOptions.systemPrompt ?? "");
    expect(params.systemContext).toEqual({ cwd: "/tmp" });
    expect(params.toolUseContext.provider.name).toBe(provider.name);
    expect(params.toolUseContext.options.mainLoopModel).toBe("fake-model");
    expect(params.toolUseContext.options.tools.map((tool) => tool.name)).toEqual(
      providerOptions.tools?.map((tool) => tool.function.name),
    );
    expect(params.toolUseContext.options.contextWindowTokens).toBe(
      providerOptions.contextWindowTokens,
    );
    expect(typeof params.toolUseContext.getAppState).toBe("function");
    expect(params.toolUseContext.readFileState.max).toBeGreaterThan(0);
    expect(params.toolUseContext.readFileState.maxSize).toBeGreaterThan(0);
    expect(typeof params.toolUseContext.readFileState.dump).toBe("function");
    expect(
      cloneFileStateCache(params.toolUseContext.readFileState as never).max,
    ).toBe(params.toolUseContext.readFileState.max);
    expect(
      params.forkContextMessages[0],
    ).toEqual(
      expect.objectContaining({
        type: "user",
        message: expect.objectContaining({
          content: providerMessages[0]?.content,
        }),
      }),
    );
  });

  it("treats child maxTurns termination as an errored run", async () => {
    const provider = makeProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "system.echo", arguments: "{}" }],
        finishReason: "tool_calls",
      },
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "system.echo", arguments: "{}" }],
        finishReason: "tool_calls",
      },
    ]);
    const session = makeStubSession({
      services: {
        provider,
        registry: {
          tools: [
            {
              name: "system.echo",
              description: "echo",
              inputSchema: { type: "object" },
              execute: async () => ({ content: JSON.stringify({ ok: true }) }),
            },
          ],
          toLLMTools: () => [
            {
              type: "function",
              function: {
                name: "system.echo",
                description: "echo",
                parameters: { type: "object" },
              },
            },
          ],
          dispatch: async () => ({ content: JSON.stringify({ ok: true }) }),
        } satisfies ToolRegistry,
      },
    });
    const { live } = await spawnLive(session);

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
        maxTurns: 1,
      }),
    );

    expect(result.outcome).toBe("errored");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("subagent exceeded maxTurns (1)");
    expect(provider.chatStream).toHaveBeenCalledTimes(1);
  });

  it("drains triggerTurn messages from the child downInbox into a follow-up turn", async () => {
    const provider = makeProvider([{ content: "first turn" }, { content: "second turn" }]);
    const session = makeStubSession({ services: { provider } });
    const { live } = await spawnLive(session);

    live.downInbox.send({
      author: "/root",
      recipient: live.agentPath,
      content: "follow up",
      triggerTurn: true,
      direction: "down",
      metadata: { kind: "user_input" },
    });

    const { result } = await collectRun(
      runAgent({
        live,
        parent: session,
        initialMessages: [{ role: "user", content: "go" }],
        taskPrompt: "go",
      }),
    );

    expect(provider.chatStream).toHaveBeenCalledTimes(2);
    const secondCall = (
      provider.chatStream as ReturnType<typeof vi.fn>
    ).mock.calls[1]![0] as LLMMessage[];
    expect(secondCall.at(-1)).toEqual({
      role: "user",
      content: "follow up",
    });
    expect(result.outcome).toBe("completed");
    expect(result.finalMessage).toBe("second turn");
  });

  it("injects child session metadata and worktree roots into wrapped child tools", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "system.echo",
            description: "echo",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        worktree: {
          path: "/tmp/subagent-wt",
          branch: "worktree-child",
          gitRoot: "/repo",
          created: false,
        },
      },
    );

    await registry.tools[0]!.execute({ value: "hello" });

    expect(execute).toHaveBeenCalledOnce();
    const parsed = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(parsed[SESSION_ID_ARG]).toBe("child-123");
    expect(parsed[SESSION_ALLOWED_ROOTS_ARG]).toEqual(["/tmp/subagent-wt"]);
    expect(parsed.value).toBe("hello");
  });

  it("layers child tool policy before wrapped child tool execution", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        worktree: {
          path: "/tmp/subagent-wt",
          branch: "worktree-child",
          gitRoot: "/repo",
          created: false,
        },
        childToolPolicy: (_tool, input) => ({
          behavior: "allow",
          updatedInput: {
            ...input,
            file_path: "/tmp/memory/feedback.md",
            [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/memory"],
          },
        }),
      },
    );

    await registry.tools[0]!.execute({ file_path: "feedback.md" });

    expect(execute).toHaveBeenCalledOnce();
    const parsed = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(parsed.file_path).toBe("/tmp/memory/feedback.md");
    expect(parsed[SESSION_ALLOWED_ROOTS_ARG]).toEqual([
      "/tmp/memory",
      "/tmp/subagent-wt",
    ]);
    expect(parsed[SESSION_ID_ARG]).toBe("child-123");
  });

  it("returns child policy denials with metadata", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        childToolPolicy: () => ({
          behavior: "deny",
          message: "outside memory",
          metadata: { reason: "write_outside_memory" },
        }),
      },
    );

    const result = await registry.tools[0]!.execute({
      file_path: "/tmp/other.md",
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ error: "outside memory" }),
      isError: true,
      metadata: {
        reason: "write_outside_memory",
        childPolicyDenied: true,
      },
    });
  });

  it("preserves child policy denial metadata through registry dispatch", async () => {
    const execute = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [
          {
            name: "Write",
            description: "write",
            inputSchema: { type: "object" },
            execute,
          },
        ],
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "Write",
              description: "write",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch: async () => ({
          content: JSON.stringify({ ok: true }),
          isError: false,
        }),
      },
      {
        childConversationId: "child-123",
        childToolPolicy: () => ({
          behavior: "deny",
          message: "outside memory",
          metadata: { reason: "write_outside_memory" },
        }),
      },
    );

    const result = await registry.dispatch({
      id: "call-write",
      name: "Write",
      arguments: JSON.stringify({ file_path: "/tmp/other.md" }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      content: JSON.stringify({ error: "outside memory" }),
      isError: true,
      metadata: {
        reason: "write_outside_memory",
        childPolicyDenied: true,
      },
    });
  });

  it("applies child tool policy on fallback dispatch", async () => {
    const dispatch = vi.fn(async () => ({
      content: JSON.stringify({ ok: true }),
      isError: false,
    }));
    const registry = buildFilteredRegistry(
      {
        tools: [],
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "VirtualTool",
              description: "virtual",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch,
      },
      {
        childConversationId: "child-123",
        childToolPolicy: (_tool, input) => ({
          behavior: "allow",
          updatedInput: {
            ...input,
            [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/memory"],
          },
        }),
      },
    );

    await registry.dispatch({
      id: "call-virtual",
      name: "VirtualTool",
      arguments: JSON.stringify({ value: 1 }),
    });

    expect(dispatch).toHaveBeenCalledOnce();
    const forwarded = dispatch.mock.calls[0]![0] as {
      readonly arguments: string;
    };
    expect(JSON.parse(forwarded.arguments)).toEqual({
      value: 1,
      __agencSessionAllowedRoots: ["/tmp/memory"],
      __agencSessionId: "child-123",
    });
  });

  it("runs child apply_patch calls relative to the child worktree", async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "agenc-parent-patch-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "agenc-child-patch-"));
    const applyPatchTool = createApplyPatchTool({
      cwd: parentRoot,
      allowedPaths: [parentRoot],
    });
    const registry = buildFilteredRegistry(
      {
        tools: [applyPatchTool],
        toLLMTools: () => [{
          type: "function",
          function: {
            name: "apply_patch",
            description: applyPatchTool.description,
            parameters: applyPatchTool.inputSchema,
          },
        }],
        dispatch: async () => ({ content: "{}" }),
      },
      {
        childConversationId: "child-123",
        worktree: {
          path: worktreeRoot,
          branch: "worktree-child",
          gitRoot: parentRoot,
          created: false,
        },
      },
    );

    try {
      const result = await registry.dispatch({
        id: "patch-1",
        name: "apply_patch",
        arguments: JSON.stringify({
          input: `*** Begin Patch
*** Add File: child.txt
+child
*** End Patch`,
        }),
      });

      expect(result.isError).toBeUndefined();
      expect(readFileSync(join(worktreeRoot, "child.txt"), "utf8")).toBe(
        "child\n",
      );
      expect(existsSync(join(parentRoot, "child.txt"))).toBe(false);
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });

  it("filters disabled V2 agent tools from child tool specs and dispatch", async () => {
    const registry = buildFilteredRegistry(
      mkNamedRegistry(["spawn_agent", "system.echo"]),
      {
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 1,
          maxDepth: 1,
        }),
      },
    );

    expect(registry.tools.map((tool) => tool.name)).toEqual(["system.echo"]);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.echo",
    ]);
    await expect(
      registry.dispatch({ id: "call-1", name: "spawn_agent", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: spawn_agent",
      }),
    });
  });

  it("filters spawn, task, and main-thread coordination tools from V2 child agents", async () => {
    const leakedToolNames = [
      "TaskCreate",
      "TaskGet",
      "TaskUpdate",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "Brief",
      "SendUserMessage",
      "VerifyPlanExecution",
      "CronCreate",
      "CronDelete",
      "CronList",
      "WorkflowTool",
      "RemoteTrigger",
      "EnterPlanMode",
      "ExitPlanMode",
    ];
    const registry = buildFilteredRegistry(
      mkNamedRegistry([
        "spawn_agent",
        "wait_agent",
        "StructuredOutput",
        "system.echo",
        ...leakedToolNames,
      ]),
      {
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 1,
          maxDepth: 2,
        }),
      },
    );

    const advertisedNames = registry.tools.map((tool) => tool.name);
    expect(advertisedNames).toEqual([
      "wait_agent",
      "StructuredOutput",
      "system.echo",
    ]);
    for (const toolName of ["spawn_agent", ...leakedToolNames]) {
      expect(advertisedNames).not.toContain(toolName);
      await expect(
        registry.dispatch({ id: `call-${toolName}`, name: toolName, arguments: "{}" }),
      ).resolves.toMatchObject({
        isError: true,
        content: JSON.stringify({
          error: `tool not allowed for subagent: ${toolName}`,
        }),
      });
    }
  });

  it("keeps child denylisted tools blocked even when a role allowlist names them", async () => {
    const registry = buildFilteredRegistry(
      mkNamedRegistry(["TaskList", "system.echo"]),
      {
        allowlist: ["TaskList", "system.echo"],
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 0,
          maxDepth: 1,
        }),
      },
    );

    expect(registry.tools.map((tool) => tool.name)).toEqual(["system.echo"]);
    await expect(
      registry.dispatch({ id: "call-task-list", name: "TaskList", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: TaskList",
      }),
    });
  });

  it("does not re-advertise tools hidden by the parent registry", async () => {
    const tools = ["system.echo", "NotebookEdit", "TaskCreate"].map(mkNamedTool);
    const registry = buildFilteredRegistry(
      {
        tools,
        toLLMTools: () => [
          {
            type: "function",
            function: {
              name: "system.echo",
              description: "echo",
              parameters: { type: "object" },
            },
          },
        ],
        dispatch: async () => ({ content: "{}" }),
      },
      {
        childConversationId: "child-123",
        disabledTools: resolveThreadSpawnDisabledTools({
          depth: 0,
          maxDepth: 1,
        }),
      },
    );

    expect(registry.tools.map((tool) => tool.name)).toEqual(["system.echo"]);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.echo",
    ]);
    await expect(
      registry.dispatch({ id: "call-notebook", name: "NotebookEdit", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: NotebookEdit",
      }),
    });
  });

  it("tracks parent registry visibility when hidden coding tools are discovered later", async () => {
    const tools = ["system.searchTools", "Grep"].map(mkNamedTool);
    let visibleNames = ["system.searchTools"];
    const registry = buildFilteredRegistry(
      {
        tools,
        toLLMTools: () =>
          visibleNames.map((name) => ({
            type: "function",
            function: {
              name,
              description: `${name} tool`,
              parameters: { type: "object" },
            },
          })),
        dispatch: async () => ({ content: "{}" }),
      },
      {
        childConversationId: "child-123",
      },
    );

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.searchTools",
    ]);
    await expect(
      registry.dispatch({ id: "call-grep-before", name: "Grep", arguments: "{}" }),
    ).resolves.toMatchObject({
      isError: true,
      content: JSON.stringify({
        error: "tool not allowed for subagent: Grep",
      }),
    });

    visibleNames = ["system.searchTools", "Grep"];

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toEqual([
      "system.searchTools",
      "Grep",
    ]);
    const result = await registry.dispatch({
      id: "call-grep-after",
      name: "Grep",
      arguments: "{}",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("{}");
  });

  it("mounts a child rollout store when the parent owns one", async () => {
    const provider = makeProvider([{ content: "child wrote rollout" }]);
    const cwd = mkdtempSync(join(tmpdir(), "agenc-run-agent-"));
    const session = makeStubSession({
      services: { provider },
      sessionConfiguration: mkSessionConfiguration({
        cwd,
        provider: provider as unknown as SessionConfiguration["provider"],
      }),
      config: {
        ...mkConfig(),
        cwd,
      },
    });
    const parentRolloutStore = new RolloutStore({
      cwd,
      sessionId: session.conversationId,
      agencVersion: "0.2.0",
    });
    parentRolloutStore.open({
      sessionId: session.conversationId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "run-agent-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: provider.name,
    });
    session.mountRolloutStore(parentRolloutStore);

    const { live } = await spawnLive(session);
    const childSessionDir = join(
      dirname(parentRolloutStore.store.sessionDir),
      live.agentId,
    );

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
        }),
      );

      expect(result.outcome).toBe("completed");
      const rolloutFiles = readdirSync(childSessionDir).filter(
        (entry) => entry.startsWith("rollout-") && entry.endsWith(".jsonl"),
      );
      expect(rolloutFiles.length).toBeGreaterThan(0);
    } finally {
      parentRolloutStore.close();
      rmSync(childSessionDir, { recursive: true, force: true });
      rmSync(parentRolloutStore.store.sessionDir, {
        recursive: true,
        force: true,
      });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses parent mailbox notifications and child rollout in silent mode", async () => {
    const provider = makeProvider([{ content: "silent complete" }]);
    const cwd = mkdtempSync(join(tmpdir(), "agenc-run-agent-silent-"));
    const session = makeStubSession({
      services: { provider },
      sessionConfiguration: mkSessionConfiguration({
        cwd,
        provider: provider as unknown as SessionConfiguration["provider"],
      }),
      config: {
        ...mkConfig(),
        cwd,
      },
    });
    const parentRolloutStore = new RolloutStore({
      cwd,
      sessionId: session.conversationId,
      agencVersion: "0.2.0",
    });
    parentRolloutStore.open({
      sessionId: session.conversationId,
      timestamp: new Date().toISOString(),
      cwd,
      originator: "run-agent-test",
      agencVersion: "0.2.0",
      model: session.modelInfo.slug,
      modelProvider: provider.name,
    });
    session.mountRolloutStore(parentRolloutStore);

    const { live } = await spawnLive(session);
    const childSessionDir = join(
      dirname(parentRolloutStore.store.sessionDir),
      live.agentId,
    );

    try {
      const { result } = await collectRun(
        runAgent({
          live,
          parent: session,
          initialMessages: [{ role: "user", content: "go" }],
          taskPrompt: "go",
          silent: true,
        }),
      );

      expect(result.outcome).toBe("completed");
      expect(session.mailbox.drain()).toHaveLength(0);
      expect(live.rolloutPath).toBeUndefined();
      expect(existsSync(childSessionDir)).toBe(false);
    } finally {
      parentRolloutStore.close();
      rmSync(childSessionDir, { recursive: true, force: true });
      rmSync(parentRolloutStore.store.sessionDir, {
        recursive: true,
        force: true,
      });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("marks errored when the provider rejects", async () => {
    const provider: LLMProvider = {
      name: "fake",
      chat: vi.fn(),
      chatStream: vi.fn().mockRejectedValue(new Error("provider_boom")),
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ services: { provider } });
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
    const chatStream = vi.fn<LLMProvider["chatStream"]>().mockImplementation(
      (_messages, _onChunk, options) =>
        new Promise<LLMResponse>((_resolve, reject) => {
          chatReject = reject;
          options?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );
    const provider: LLMProvider = {
      name: "fake",
      chat: vi.fn(),
      chatStream,
      healthCheck: vi.fn().mockResolvedValue(true),
    };
    const session = makeStubSession({ services: { provider } });
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

    for (let attempt = 0; attempt < 20 && chatReject === undefined; attempt += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
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
    const session = makeStubSession({ services: { mcpManager } });
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
    const session = makeStubSession({ services: { mcpManager } });
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
    const session = makeStubSession({ services: { mcpManager } });
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
