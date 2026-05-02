import { afterEach, describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import type { LLMChatOptions, LLMMessage, LLMProvider, LLMResponse } from "../llm/types.js";
import type { ApprovalCtx } from "../tools/orchestrator.js";
import type { ToolInvocation } from "../tools/context.js";
import {
  createGuardianRejectionCircuitBreaker,
  type GuardianRejectionCircuitBreaker,
} from "./guardian-rejection-circuit-breaker.js";
import {
  createDefaultGuardianApprovalReviewer,
  GUARDIAN_PREFERRED_MODEL,
  parseGuardianAssessment,
} from "./guardian-approval-review.js";
import { ReviewManager } from "./review.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import {
  newDefaultTurnWithSubId,
  type Config,
  type ManagedFeatures,
  type ModelInfo,
  type SessionConfiguration,
  type TurnContext,
} from "./turn-context.js";

afterEach(() => {
  vi.useRealTimers();
});

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    approvalsReviewer: "auto_review",
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
    approvalPolicy: { value: "on_request" },
    sandboxPolicy: { value: "workspace_write" },
    fileSystemSandboxPolicy: {
      allowWrite: ["/tmp"],
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
    approvalsReviewer: "auto_review",
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

interface ScriptedProviderOptions {
  readonly content?: string;
  readonly delayMs?: number;
  readonly onChat?: (messages: LLMMessage[], options?: LLMChatOptions) => void;
}

function mkProvider(opts: ScriptedProviderOptions = {}): LLMProvider {
  const chat = async (
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> => {
    opts.onChat?.(messages, options);
    const signal = options?.signal;
    if (opts.delayMs !== undefined && opts.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        const abort = () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted === true) {
          abort();
        } else {
          signal?.addEventListener("abort", abort, { once: true });
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
    name: "guardian-provider",
    chat,
    chatStream: chat as unknown as LLMProvider["chatStream"],
    healthCheck: async () => true,
  };
}

function mkSession(opts: {
  readonly provider: LLMProvider;
  readonly breaker?: GuardianRejectionCircuitBreaker;
  readonly models?: readonly ModelInfo[];
}): { session: Session; events: Event[]; breaker: GuardianRejectionCircuitBreaker } {
  const events: Event[] = [];
  const breaker = opts.breaker ?? createGuardianRejectionCircuitBreaker();
  const models = opts.models ?? [mkModelInfo()];
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
    provider: opts.provider,
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    hooks: {
      startupWarnings: () => [],
      executePreCompact: async () => ({}),
      executePostCompact: async () => ({}),
      executeStop: async () => ({}),
      executeStopFailure: async () => ({}),
    },
    guardianRejections: new Map(),
    guardianRejectionCircuitBreaker: breaker,
    reviewManager: new ReviewManager(),
    modelsManager: {
      tryListModels: () => models,
      listModels: async () => models,
      getModelInfo: async (slug: string) =>
        models.find((model) => model.slug === slug) ?? mkModelInfo(slug),
    },
  } as unknown as SessionServices;
  const session = new Session({
    conversationId: "conv-guardian-approval-test",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
      totalTokenUsage: 0,
    } as unknown as SessionOpts["initialState"],
    features: mkFeatures(),
    services,
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  });
  session.eventLog.subscribe((event) => {
    events.push(event);
  });
  return { session, events, breaker };
}

function mkApprovalCtx(session: Session, turn: TurnContext): ApprovalCtx {
  const invocation: ToolInvocation = {
    session,
    turn,
    tracker: {
      appendFileDiff: () => {},
      snapshot: () => [],
      clear: () => {},
    },
    callId: "call-guardian-1",
    toolName: { name: "Write" },
    payload: { kind: "function", arguments: "{\"path\":\"file.txt\"}" },
    source: "direct",
  };
  return {
    invocation,
    callId: invocation.callId,
    toolName: "Write",
    turnId: turn.subId,
    retryReason: "tool requires approval",
  };
}

describe("parseGuardianAssessment", () => {
  it("accepts strict JSON and wrapped JSON with defaults", () => {
    expect(parseGuardianAssessment('{"outcome":"allow"}')).toEqual({
      riskLevel: "low",
      userAuthorization: "unknown",
      outcome: "allow",
      rationale: "Auto-review returned a low-risk allow decision.",
    });
    expect(
      parseGuardianAssessment(
        'review result:\n{"outcome":"deny","rationale":"unsafe"}',
      ).riskLevel,
    ).toBe("high");
  });
});

describe("guardian approval reviewer", () => {
  it("approval records a guardian non-denial", async () => {
    const { session, events, breaker } = mkSession({
      provider: mkProvider({ content: '{"outcome":"allow"}' }),
    });
    const turn = newDefaultTurnWithSubId(session, "turn-allow");
    const reviewer = createDefaultGuardianApprovalReviewer({ timeoutMs: 5_000 });

    const result = await reviewer.reviewApprovalRequest({
      ctx: mkApprovalCtx(session, turn),
      args: { path: "file.txt", content: "ok" },
    });

    expect(result.decision.kind).toBe("approved");
    expect(result.countedDenial).toBe(false);
    expect(breaker.peek("turn-allow")).toMatchObject({
      consecutiveDenials: 0,
      totalDenials: 0,
    });
    expect(
      events.some(
        (event) =>
          event.msg.type === "warning" &&
          event.msg.payload.message.includes("Automatic approval review approved"),
      ),
    ).toBe(true);
    expect(
      events
        .filter((event) => event.msg.type === "guardian_assessment")
        .map((event) =>
          event.msg.type === "guardian_assessment" ? event.msg.payload.status : "",
        ),
    ).toEqual(["in_progress", "approved"]);
  });

  it("selects the hidden auto-review model when it is available", async () => {
    let observedModel: string | undefined;
    const { session } = mkSession({
      provider: mkProvider({
        content: '{"outcome":"allow"}',
        onChat: (_messages, options) => {
          observedModel = options?.model;
        },
      }),
      models: [
        mkModelInfo("test-model"),
        {
          ...mkModelInfo(GUARDIAN_PREFERRED_MODEL),
          visibility: "hide",
          showInPicker: false,
        },
      ],
    });
    const turn = newDefaultTurnWithSubId(session, "turn-preferred-model");
    const reviewer = createDefaultGuardianApprovalReviewer({ timeoutMs: 5_000 });

    const result = await reviewer.reviewApprovalRequest({
      ctx: mkApprovalCtx(session, turn),
      args: { path: "file.txt", content: "ok" },
    });

    expect(result.decision.kind).toBe("approved");
    expect(observedModel).toBe(GUARDIAN_PREFERRED_MODEL);
  });

  it("guardian deny assessment records a denial and returns the rationale", async () => {
    const { session, breaker } = mkSession({
      provider: mkProvider({
        content: JSON.stringify({
          outcome: "deny",
          risk_level: "critical",
          user_authorization: "unknown",
          rationale: "writes outside the workspace",
        }),
      }),
    });
    const turn = newDefaultTurnWithSubId(session, "turn-deny");
    const reviewer = createDefaultGuardianApprovalReviewer({ timeoutMs: 5_000 });

    const result = await reviewer.reviewApprovalRequest({
      ctx: mkApprovalCtx(session, turn),
      args: { path: "/etc/passwd", content: "bad" },
    });

    expect(result.decision.kind).toBe("denied");
    expect(result.countedDenial).toBe(true);
    expect(result.reason).toContain("writes outside the workspace");
    expect(breaker.peek("turn-deny")).toMatchObject({
      consecutiveDenials: 1,
      totalDenials: 1,
    });
  });

  it("generic review findings from the guardian prompt count as denials", async () => {
    const { session, breaker } = mkSession({
      provider: mkProvider({
        content: JSON.stringify({
          findings: [
            {
              title: "Unsafe write",
              body: "The approval would overwrite a protected file.",
              confidence_score: 0.9,
              priority: 0,
              code_location: {
                absolute_path: "/tmp/file.txt",
                line_range: { start: 1, end: 1 },
              },
            },
          ],
          overall_correctness: "unsafe",
          overall_explanation: "The request should be denied.",
          overall_confidence_score: 0.9,
        }),
      }),
    });
    const turn = newDefaultTurnWithSubId(session, "turn-findings");
    const reviewer = createDefaultGuardianApprovalReviewer({ timeoutMs: 5_000 });

    const result = await reviewer.reviewApprovalRequest({
      ctx: mkApprovalCtx(session, turn),
      args: { path: "/tmp/file.txt", content: "bad" },
    });

    expect(result.decision.kind).toBe("denied");
    expect(result.countedDenial).toBe(true);
    expect(result.reason).toContain("Generic review findings flagged");
    expect(breaker.peek("turn-findings")).toMatchObject({
      consecutiveDenials: 1,
      totalDenials: 1,
    });
  });

  it("timeout fails closed without counting as a breaker denial", async () => {
    vi.useFakeTimers();
    const { session, breaker } = mkSession({
      provider: mkProvider({ content: '{"outcome":"allow"}', delayMs: 100 }),
    });
    const turn = newDefaultTurnWithSubId(session, "turn-timeout");
    const reviewer = createDefaultGuardianApprovalReviewer({ timeoutMs: 5 });

    const promise = reviewer.reviewApprovalRequest({
      ctx: mkApprovalCtx(session, turn),
      args: { path: "file.txt", content: "ok" },
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await promise;
    vi.useRealTimers();

    expect(result.decision.kind).toBe("timed_out");
    expect(result.countedDenial).toBe(false);
    expect(breaker.peek("turn-timeout")).toMatchObject({
      consecutiveDenials: 0,
      totalDenials: 0,
    });
  });
});
