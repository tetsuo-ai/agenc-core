/**
 * Tests for the AgenC review delegate (`session/agenc-delegate.ts`)
 * and the `ReviewManager.runReview` orchestrator wired on top of it.
 *
 * Proves the T13 delegate contract:
 *   - `runAgenCReviewOneShot` happy-path returns a structured outcome
 *     with verdict classification, raw text, and emits
 *     `exit_review_mode` with `reason === "completed"`.
 *   - The registered task has `kind === "review"` and is NOT steerable
 *     (leverages `isTaskKindSteerable("review") === false` from
 *     `review.ts`).
 *   - `runReview` orchestrator enforces a timeout: when the provider
 *     delay exceeds `timeoutMs`, the outcome verdict is `"timeout"` and
 *     `exit_review_mode` fires with `reason === "timeout"`.
 *   - Requesting a reviewer model with an empty slug raises a typed
 *     `ReviewerModelMismatchError` up-front (before any provider
 *     round-trip).
 *   - Concurrent abort via `session.abortAllTasks()` while the review
 *     is in-flight produces verdict `"aborted"` and emits
 *     `exit_review_mode` with `reason === "aborted"`.
 *   - `buildGuardianReviewSessionConfig` rewrites the model + reasoning
 *     effort and preserves the parent config's non-reviewer fields.
 *   - Item 6 non-steerable enforcement: `steerInput` against a running
 *     review returns `active_turn_not_steerable`.
 *
 * Uses the same `buildSession` fixture pattern as `tasks.test.ts` /
 * `review.test.ts` so SessionServices wiring stays consistent across
 * session-kernel suites.
 */

import { describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import {
  Session,
  type Event,
  type EventMsg,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import {
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type SessionConfiguration,
} from "./turn-context.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../llm/types.js";
import {
  ReviewManager,
  type ReviewRequest,
  spawnReviewTask,
} from "./review.js";
import {
  ReviewerModelMismatchError,
  buildGuardianReviewSessionConfig,
  runAgenCReviewOneShot,
  spawnAgenCDelegateThread,
  type AgenCReviewOneShotRequest,
  type ExitReviewModePayload,
} from "./agenc-delegate.js";
import { newDefaultTurnWithSubId } from "./turn-context.js";
import { SandboxExecutionBroker } from "../sandbox/execution-broker.js";
import * as providerFactory from "../llm/provider.js";

// ─────────────────────────────────────────────────────────────────────
// Fixtures (mirrors tasks.test.ts::buildSession and review.test.ts)
// ─────────────────────────────────────────────────────────────────────

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
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

function mkModelInfo(slug = "test-model"): ModelInfo {
  return {
    slug,
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
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
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

/** Minimal scripted provider. `chat` resolves after `delayMs` with the
 *  scripted `content` unless the abort signal fires first. */
interface ScriptedProviderOptions {
  readonly content?: string;
  readonly delayMs?: number;
  readonly onChat?: (messages: LLMMessage[], options?: LLMChatOptions) => void;
  readonly throwError?: Error;
}

function mkScriptedProvider(opts: ScriptedProviderOptions = {}): LLMProvider {
  const chat = async (
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> => {
    opts.onChat?.(messages, options);
    if (opts.throwError) throw opts.throwError;
    const signal = options?.signal;
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        if (signal !== undefined) {
          const abortHandler = () => {
            clearTimeout(timer);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) {
            clearTimeout(timer);
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          } else {
            signal.addEventListener("abort", abortHandler, { once: true });
          }
        }
      });
    }
    return {
      content: opts.content ?? "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: options?.model ?? "test-model",
      finishReason: "stop",
    };
  };
  return {
    name: "scripted-provider",
    chat,
    chatStream: async (messages, onChunk, options) => {
      const response = await chat(messages, options);
      if (response.content.length > 0) {
        onChunk({ content: response.content });
      }
      return response;
    },
    healthCheck: async () => true,
  } as unknown as LLMProvider;
}

function mkSession(
  provider: LLMProvider,
  serviceOverrides?: Partial<SessionServices>,
): Session {
  const services = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    ...serviceOverrides,
  } as unknown as SessionServices;
  const sessionOpts: SessionOpts = {
    conversationId: "conv-delegate-test",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
    },
    features: mkFeatures(),
    services,
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  };
  return new Session(sessionOpts);
}

function mkReviewRequest(overrides?: Partial<ReviewRequest>): ReviewRequest {
  return {
    target: "Diff between HEAD and main",
    userFacingHint: "Focus on error-handling paths",
    ...overrides,
  };
}

function messageTextForTest(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("\n");
}

function mkOneShotRequest(
  session: Session,
  overrides?: Partial<AgenCReviewOneShotRequest>,
): AgenCReviewOneShotRequest {
  const parentContext = newDefaultTurnWithSubId(session, "parent-ctx");
  return {
    subId: "review-delegate-A",
    config: mkConfig(),
    parentContext,
    input: [{ role: "user", content: "Please review the diff." }],
    request: mkReviewRequest(),
    ...overrides,
  };
}

/** Capture `exit_review_mode` payloads from the session event queue. */
function observeExitReviewMode(session: Session): Promise<ExitReviewModePayload> {
  return new Promise((resolve) => {
    const unsubscribe = session.eventLog.subscribe((ev) => {
      if ((ev.msg as EventMsg).type === "exit_review_mode") {
        unsubscribe();
        resolve(
          (ev.msg as { type: "exit_review_mode"; payload: ExitReviewModePayload })
            .payload,
        );
      }
    });
  });
}

type DelegateProviderScenario = "success" | "error" | "abort";

async function exerciseDelegateProviderOwnership(
  scenario: DelegateProviderScenario,
): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runAgenCReviewOneShot>>;
  readonly forkForSession: ReturnType<typeof vi.fn>;
  readonly childDispose: ReturnType<typeof vi.fn>;
  readonly parentDispose: ReturnType<typeof vi.fn>;
  readonly parentPrewarmClear: ReturnType<typeof vi.fn>;
  readonly cleanupOrder: readonly string[];
  readonly childStartupPrewarm: unknown;
  readonly parentBroker: SandboxExecutionBroker;
}> {
  const cleanupOrder: string[] = [];
  let childStartupPrewarm: unknown;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const childDispose = vi.fn(async () => {
    cleanupOrder.push("provider_dispose");
  });
  const childProvider: LLMProvider = {
    ...mkScriptedProvider(),
    dispose: childDispose,
    chatStream: vi.fn(async (_messages, onChunk, options) => {
      resolveStarted?.();
      if (scenario === "error") throw new Error("delegate_child_failure");
      if (scenario === "abort") {
        await new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          const rejectAbort = () => reject(new Error("delegate_child_aborted"));
          if (signal?.aborted) rejectAbort();
          else signal?.addEventListener("abort", rejectAbort, { once: true });
        });
      }
      const content = JSON.stringify({
        findings: [],
        overall_correctness: "good",
        overall_explanation: "owned delegate response",
      });
      onChunk({ content, done: false });
      return {
        content,
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: options?.model ?? "test-model",
        finishReason: "stop",
      };
    }),
  };
  const parentDispose = vi.fn(async () => {});
  const forkForSession = vi.fn(() => childProvider);
  const parentProvider: LLMProvider = {
    ...mkScriptedProvider(),
    dispose: parentDispose,
    forkForSession,
  };
  const parentBroker = new SandboxExecutionBroker({
    mode: "danger_full_access",
    cwd: "/tmp",
  });
  const parentPrewarmClear = vi.fn(async () => {});
  const session = mkSession(parentProvider, {
    sandboxExecutionBroker: parentBroker,
    startupPrewarm: {
      setProviderHandle: vi.fn(),
      setProviderTask: vi.fn(),
      consumeProviderHandle: vi.fn(async () => undefined),
      expireProviderHandle: vi.fn(async () => {}),
      clear: parentPrewarmClear,
    },
  });
  const callerAbort = new AbortController();
  const originalShutdown = Session.prototype.shutdown;
  const shutdownSpy = vi
    .spyOn(Session.prototype, "shutdown")
    .mockImplementation(async function (this: Session): Promise<void> {
      if (this !== session) {
        childStartupPrewarm = this.services.startupPrewarm;
        cleanupOrder.push("child_shutdown");
      }
      await originalShutdown.call(this);
    });

  try {
    const run = runAgenCReviewOneShot(session, {
      ...mkOneShotRequest(session),
      signal: callerAbort.signal,
    });
    if (scenario === "abort") {
      await started;
      callerAbort.abort("delegate_ownership_test_abort");
    }
    const outcome = await run;
    return {
      outcome,
      forkForSession,
      childDispose,
      parentDispose,
      parentPrewarmClear,
      cleanupOrder,
      childStartupPrewarm,
      parentBroker,
    };
  } finally {
    shutdownSpy.mockRestore();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Happy-path one-shot review
// ─────────────────────────────────────────────────────────────────────

describe("runAgenCReviewOneShot happy-path review", () => {
  it.each([
    ["success", "pass"],
    ["error", "fail"],
    ["abort", "aborted"],
  ] as const)(
    "owns a forked delegate provider through %s cleanup",
    async (scenario, expectedVerdict) => {
      const exercised = await exerciseDelegateProviderOwnership(scenario);

      expect(exercised.outcome.verdict).toBe(expectedVerdict);
      expect(exercised.forkForSession).toHaveBeenCalledOnce();
      const forkOptions = exercised.forkForSession.mock.calls[0]?.[0] as {
        readonly cwd: string;
        readonly sandboxExecutionBroker: SandboxExecutionBroker;
      };
      expect(forkOptions.cwd).toBe("/tmp");
      expect(forkOptions.sandboxExecutionBroker).not.toBe(
        exercised.parentBroker,
      );
      expect(forkOptions.sandboxExecutionBroker.cwd).toBe("/tmp");
      expect(exercised.childStartupPrewarm).toBeUndefined();
      expect(exercised.parentPrewarmClear).not.toHaveBeenCalled();
      expect(exercised.childDispose).toHaveBeenCalledOnce();
      expect(exercised.parentDispose).not.toHaveBeenCalled();
      expect(exercised.cleanupOrder).toEqual([
        "child_shutdown",
        "provider_dispose",
      ]);
    },
  );

  it("uses an inert child MCP manager and never refreshes the parent transport", async () => {
    const parentRefresh = vi.fn(async () => ({
      configuredServers: ["parent"],
      requiredServers: [],
    }));
    const parentMcpManager = {
      effectiveServers: async () => new Map(),
      toolPluginProvenance: async () => null,
      refreshFromConfig: parentRefresh,
      getTools: () => [{ name: "mcp.parent.query" }],
      getConnectedServers: () => ["parent"],
      isConnected: () => true,
    } as unknown as SessionServices["mcpManager"];
    const session = mkSession(mkScriptedProvider({ content: "ok" }), {
      mcpManager: parentMcpManager,
    });
    const req = mkOneShotRequest(session);
    const thread = spawnAgenCDelegateThread(
      session,
      req,
      req.parentContext.modelInfo.slug,
      req.parentContext.modelInfo,
      new AbortController(),
    );

    expect(thread.childSession.services.mcpManager).not.toBe(parentMcpManager);
    expect(thread.childSession.services.mcpManager.getTools?.()).toEqual([]);
    expect(thread.childSession.services.registry.tools).toEqual([]);
    await thread.childSession.services.mcpManager.refreshFromConfig?.({
      servers: ["child"],
    });
    expect(parentRefresh).not.toHaveBeenCalled();

    await thread.shutdown("test complete");
  });

  it("returns a structured outcome + emits exit_review_mode with reason=completed", async () => {
    const provider = mkScriptedProvider({
      content: JSON.stringify({
        findings: [],
        overall_correctness: "good",
        overall_explanation: "No issues found.",
        overall_confidence_score: 0.95,
      }),
    });
    const session = mkSession(provider);
    const exitPromise = observeExitReviewMode(session);
    const req = mkOneShotRequest(session);

    const outcome = await runAgenCReviewOneShot(session, req);

    expect(outcome.verdict).toBe("pass");
    expect(outcome.output.overallExplanation).toBe("No issues found.");
    expect(outcome.output.overallConfidenceScore).toBe(0.95);
    expect(outcome.rawText).toContain("No issues found.");
    expect(outcome.error).toBeNull();

    const payload = await exitPromise;
    expect(payload.subId).toBe("review-delegate-A");
    expect(payload.reason).toBe("completed");
    expect(payload.request.target).toBe("Diff between HEAD and main");
  });

  it("registers the task with kind === 'review' in the session active turn", async () => {
    let observedKind: string | null = null;
    const provider = mkScriptedProvider({
      content: "reviewer text",
      onChat: () => {
        const active = session.activeTurn.unsafePeek();
        observedKind = active?.tasks.get("review-delegate-A")?.kind ?? null;
      },
    });
    const session = mkSession(provider);
    const req = mkOneShotRequest(session);
    await runAgenCReviewOneShot(session, req);
    expect(observedKind).toBe("review");
  });

  it("classifies verdict=fail when findings are present", async () => {
    const provider = mkScriptedProvider({
      content: JSON.stringify({
        findings: [
          {
            title: "bug",
            body: "bad",
            confidence_score: 0.8,
            priority: 1,
            code_location: {
              absolute_path: "/x",
              line_range: { start: 1, end: 2 },
            },
          },
        ],
        overall_explanation: "issue found",
      }),
    });
    const session = mkSession(provider);
    const outcome = await runAgenCReviewOneShot(session, mkOneShotRequest(session));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.output.findings.length).toBe(1);
  });

  it("classifies verdict=partial when assistant text is empty", async () => {
    const provider = mkScriptedProvider({ content: "" });
    const session = mkSession(provider);
    const outcome = await runAgenCReviewOneShot(session, mkOneShotRequest(session));
    expect(outcome.verdict).toBe("partial");
  });

  it("drains the task from the active turn registry on completion", async () => {
    const provider = mkScriptedProvider({ content: "ok" });
    const session = mkSession(provider);
    await runAgenCReviewOneShot(session, mkOneShotRequest(session));
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("sends the review system prompt once through the provider system field", async () => {
    let observedSystemPrompt: string | undefined;
    const provider = mkScriptedProvider({
      content: "reviewer text",
      onChat: (messages, options) => {
        expect(messages.some((message) => message.role === "system")).toBe(false);
        observedSystemPrompt = options?.systemPrompt;
      },
    });
    const session = mkSession(provider);
    await runAgenCReviewOneShot(session, mkOneShotRequest(session));
    expect(observedSystemPrompt).toContain("# Review guidelines:");
    expect(observedSystemPrompt?.match(/# Review guidelines:/g)).toHaveLength(1);
  });

  it("passes the reviewer model, no-tool envelope, and reasoning effort to the provider", async () => {
    let observedOptions: LLMChatOptions | undefined;
    const provider = mkScriptedProvider({
      content: "reviewer text",
      onChat: (_messages, options) => {
        observedOptions = options;
      },
    });
    const session = mkSession(provider);

    await runAgenCReviewOneShot(session, {
      ...mkOneShotRequest(session),
      reviewerModel: "reviewer-5",
      reviewerModelInfo: {
        ...mkModelInfo("reviewer-5"),
        defaultReasoningLevel: "high",
      },
    });

    expect(observedOptions?.model).toBe("reviewer-5");
    expect(observedOptions?.reasoningEffort).toBe("high");
    expect(observedOptions?.tools).toEqual([]);
    expect(observedOptions?.toolRouting?.allowedToolNames).toEqual([]);
    expect(observedOptions?.toolChoice).toBe("none");
  });

  it("preserves factory extras while adding the child sandbox broker", async () => {
    const schema = {
      type: "object",
      properties: { overall_explanation: { type: "string" } },
    };
    const recreatedProvider = mkScriptedProvider({
      content: JSON.stringify({
        findings: [],
        overall_explanation: "factory child",
      }),
    });
    const createProviderSpy = vi
      .spyOn(providerFactory, "createProvider")
      .mockReturnValue(recreatedProvider);
    const parentProvider = mkScriptedProvider();
    Object.defineProperty(
      parentProvider,
      providerFactory.FACTORY_PROVIDER_MARKER,
      {
        value: true,
      },
    );
    Object.defineProperty(
      parentProvider,
      providerFactory.FACTORY_PROVIDER_STATE,
      {
        value: {
          provider: "openai-compatible",
          options: {
            model: "parent-model",
            extra: {
              defaultHeaders: { "x-parent-extra": "preserved" },
              parallelToolCalls: true,
            },
          },
        },
      },
    );
    const parentBroker = new SandboxExecutionBroker({
      mode: "danger_full_access",
      cwd: "/tmp",
    });
    const session = mkSession(parentProvider, {
      sandboxExecutionBroker: parentBroker,
    });

    try {
      await runAgenCReviewOneShot(session, {
        ...mkOneShotRequest(session),
        reviewerModel: "reviewer-5",
        finalOutputJsonSchema: schema,
      });

      expect(createProviderSpy).toHaveBeenCalledOnce();
      const [providerName, options] = createProviderSpy.mock.calls[0]!;
      expect(providerName).toBe("openai-compatible");
      expect(options).toMatchObject({
        model: "reviewer-5",
        tools: [],
        extra: {
          defaultHeaders: { "x-parent-extra": "preserved" },
          parallelToolCalls: true,
          structuredOutput: schema,
        },
      });
      const childBroker = options.extra?.sandboxExecutionBroker as
        SandboxExecutionBroker | undefined;
      expect(childBroker).toBeDefined();
      expect(childBroker).not.toBe(parentBroker);
      expect(childBroker?.cwd).toBe("/tmp");
    } finally {
      createProviderSpy.mockRestore();
    }
  });

  it("runs through the child Session streaming path instead of direct provider.chat", async () => {
    let chatCalls = 0;
    let streamCalls = 0;
    const provider = mkScriptedProvider({
      content: "streamed review",
    });
    const wrapped: LLMProvider = {
      ...provider,
      chat: async (...args) => {
        chatCalls += 1;
        return provider.chat(...args);
      },
      chatStream: async (messages, onChunk, options) => {
        streamCalls += 1;
        return provider.chatStream(messages, onChunk, options);
      },
    };
    const session = mkSession(wrapped);

    const outcome = await runAgenCReviewOneShot(
      session,
      mkOneShotRequest(session),
    );

    expect(outcome.rawText).toBe("streamed review");
    expect(streamCalls).toBe(1);
    expect(chatCalls).toBe(0);
  });

  it("does not leak child lifecycle events into the parent transcript", async () => {
    const session = mkSession(mkScriptedProvider({ content: "ok" }));
    const parentEvents: string[] = [];
    session.eventLog.subscribe((event) => parentEvents.push(event.msg.type));

    await runAgenCReviewOneShot(session, mkOneShotRequest(session));

    expect(parentEvents).toContain("exit_review_mode");
    expect(parentEvents).not.toContain("turn_started");
    expect(parentEvents).not.toContain("user_message");
    expect(parentEvents).not.toContain("agent_message");
  });

  it("resolves reviewer aliases through the session ModelsManager before calling the provider", async () => {
    let observedOptions: LLMChatOptions | undefined;
    const provider = mkScriptedProvider({
      content: "reviewer text",
      onChat: (_messages, options) => {
        observedOptions = options;
      },
    });
    const getModelInfo = vi.fn().mockResolvedValue({
      ...mkModelInfo("resolved-reviewer"),
      defaultReasoningLevel: "low",
    });
    const session = mkSession(provider, {
      modelsManager: {
        getModelInfo,
        tryListModels: () => undefined,
        listModels: async () => [],
      },
    } as unknown as Partial<SessionServices>);
    const req = mkOneShotRequest(session, { reviewerModel: "reviewer-alias" });

    const outcome = await runAgenCReviewOneShot(session, req);

    expect(getModelInfo).toHaveBeenCalledWith("reviewer-alias", req.config);
    expect(observedOptions?.model).toBe("resolved-reviewer");
    expect(observedOptions?.reasoningEffort).toBe("low");
    expect(outcome.modelUsed).toBe("resolved-reviewer");
  });

  it("forwards child approval and permission events to the parent event log", async () => {
    const session = mkSession(mkScriptedProvider({ content: "ok" }));
    const parentEvents: EventMsg[] = [];
    session.eventLog.subscribe((event) => parentEvents.push(event.msg));
    const req = mkOneShotRequest(session);
    const parentContext = req.parentContext;
    const thread = spawnAgenCDelegateThread(
      session,
      req,
      parentContext.modelInfo.slug,
      parentContext.modelInfo,
      new AbortController(),
    );

    thread.childSession.sendEvent("child-approval", {
      type: "exec_approval_request",
      payload: {
        callId: "call-1",
        command: "rm -rf /tmp/example",
      },
    });
    thread.childSession.sendEvent("child-approval", {
      type: "request_permissions",
      payload: {
        callId: "call-1",
        toolName: "system.exec_command",
        permissions: ["filesystem.write"],
      },
    });
    await thread.shutdown("test complete");

    expect(parentEvents.some((event) => event.type === "exec_approval_request"))
      .toBe(true);
    expect(parentEvents.some((event) => event.type === "request_permissions"))
      .toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Timeout path
// ─────────────────────────────────────────────────────────────────────

describe("runAgenCReviewOneShot + runReview timeout", () => {
  it("fires timeout when provider delay exceeds timeoutMs; verdict=timeout", async () => {
    const provider = mkScriptedProvider({
      content: "late response",
      delayMs: 200,
    });
    const session = mkSession(provider);
    const exitPromise = observeExitReviewMode(session);
    const outcome = await runAgenCReviewOneShot(session, {
      ...mkOneShotRequest(session),
      timeoutMs: 30,
    });
    expect(outcome.verdict).toBe("timeout");
    expect(outcome.error?.message).toBe("review timed out");
    const payload = await exitPromise;
    expect(payload.reason).toBe("timeout");
  });

  it("runReview orchestrator enforces the timeout end-to-end", async () => {
    const provider = mkScriptedProvider({
      content: "late",
      delayMs: 200,
    });
    const session = mkSession(provider);
    const manager = new ReviewManager();
    const exitPromise = observeExitReviewMode(session);
    const outcome = await manager.runReview(session, {
      ...mkOneShotRequest(session),
      subId: "review-run-A",
      timeoutMs: 30,
    });
    expect(outcome.verdict).toBe("timeout");
    const payload = await exitPromise;
    expect(payload.reason).toBe("timeout");
    expect(manager.has("review-run-A")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Reviewer-model mismatch
// ─────────────────────────────────────────────────────────────────────

describe("runAgenCReviewOneShot reviewer-model validation", () => {
  it("raises ReviewerModelMismatchError for an empty reviewer model slug", async () => {
    const provider = mkScriptedProvider({ content: "ok" });
    const session = mkSession(provider);
    // Build a parent context whose modelInfo.slug is also empty so
    // the fallback does not recover. Override the reviewerModel to
    // empty explicitly to trigger the check.
    const req = mkOneShotRequest(session, { reviewerModel: "" });
    await expect(runAgenCReviewOneShot(session, req)).rejects.toBeInstanceOf(
      ReviewerModelMismatchError,
    );
  });

  it("ReviewerModelMismatchError carries the reviewer model + provider name", async () => {
    const provider = mkScriptedProvider({ content: "ok" });
    const session = mkSession(provider);
    const req = mkOneShotRequest(session, { reviewerModel: "" });
    try {
      await runAgenCReviewOneShot(session, req);
      expect.fail("expected ReviewerModelMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewerModelMismatchError);
      const mismatch = err as ReviewerModelMismatchError;
      expect(mismatch.providerName).toBe("scripted-provider");
      expect(mismatch.reviewerModel).toBe("");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Abort path — session.abortAllTasks during an in-flight review
// ─────────────────────────────────────────────────────────────────────

describe("runAgenCReviewOneShot abort lifecycle", () => {
  it("session.abortAllTasks cancels a running review; verdict=aborted + exit_review_mode reason=aborted", async () => {
    const provider = mkScriptedProvider({
      content: "too late",
      delayMs: 500,
    });
    const session = mkSession(provider);
    const exitPromise = observeExitReviewMode(session);
    const oneShotPromise = runAgenCReviewOneShot(session, {
      ...mkOneShotRequest(session),
      subId: "review-abort-A",
    });
    // Give the task a tick to register before aborting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.abortAllTasks("interrupted");
    const outcome = await oneShotPromise;
    expect(outcome.verdict).toBe("aborted");
    const payload = await exitPromise;
    expect(payload.reason).toBe("aborted");
  });

  it("external AbortController passed via req.signal aborts the review", async () => {
    const provider = mkScriptedProvider({
      content: "too late",
      delayMs: 500,
    });
    const session = mkSession(provider);
    const controller = new AbortController();
    const exitPromise = observeExitReviewMode(session);
    const oneShotPromise = runAgenCReviewOneShot(session, {
      ...mkOneShotRequest(session),
      subId: "review-abort-B",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort("caller cancelled");
    const outcome = await oneShotPromise;
    expect(outcome.verdict).toBe("aborted");
    const payload = await exitPromise;
    expect(payload.reason).toBe("aborted");
  });
});

// ─────────────────────────────────────────────────────────────────────
// exit_review_mode event shape
// ─────────────────────────────────────────────────────────────────────

describe("exit_review_mode event payload", () => {
  it("carries subId, reason, reviewOutput, modelUsed, and request on completion", async () => {
    const provider = mkScriptedProvider({
      content: JSON.stringify({
        overall_explanation: "all good",
      }),
    });
    const session = mkSession(provider);
    const exitPromise = observeExitReviewMode(session);
    await runAgenCReviewOneShot(session, {
      ...mkOneShotRequest(session),
      reviewerModel: "reviewer-5",
    });
    const payload = await exitPromise;
    expect(payload.subId).toBe("review-delegate-A");
    expect(payload.reason).toBe("completed");
    expect(payload.reviewOutput.overallExplanation).toBe("all good");
    expect(payload.modelUsed).toBe("reviewer-5");
    expect(payload.request.target).toBe("Diff between HEAD and main");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Non-steerable enforcement (Item 6 gate)
// ─────────────────────────────────────────────────────────────────────

describe("review task non-steerable enforcement", () => {
  it("steerInput against a running review returns active_turn_not_steerable", async () => {
    const session = mkSession(mkScriptedProvider({ content: "ok" }));
    await spawnReviewTask(session, {
      subId: "review-steer-A",
      request: mkReviewRequest(),
    });
    const result = await session.steerInput("review-steer-A", [
      { role: "user", content: "try to steer" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.kind).toBe("active_turn_not_steerable");
    }
    await session.onTaskFinished("review-steer-A");
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildGuardianReviewSessionConfig
// ─────────────────────────────────────────────────────────────────────

describe("buildGuardianReviewSessionConfig", () => {
  it("rewrites model + reasoning effort, preserves other fields", () => {
    const parent = mkConfig();
    const reviewerCfg = buildGuardianReviewSessionConfig({
      parentConfig: parent,
      activeModel: "reviewer-5",
      reasoningEffort: "high",
    });
    expect(reviewerCfg.model).toBe("reviewer-5");
    expect(reviewerCfg.modelReasoningEffort).toBe("high");
    expect(reviewerCfg.cwd).toBe(parent.cwd);
    expect(reviewerCfg.permissions.allowLoginShell).toBe(false);
  });

  it("returns a frozen object (cannot be mutated)", () => {
    const parent = mkConfig();
    const reviewerCfg = buildGuardianReviewSessionConfig({
      parentConfig: parent,
      activeModel: "reviewer-5",
    });
    expect(Object.isFrozen(reviewerCfg)).toBe(true);
  });

  it("preserves features reference so callable members work", () => {
    const parent = mkConfig();
    const reviewerCfg = buildGuardianReviewSessionConfig({
      parentConfig: parent,
      activeModel: "reviewer-5",
    });
    expect(typeof reviewerCfg.features.appsEnabledForAuth).toBe("function");
    expect(reviewerCfg.features.appsEnabledForAuth(false)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// runReview orchestrator + registry bookkeeping
// ─────────────────────────────────────────────────────────────────────

describe("ReviewManager.runReview orchestrator", () => {
  it("registers the review in the manager for the duration of the call", async () => {
    let observed: boolean | null = null;
    const provider = mkScriptedProvider({
      content: "ok",
      onChat: () => {
        observed = manager.has("review-run-reg");
      },
    });
    const session = mkSession(provider);
    const manager = new ReviewManager();
    await manager.runReview(session, {
      ...mkOneShotRequest(session),
      subId: "review-run-reg",
    });
    expect(observed).toBe(true);
    // Manager should drain on completion.
    expect(manager.has("review-run-reg")).toBe(false);
  });

  it("runReview emits exit_review_mode on happy path with reason=completed", async () => {
    const provider = mkScriptedProvider({
      content: "reviewer output",
    });
    const session = mkSession(provider);
    const telemetry: EventMsg[] = [];
    session.eventLog.subscribe((event) => telemetry.push(event.msg));
    const manager = new ReviewManager();
    const exitPromise = observeExitReviewMode(session);
    const outcome = await manager.runReview(session, {
      ...mkOneShotRequest(session),
      subId: "review-run-happy",
    });
    expect(outcome.verdict).toBe("pass");
    const payload = await exitPromise;
    expect(payload.reason).toBe("completed");
    const started = telemetry.find(
      (event): event is Extract<EventMsg, { type: "review_delegate_started" }> =>
        event.type === "review_delegate_started",
    );
    const completed = telemetry.find(
      (event): event is Extract<EventMsg, { type: "review_delegate_completed" }> =>
        event.type === "review_delegate_completed",
    );
    expect(started?.payload).toMatchObject({
      subId: "review-run-happy",
      target: "Diff between HEAD and main",
      snapshot_reused: false,
      priorFindingCount: 0,
    });
    expect(completed?.payload).toMatchObject({
      subId: "review-run-happy",
      target: "Diff between HEAD and main",
      snapshot_reused: false,
      priorFindingCount: 0,
      newFindingCount: 0,
      verdict: "pass",
      reason: "completed",
    });
    expect(completed?.payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reuses the previous child review snapshot as initial history on matching reviews", async () => {
    let calls = 0;
    const observedMessages: LLMMessage[][] = [];
    const firstReview = JSON.stringify({
      findings: [
        {
          title: "first issue",
          body: "first review snapshot",
          confidence_score: 0.8,
          priority: 1,
          code_location: {
            absolute_path: "/tmp/example.ts",
            line_range: { start: 1, end: 1 },
          },
        },
      ],
      overall_explanation: "first review snapshot",
    });
    const scripted: LLMProvider = {
      ...mkScriptedProvider(),
      chat: async (messages, options) => {
        calls += 1;
        observedMessages.push(messages);
        return {
          content: calls === 1 ? firstReview : "second review",
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: options?.model ?? "test-model",
          finishReason: "stop",
        };
      },
      chatStream: async (messages, onChunk, options) => {
        calls += 1;
        observedMessages.push(messages);
        const content = calls === 1 ? firstReview : "second review";
        onChunk({ content, done: false });
        return {
          content,
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: options?.model ?? "test-model",
          finishReason: "stop",
        };
      },
    };
    const session = mkSession(scripted);
    const telemetry: EventMsg[] = [];
    session.eventLog.subscribe((event) => telemetry.push(event.msg));
    const manager = new ReviewManager();
    const req = {
      ...mkOneShotRequest(session),
      subId: "review-snapshot",
      reuseKey: "same-review",
    } satisfies AgenCReviewOneShotRequest;

    await manager.runReview(session, req);
    await manager.runReview(session, {
      ...req,
      subId: "review-snapshot-2",
    });

    const secondMessages = observedMessages[1] ?? [];
    expect(secondMessages.some((message) => messageTextForTest(message).includes("first review snapshot")))
      .toBe(true);
    expect(secondMessages.some((message) => messageTextForTest(message).includes("previous review snapshot")))
      .toBe(true);

    const started = telemetry.filter(
      (event): event is Extract<EventMsg, { type: "review_delegate_started" }> =>
        event.type === "review_delegate_started",
    );
    const completed = telemetry.filter(
      (event): event is Extract<EventMsg, { type: "review_delegate_completed" }> =>
        event.type === "review_delegate_completed",
    );
    expect(started).toHaveLength(2);
    expect(completed).toHaveLength(2);
    expect(started[0]?.payload).toMatchObject({
      subId: "review-snapshot",
      reuseKey: "same-review",
      snapshot_reused: false,
      priorFindingCount: 0,
    });
    expect(completed[0]?.payload).toMatchObject({
      subId: "review-snapshot",
      reuseKey: "same-review",
      snapshot_reused: false,
      priorFindingCount: 0,
      newFindingCount: 1,
      verdict: "fail",
      reason: "completed",
    });
    expect(started[1]?.payload).toMatchObject({
      subId: "review-snapshot-2",
      reuseKey: "same-review",
      snapshot_reused: true,
      priorFindingCount: 1,
    });
    expect(completed[1]?.payload).toMatchObject({
      subId: "review-snapshot-2",
      reuseKey: "same-review",
      snapshot_reused: true,
      priorFindingCount: 1,
      newFindingCount: 0,
      verdict: "pass",
      reason: "completed",
    });
  });

  it("runReview propagates caller signal abort → verdict=aborted", async () => {
    const provider = mkScriptedProvider({
      content: "too late",
      delayMs: 500,
    });
    const session = mkSession(provider);
    const manager = new ReviewManager();
    const controller = new AbortController();
    const exitPromise = observeExitReviewMode(session);
    const pending = manager.runReview(session, {
      ...mkOneShotRequest(session),
      subId: "review-run-abort",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort("user interrupt");
    const outcome = await pending;
    expect(outcome.verdict).toBe("aborted");
    const payload = await exitPromise;
    expect(payload.reason).toBe("aborted");
    expect(manager.has("review-run-abort")).toBe(false);
  });

  it("runReview releases the registry entry even when the delegate throws synchronously", async () => {
    // An empty reviewer model triggers ReviewerModelMismatchError in
    // runAgenCReviewOneShot before spawnTask is called. runReview should still
    // release the manager registry entry via its finally-clause.
    const session = mkSession(mkScriptedProvider({ content: "ok" }));
    const manager = new ReviewManager();
    await expect(
      manager.runReview(session, {
        ...mkOneShotRequest(session),
        subId: "review-run-throw",
        reviewerModel: "",
      }),
    ).rejects.toBeInstanceOf(ReviewerModelMismatchError);
    expect(manager.has("review-run-throw")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Provider error surfaces as verdict=fail
// ─────────────────────────────────────────────────────────────────────

describe("runAgenCReviewOneShot provider error handling", () => {
  it("classifies provider throw as verdict=fail and carries the error in outcome.error", async () => {
    const boom = new Error("provider boom");
    const provider = mkScriptedProvider({ throwError: boom });
    const session = mkSession(provider);
    const exitPromise = observeExitReviewMode(session);
    const outcome = await runAgenCReviewOneShot(session, mkOneShotRequest(session));
    expect(outcome.verdict).toBe("fail");
    expect(outcome.error).toBe(boom);
    const payload = await exitPromise;
    // Provider throwing isn't "aborted" or "timeout"; the delegate
    // emits exit_review_mode with reason="completed" because a
    // reviewer-task *ended*, just unsuccessfully. If in the future
    // we expand the reason taxonomy, revise this assertion.
    expect(payload.reason).toBe("completed");
  });
});
