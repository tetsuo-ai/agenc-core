/**
 * Tests for the review-task subsystem (`session/review.ts`).
 *
 * Proves the T13 port contract:
 *   - `spawnReviewTask` registers a task with `kind === "review"` in
 *     the session's Wave 2 task registry.
 *   - `session.abortAllTasks(...)` cancels a live review (the Wave 2
 *     abort-cascade flows through the review task's abortController).
 *   - `session.onTaskFinished(subId)` drains the review from the
 *     registry the same way it drains a regular turn.
 *   - Review tasks are NOT steerable — `isTaskKindSteerable("review")`
 *     returns `false`, matching upstream agenc runtime behavior (Item 6
 *     steer_input gate port will consume this classifier directly).
 *   - `ReviewManager` tracks spawned reviews by subId and shuts them
 *     down cleanly (upstream `GuardianReviewSessionManager::shutdown`).
 *   - `parseReviewOutput` mirrors upstream
 *     `parse_review_output_event`: structured JSON, substring JSON,
 *     and plain-text fallback.
 *   - Exit templates render verbatim (upstream
 *     `render_review_exit_success` + CRLF-free
 *     `exit_interrupted.xml`).
 *
 * Fixture reuses the `buildSession` pattern from `tasks.test.ts` so
 * the cast-through-`unknown` SessionServices stub stays consistent
 * across the session-kernel test suites.
 */

import { describe, expect, it } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import {
  Session,
  type Event,
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
  REVIEW_EXIT_INTERRUPTED_TMPL,
  REVIEW_EXIT_SUCCESS_TMPL,
  REVIEW_SYSTEM_PROMPT,
  ReviewManager,
  emptyReviewOutput,
  isTaskKindSteerable,
  parseReviewOutput,
  renderReviewExitSuccess,
  spawnReviewTask,
  type ReviewRequest,
} from "./review.js";

// ─────────────────────────────────────────────────────────────────────
// Fixture (mirrors tasks.test.ts::buildSession)
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

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
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

interface ProviderOptions {
  readonly content?: string;
  readonly delayMs?: number;
  readonly onChat?: (messages: LLMMessage[], options?: LLMChatOptions) => void;
}

function mkProvider(opts: ProviderOptions = {}): LLMProvider {
  const chat = async (
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> => {
    opts.onChat?.(messages, options);
    const signal = options?.signal;
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (opts.delayMs !== undefined && opts.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        const abortHandler = () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) {
          abortHandler();
        } else if (signal !== undefined) {
          signal.addEventListener("abort", abortHandler, { once: true });
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
    name: "stub-provider",
    chat,
    chatStream: async (messages, onChunk, options) => {
      const response = await chat(messages, options);
      if (response.content.length > 0) {
        onChunk({ content: response.content, done: false });
      }
      return response;
    },
  } as unknown as LLMProvider;
}

function mkSession(opts?: {
  reviewManager?: ReviewManager;
  provider?: LLMProvider;
}): Session {
  const services = {
    admissionRequired: false,
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: opts?.provider ?? mkProvider(),
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    ...(opts?.reviewManager !== undefined
      ? { reviewManager: opts.reviewManager }
      : {}),
  } as unknown as SessionServices;
  const sessionOpts: SessionOpts = {
    conversationId: "conv-review-test",
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

const mkReviewRequest = (
  overrides?: Partial<ReviewRequest>,
): ReviewRequest => ({
  target: "Diff between HEAD and main",
  userFacingHint: "Focus on error-handling paths",
  ...overrides,
});

type ExitReviewPayload = Extract<
  Event["msg"],
  { readonly type: "exit_review_mode" }
>["payload"];

function observeExitReviewMode(session: Session): Promise<ExitReviewPayload> {
  return new Promise((resolve) => {
    const unsubscribe = session.eventLog.subscribe((event) => {
      if (event.msg.type === "exit_review_mode") {
        unsubscribe();
        resolve(event.msg.payload);
      }
    });
  });
}

function messageText(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { readonly text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// isTaskKindSteerable classification (Item 6 readiness)
// ─────────────────────────────────────────────────────────────────────

describe("isTaskKindSteerable — Item 6 gate classification", () => {
  it("classifies `regular` as steerable", () => {
    expect(isTaskKindSteerable("regular")).toBe(true);
  });

  it("classifies `review` as NOT steerable (matches upstream ActiveTurnNotSteerable)", () => {
    expect(isTaskKindSteerable("review")).toBe(false);
  });

  it("classifies `compact` as NOT steerable", () => {
    expect(isTaskKindSteerable("compact")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// spawnReviewTask registry + lifecycle
// ─────────────────────────────────────────────────────────────────────

describe("spawnReviewTask registry lifecycle", () => {
  it("registers a task with kind === 'review' in the session's activeTurn", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    const active = session.activeTurn.unsafePeek();
    expect(active).not.toBeNull();
    expect(active?.turnId).toBe("review-A");
    expect(active?.tasks.has("review-A")).toBe(true);
    expect(active?.tasks.get("review-A")?.kind).toBe("review");
    expect(spawned.kind).toBe("review");
    expect(spawned.subId).toBe("review-A");
    expect(spawned.abortController).toBeInstanceOf(AbortController);
    expect(spawned.done).toBeInstanceOf(Promise);
    expect(spawned.request.target).toBe("Diff between HEAD and main");
    await session.onTaskFinished("review-A");
  });

  it("preserves the externally-supplied AbortController", async () => {
    const session = mkSession();
    const controller = new AbortController();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
      abortController: controller,
    });
    expect(spawned.abortController).toBe(controller);
    const active = session.activeTurn.unsafePeek();
    expect(active?.tasks.get("review-A")?.abortController).toBe(controller);
    await session.onTaskFinished("review-A");
  });

  it("onTaskFinished resolves the review's done promise and clears the activeTurn slot", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    let resolved = false;
    const watcher = spawned.done.then(() => {
      resolved = true;
    });
    await session.onTaskFinished("review-A");
    await watcher;
    expect(resolved).toBe(true);
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("runs the full reviewer driver and resolves outcome after exit_review_mode", async () => {
    let observedMessages: LLMMessage[] = [];
    let observedOptions: LLMChatOptions | undefined;
    const events: Event["msg"][] = [];
    const rolloutItems: unknown[] = [];
    const provider = mkProvider({
      content: "review completed",
      onChat: (messages, options) => {
        observedMessages = messages;
        observedOptions = options;
      },
    });
    const session = mkSession({ provider });
    session.eventLog.subscribe((event) => events.push(event.msg));
    session.rolloutStore = {
      store: { agencVersion: "test" },
      append: (item: unknown) => {
        rolloutItems.push(item);
      },
      appendRollout: (item: unknown) => {
        rolloutItems.push(item);
      },
    } as Session["rolloutStore"];
    const exitPromise = observeExitReviewMode(session);
    const spawned = await spawnReviewTask(session, {
      subId: "review-full-driver",
      request: mkReviewRequest({ target: "Full driver target" }),
    });

    const outcome = await spawned.outcome;
    await spawned.done;
    const exit = await exitPromise;

    expect(outcome?.verdict).toBe("pass");
    expect(exit.reason).toBe("completed");
    expect(session.activeTurn.unsafePeek()).toBeNull();
    expect(
      observedMessages.some((message) =>
        messageText(message).includes("Target: Full driver target"),
      ),
    ).toBe(true);
    expect(observedOptions?.tools).toEqual([]);
    expect(observedOptions?.toolChoice).toBe("none");
    expect(
      events.find((event) => event.type === "entered_review_mode"),
    ).toMatchObject({
      type: "entered_review_mode",
      payload: { target: "Full driver target" },
    });
    expect(
      events.find((event) => event.type === "review_delegate_started"),
    ).toMatchObject({
      type: "review_delegate_started",
      payload: {
        subId: "review-full-driver",
        snapshot_reused: false,
        priorFindingCount: 0,
      },
    });
    expect(
      events.find((event) => event.type === "review_delegate_completed"),
    ).toMatchObject({
      type: "review_delegate_completed",
      payload: {
        subId: "review-full-driver",
        newFindingCount: 0,
        verdict: "pass",
        reason: "completed",
      },
    });
    expect(rolloutItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response_item",
          payload: expect.objectContaining({
            id: "review_rollout_user",
            role: "user",
          }),
        }),
        expect.objectContaining({
          type: "response_item",
          payload: expect.objectContaining({
            id: "review_rollout_assistant",
            role: "assistant",
            content: "review completed",
          }),
        }),
      ]),
    );
    const history = session.state.unsafePeek().history;
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "review_rollout_user" }),
        expect.objectContaining({ id: "review_rollout_assistant" }),
      ]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Abort-mid-review cleanup
// ─────────────────────────────────────────────────────────────────────

describe("spawnReviewTask abort lifecycle", () => {
  it("session.abortAllTasks cancels a running review with the given reason", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    expect(spawned.abortController.signal.aborted).toBe(false);
    await session.abortAllTasks("interrupted");
    expect(spawned.abortController.signal.aborted).toBe(true);
    expect(spawned.abortController.signal.reason).toBe("interrupted");
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("abortAllTasks with reason='review_ended' propagates to the review controller", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    await session.abortAllTasks("review_ended");
    expect(spawned.abortController.signal.aborted).toBe(true);
    expect(spawned.abortController.signal.reason).toBe("review_ended");
  });

  it("a new spawnReviewTask replaces a prior one with reason='replaced'", async () => {
    const session = mkSession();
    const first = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest({ target: "first" }),
    });
    const second = await spawnReviewTask(session, {
      subId: "review-B",
      request: mkReviewRequest({ target: "second" }),
    });
    expect(first.abortController.signal.aborted).toBe(true);
    expect(first.abortController.signal.reason).toBe("replaced");
    expect(second.abortController.signal.aborted).toBe(false);
    expect(session.activeTurn.unsafePeek()?.turnId).toBe("review-B");
    await session.onTaskFinished("review-B");
  });

  it("abortTurnIfActive targets a live review by subId", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    expect(await session.abortTurnIfActive("review-other", "interrupted")).toBe(
      false,
    );
    expect(spawned.abortController.signal.aborted).toBe(false);
    expect(await session.abortTurnIfActive("review-A", "interrupted")).toBe(
      true,
    );
    expect(spawned.abortController.signal.aborted).toBe(true);
  });

  it("abortAllTasks cancels the running reviewer driver and emits an aborted review exit", async () => {
    const session = mkSession({
      provider: mkProvider({ content: "too late", delayMs: 500 }),
    });
    const exitPromise = observeExitReviewMode(session);
    const spawned = await spawnReviewTask(session, {
      subId: "review-abort-driver",
      request: mkReviewRequest(),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.abortAllTasks("interrupted");

    const outcome = await spawned.outcome;
    const exit = await exitPromise;
    expect(outcome?.verdict).toBe("aborted");
    expect(exit.reason).toBe("aborted");
    expect(spawned.abortController.signal.aborted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ReviewManager bookkeeping
// ─────────────────────────────────────────────────────────────────────

describe("ReviewManager", () => {
  it("register + take round-trips a review by subId", () => {
    const manager = new ReviewManager();
    const controller = new AbortController();
    const request = mkReviewRequest();
    manager.register({ subId: "r1", abortController: controller, request });
    expect(manager.has("r1")).toBe(true);
    expect(manager.size).toBe(1);
    const taken = manager.take("r1");
    expect(taken).toBeDefined();
    expect(taken?.subId).toBe("r1");
    expect(taken?.abortController).toBe(controller);
    expect(manager.has("r1")).toBe(false);
    expect(manager.size).toBe(0);
  });

  it("take returns undefined for unknown subIds", () => {
    const manager = new ReviewManager();
    expect(manager.take("missing")).toBeUndefined();
  });

  it("register replaces an existing entry for the same subId", () => {
    const manager = new ReviewManager();
    const first = new AbortController();
    const second = new AbortController();
    manager.register({
      subId: "r1",
      abortController: first,
      request: mkReviewRequest(),
    });
    manager.register({
      subId: "r1",
      abortController: second,
      request: mkReviewRequest(),
    });
    expect(manager.size).toBe(1);
    const taken = manager.take("r1");
    expect(taken?.abortController).toBe(second);
  });

  it("snapshot returns current tracked reviews without exposing controllers", () => {
    const manager = new ReviewManager();
    manager.register({
      subId: "r1",
      abortController: new AbortController(),
      request: mkReviewRequest({ target: "T1" }),
    });
    manager.register({
      subId: "r2",
      abortController: new AbortController(),
      request: mkReviewRequest({ target: "T2" }),
    });
    const snap = manager.snapshot();
    expect(snap.length).toBe(2);
    const targets = snap.map((e) => e.request.target).sort();
    expect(targets).toEqual(["T1", "T2"]);
    expect(Object.keys(snap[0] ?? {})).toEqual(["subId", "request"]);
  });

  it("shutdown cancels every tracked review's abort controller and clears the registry", () => {
    const manager = new ReviewManager();
    const c1 = new AbortController();
    const c2 = new AbortController();
    manager.register({
      subId: "r1",
      abortController: c1,
      request: mkReviewRequest(),
    });
    manager.register({
      subId: "r2",
      abortController: c2,
      request: mkReviewRequest(),
    });
    manager.shutdown("review_ended");
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(true);
    expect(c1.signal.reason).toBe("review_ended");
    expect(c2.signal.reason).toBe("review_ended");
    expect(manager.size).toBe(0);
  });

  it("shutdown does not double-abort a controller that is already aborted", () => {
    const manager = new ReviewManager();
    const c1 = new AbortController();
    c1.abort("pre-existing");
    manager.register({
      subId: "r1",
      abortController: c1,
      request: mkReviewRequest(),
    });
    manager.shutdown("review_ended");
    // Reason remains the pre-existing one; upstream AbortController semantics
    // make abort() a no-op once already aborted, but we guard explicitly so
    // the test documents the invariant.
    expect(c1.signal.reason).toBe("pre-existing");
    expect(manager.size).toBe(0);
  });

  it("spawnReviewTask with a manager registers the entry by subId", async () => {
    const session = mkSession();
    const manager = new ReviewManager();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest({ target: "with-manager" }),
      manager,
    });
    expect(manager.has("review-A")).toBe(true);
    const snap = manager.snapshot();
    expect(snap[0]?.request.target).toBe("with-manager");
    // Cleanup should keep the controller reference aligned.
    manager.take("review-A");
    await session.onTaskFinished(spawned.subId);
  });

  it("spawnReviewTask without a manager still returns a live spawned task", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    expect(spawned.kind).toBe("review");
    // No manager supplied → no global registry to inspect, but the task
    // still flows through session.spawnTask and registers in activeTurn.
    expect(session.activeTurn.unsafePeek()?.tasks.has("review-A")).toBe(true);
    await session.onTaskFinished("review-A");
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseReviewOutput / emptyReviewOutput (upstream parse_review_output_event)
// ─────────────────────────────────────────────────────────────────────

describe("parseReviewOutput", () => {
  it("returns an empty default when given a blank object JSON", () => {
    const out = parseReviewOutput("{}");
    expect(out).toEqual(emptyReviewOutput());
  });

  it("parses a well-formed structured JSON response (snake_case fields)", () => {
    const payload = JSON.stringify({
      findings: [
        {
          title: "issue 1",
          body: "detail",
          confidence_score: 0.5,
          priority: 2,
          code_location: {
            absolute_path: "/tmp/x.ts",
            line_range: { start: 1, end: 2 },
          },
        },
      ],
      overall_correctness: "good",
      overall_explanation: "looks fine",
      overall_confidence_score: 0.9,
    });
    const out = parseReviewOutput(payload);
    expect(out.overallCorrectness).toBe("good");
    expect(out.overallExplanation).toBe("looks fine");
    expect(out.overallConfidenceScore).toBe(0.9);
    expect(out.findings.length).toBe(1);
    expect(out.findings[0]?.title).toBe("issue 1");
  });

  it("parses camelCase fields as a compatibility path", () => {
    const payload = JSON.stringify({
      findings: [],
      overallCorrectness: "good",
      overallExplanation: "ok",
      overallConfidenceScore: 0.7,
    });
    const out = parseReviewOutput(payload);
    expect(out.overallCorrectness).toBe("good");
    expect(out.overallExplanation).toBe("ok");
    expect(out.overallConfidenceScore).toBe(0.7);
  });

  it("extracts JSON from a text wrapper (upstream `text.find('{') .. text.rfind('}')`)", () => {
    const raw =
      'Here is the review: {"overall_explanation":"wrapped"} trailing noise';
    const out = parseReviewOutput(raw);
    expect(out.overallExplanation).toBe("wrapped");
  });

  it("falls back to plain text when no JSON is present", () => {
    const raw = "just some plain review text";
    const out = parseReviewOutput(raw);
    expect(out.overallExplanation).toBe(raw);
    expect(out.findings).toEqual([]);
  });

  it("falls back to plain text for malformed JSON with no usable braces", () => {
    const raw = "broken [ array syntax";
    const out = parseReviewOutput(raw);
    expect(out.overallExplanation).toBe(raw);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Exit templates / system prompt (verbatim upstream fidelity)
// ─────────────────────────────────────────────────────────────────────

describe("review exit templates", () => {
  it("renderReviewExitSuccess substitutes {{results}} once", () => {
    const rendered = renderReviewExitSuccess("Finding A\nFinding B");
    // Mirrors upstream tasks/review.rs::tests::render_review_exit_success_replaces_results_placeholder
    expect(rendered).toBe(
      "<user_action>\n  <context>User initiated a review task. Here's the full review output from reviewer model. User may select one or more comments to resolve.</context>\n  <action>review</action>\n  <results>\n  Finding A\nFinding B\n  </results>\n  </user_action>",
    );
  });

  it("REVIEW_EXIT_SUCCESS_TMPL carries the {{results}} placeholder", () => {
    expect(REVIEW_EXIT_SUCCESS_TMPL).toContain("{{results}}");
  });

  it("REVIEW_EXIT_INTERRUPTED_TMPL matches the upstream interrupted template", () => {
    // Upstream core/templates/review/exit_interrupted.xml (LF-normalized).
    expect(REVIEW_EXIT_INTERRUPTED_TMPL).toBe(
      "<user_action>\n  <context>User initiated a review task, but was interrupted. If user asks about this, tell them to re-initiate a review with `/review` and wait for it to complete.</context>\n  <action>review</action>\n  <results>\n  None.\n  </results>\n</user_action>\n",
    );
  });

  it("REVIEW_SYSTEM_PROMPT begins with the upstream review guidelines header", () => {
    expect(REVIEW_SYSTEM_PROMPT.startsWith("# Review guidelines:")).toBe(true);
    // Spot-check one of the numbered guidelines to detect accidental edits.
    expect(REVIEW_SYSTEM_PROMPT).toContain(
      "4. The bug was introduced in the commit (pre-existing bugs should not be flagged).",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// SessionServices wiring (optional reviewManager field)
// ─────────────────────────────────────────────────────────────────────

describe("SessionServices.reviewManager wiring", () => {
  it("supplying a reviewManager through SessionServices is accepted by the constructor", () => {
    const manager = new ReviewManager();
    const session = mkSession({ reviewManager: manager });
    // The manager is reachable through services. Services field is
    // optional; this asserts the surface without asserting specific
    // auto-wiring behavior (none is in scope for this port).
    expect(session.services.reviewManager).toBe(manager);
  });

  it("sessions without a reviewManager still work (field is optional)", () => {
    const session = mkSession();
    expect(session.services.reviewManager).toBeUndefined();
  });

  it("spawnReviewTask on a session with a services.reviewManager can register through it", async () => {
    const manager = new ReviewManager();
    const session = mkSession({ reviewManager: manager });
    await spawnReviewTask(session, {
      subId: "review-svc",
      request: mkReviewRequest(),
      manager: session.services.reviewManager,
    });
    expect(manager.has("review-svc")).toBe(true);
    await session.onTaskFinished("review-svc");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Module-level structural types (spot-check defaults + shape)
// ─────────────────────────────────────────────────────────────────────

describe("emptyReviewOutput", () => {
  it("returns a struct with zero-default primitives and empty findings", () => {
    const out = emptyReviewOutput();
    expect(out.findings).toEqual([]);
    expect(out.overallCorrectness).toBe("");
    expect(out.overallExplanation).toBe("");
    expect(out.overallConfidenceScore).toBe(0);
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = emptyReviewOutput();
    const b = emptyReviewOutput();
    expect(a).not.toBe(b);
    expect(a.findings).not.toBe(b.findings);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Additional regression coverage: review flows interleaved with other
// task kinds in the same session.
// ─────────────────────────────────────────────────────────────────────

describe("review task interleave with regular tasks", () => {
  it("a regular turn after a finished review starts with a fresh registry", async () => {
    const session = mkSession();
    await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    await session.onTaskFinished("review-A");
    expect(session.activeTurn.unsafePeek()).toBeNull();
    const regular = await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
    });
    expect(session.activeTurn.unsafePeek()?.turnId).toBe("turn-A");
    expect(regular.kind).toBe("regular");
    await session.onTaskFinished("turn-A");
  });

  it("a review spawn while a regular turn is live replaces the regular turn", async () => {
    const session = mkSession();
    const regular = await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
    });
    expect(regular.abortController.signal.aborted).toBe(false);
    const review = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    // Wave 2 replace-on-new-turn: prior regular is aborted with "replaced".
    expect(regular.abortController.signal.aborted).toBe(true);
    expect(regular.abortController.signal.reason).toBe("replaced");
    expect(session.activeTurn.unsafePeek()?.turnId).toBe("review-A");
    expect(session.activeTurn.unsafePeek()?.tasks.get("review-A")?.kind).toBe(
      "review",
    );
    await session.onTaskFinished(review.subId);
  });

  it("a regular spawn while a review is live replaces the review", async () => {
    const session = mkSession();
    const review = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    const regular = await session.spawnTask({
      subId: "turn-A",
      kind: "regular",
    });
    expect(review.abortController.signal.aborted).toBe(true);
    expect(review.abortController.signal.reason).toBe("replaced");
    expect(session.activeTurn.unsafePeek()?.turnId).toBe("turn-A");
    await session.onTaskFinished(regular.subId);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Manager + Wave 2 abort cascade integration
// ─────────────────────────────────────────────────────────────────────

describe("ReviewManager + session abort integration", () => {
  it("manager.shutdown does not prevent session.abortAllTasks from finalizing the task", async () => {
    const session = mkSession();
    const manager = new ReviewManager();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
      manager,
    });
    // Manager-level shutdown fires the shared abort controller.
    manager.shutdown("review_ended");
    expect(spawned.abortController.signal.aborted).toBe(true);
    // session.abortAllTasks should then clear activeTurn and honor the
    // pre-aborted controller (the graceful-interruption path in
    // tasks.ts handleTaskAbort short-circuits when already aborted).
    await session.abortAllTasks("interrupted");
    expect(session.activeTurn.unsafePeek()).toBeNull();
  });

  it("session.onTaskFinished does not automatically remove the entry from ReviewManager", async () => {
    // Documents the current contract: the manager registry is separate
    // from Session's task registry. Callers who register a review with
    // a manager are responsible for calling manager.take(subId) or
    // manager.shutdown() to release it. This matches upstream agenc runtime
    // where `on_task_finished` does not reach into the
    // `GuardianReviewSessionManager` state.
    const session = mkSession();
    const manager = new ReviewManager();
    await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
      manager,
    });
    await session.onTaskFinished("review-A");
    expect(manager.has("review-A")).toBe(true);
    // Explicit cleanup.
    manager.take("review-A");
    expect(manager.has("review-A")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Review-specific abort reasons — review_ended parity
// ─────────────────────────────────────────────────────────────────────

describe("review_ended TurnAbortReason", () => {
  it("is accepted by session.abortAllTasks and surfaces on the controller", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    await session.abortAllTasks("review_ended");
    expect(spawned.abortController.signal.aborted).toBe(true);
    expect(spawned.abortController.signal.reason).toBe("review_ended");
  });

  it("abortTurnIfActive propagates review_ended to a live review task", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
    });
    expect(await session.abortTurnIfActive("review-A", "review_ended")).toBe(
      true,
    );
    expect(spawned.abortController.signal.reason).toBe("review_ended");
  });
});

// ─────────────────────────────────────────────────────────────────────
// spawnReviewTask input / request shape handling
// ─────────────────────────────────────────────────────────────────────

describe("spawnReviewTask request shape", () => {
  it("preserves the request on the returned SpawnedReviewTask (including optional hint)", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: {
        target: "Sweep the error-handling module",
        userFacingHint: "Focus on panic paths",
      },
    });
    expect(spawned.request.target).toBe("Sweep the error-handling module");
    expect(spawned.request.userFacingHint).toBe("Focus on panic paths");
    await session.onTaskFinished(spawned.subId);
  });

  it("accepts a request without the optional userFacingHint", async () => {
    const session = mkSession();
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: { target: "minimal target" },
    });
    expect(spawned.request.target).toBe("minimal target");
    expect(spawned.request.userFacingHint).toBeUndefined();
    await session.onTaskFinished(spawned.subId);
  });

  it("honours startedAtMs override on the session's RunningTask", async () => {
    const session = mkSession();
    const startedAtMs = 1_700_000_000_000;
    const spawned = await spawnReviewTask(session, {
      subId: "review-A",
      request: mkReviewRequest(),
      startedAtMs,
    });
    const active = session.activeTurn.unsafePeek();
    expect(active?.tasks.get(spawned.subId)?.startedAtMs).toBe(startedAtMs);
    await session.onTaskFinished(spawned.subId);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Parser edge cases: findings filtering, partial payloads
// ─────────────────────────────────────────────────────────────────────

describe("parseReviewOutput edge cases", () => {
  it("filters findings that do not have a string title (defensive parse)", () => {
    const payload = JSON.stringify({
      findings: [
        { title: "ok", body: "b" },
        { title: 42 }, // invalid shape
        null,
        "raw string",
      ],
      overall_explanation: "mixed findings",
    });
    const out = parseReviewOutput(payload);
    expect(out.findings.length).toBe(1);
    expect(out.findings[0]?.title).toBe("ok");
  });

  it("ignores a non-array findings field (keeps findings empty)", () => {
    const payload = JSON.stringify({
      findings: "not an array",
      overall_explanation: "coerced",
    });
    const out = parseReviewOutput(payload);
    expect(out.findings).toEqual([]);
    expect(out.overallExplanation).toBe("coerced");
  });

  it("treats a JSON literal that is not an object as plain text fallback", () => {
    const out = parseReviewOutput("42");
    // `42` parses as valid JSON but is not an object, so the parser
    // falls through to the substring path (finds no braces) and then
    // to the plain-text fallback.
    expect(out.overallExplanation).toBe("42");
  });

  it("treats a top-level JSON array as plain text fallback", () => {
    const out = parseReviewOutput("[1,2,3]");
    expect(out.overallExplanation).toBe("[1,2,3]");
  });

  it("defaults numeric overallConfidenceScore to 0 when absent", () => {
    const out = parseReviewOutput('{"overall_explanation":"x"}');
    expect(out.overallConfidenceScore).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Template rendering edge cases
// ─────────────────────────────────────────────────────────────────────

describe("renderReviewExitSuccess edge cases", () => {
  it("renders an empty results string as a blank placeholder", () => {
    const rendered = renderReviewExitSuccess("");
    expect(rendered).toContain("<results>\n  \n  </results>");
  });

  it("preserves newlines in the results payload verbatim", () => {
    const results = "line1\nline2\nline3";
    const rendered = renderReviewExitSuccess(results);
    expect(rendered).toContain(results);
  });

  it("escapes no characters in results (matches upstream — callers must sanitize)", () => {
    // Upstream agenc runtime template engine substitutes literally; any escaping
    // is the caller's responsibility. This test pins the behavior.
    const results = "a<b>c&d\"e'f";
    const rendered = renderReviewExitSuccess(results);
    expect(rendered).toContain(results);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Manager lifecycle edges
// ─────────────────────────────────────────────────────────────────────

describe("ReviewManager lifecycle edges", () => {
  it("size reflects registers, takes, and shutdown", () => {
    const manager = new ReviewManager();
    expect(manager.size).toBe(0);
    manager.register({
      subId: "r1",
      abortController: new AbortController(),
      request: mkReviewRequest(),
    });
    manager.register({
      subId: "r2",
      abortController: new AbortController(),
      request: mkReviewRequest(),
    });
    expect(manager.size).toBe(2);
    manager.take("r1");
    expect(manager.size).toBe(1);
    manager.shutdown();
    expect(manager.size).toBe(0);
  });

  it("shutdown on an empty manager is a safe no-op", () => {
    const manager = new ReviewManager();
    expect(() => manager.shutdown()).not.toThrow();
    expect(manager.size).toBe(0);
  });

  it("take is idempotent — a second take for the same subId returns undefined", () => {
    const manager = new ReviewManager();
    manager.register({
      subId: "r1",
      abortController: new AbortController(),
      request: mkReviewRequest(),
    });
    expect(manager.take("r1")).toBeDefined();
    expect(manager.take("r1")).toBeUndefined();
  });

  it("default shutdown reason is review_ended", () => {
    const manager = new ReviewManager();
    const controller = new AbortController();
    manager.register({
      subId: "r1",
      abortController: controller,
      request: mkReviewRequest(),
    });
    manager.shutdown();
    expect(controller.signal.reason).toBe("review_ended");
  });
});
