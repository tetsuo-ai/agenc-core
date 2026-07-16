/**
 * AgenC child-session delegate surface for review-scoped one-shot turns.
 *
 * This module replaces the old flat reviewer provider call with the
 * upstream-shaped delegate contract: create an isolated child Session,
 * submit one user input through a tx queue, consume child events through
 * an rx queue, forward approval/permission requests to the parent, and
 * shut the child down on completion, abort, or timeout.
 *
 * Product-facing names are AgenC-owned. References to upstream behavior
 * in comments are provenance only; live file names, exported types, and
 * events avoid agenc runtime-branded delegate names.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
} from "../llm/types.js";
import {
  createProvider,
  readProviderFactoryOptions,
  readProviderIdentity,
} from "../llm/provider.js";
import type {
  Config,
  ModelInfo,
  SessionConfiguration,
  TurnContext,
} from "./turn-context.js";
import { buildTurnContext } from "./turn-context.js";
import {
  Session,
  type AgentStatus,
  type SessionServices,
} from "./session.js";
import type { Event, EventMsg } from "./event-log.js";
import type { ReviewOutput, ReviewRequest } from "./review.js";
import {
  REVIEW_SYSTEM_PROMPT,
  emptyReviewOutput,
  parseReviewOutput,
  recordReviewExitRollout,
} from "./review.js";
import type { RunningTask, SpawnTaskOptions } from "./tasks.js";
import { AsyncQueue, BehaviorSubject } from "./_deps/utils.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { ToolRegistry } from "./_deps/tool-registry.js";

// ─────────────────────────────────────────────────────────────────────
// Structural dependencies (`AgenCDelegateSessionLike`, `AgenCDelegateTurnContextLike`)
//
// Upstream agenc runtime passes `Arc<Session>` + `Arc<TurnContext>`. Gut stays
// structural so tests can build minimal fixtures. The *minimum* a
// delegate needs is: a provider handle, an event emitter, and a task
// registrar. Everything else is an opt-in extension.
// ─────────────────────────────────────────────────────────────────────

/**
 * Emitter surface exposed by the parent session. Matches
 * `Session.emit` / `Session.sendEvent` (`session.ts:1380`,
 * `session.ts:1416`). The gut delegate emits `exit_review_mode`
 * through this sink on every termination path (happy, timeout,
 * aborted) so the caller does not need to reach into the delegate's
 * internals.
 */
export interface AgenCDelegateEventSink {
  /** Upstream agenc runtime `Session::send_event` — sends an event with the
   *  given sub_id stamped as `id`. */
  sendEvent(subId: string, msg: EventMsg): void;
  /** Upstream agenc runtime `Session::emit` — emit with a pre-built event. */
  emit(event: Event): void;
}

/**
 * Minimum session surface the delegate consumes. Shaped so the live
 * `Session` satisfies it with zero adapter work (the fields below are
 * all present on `Session`), while tests can supply a minimal object
 * literal.
 *
 * The live path passes a real `Session`; this structural surface keeps
 * tests and guardian approval review from importing more than they
 * need while still exposing parent task lifecycle and forwarding hooks.
 */
export interface AgenCDelegateSessionLike extends AgenCDelegateEventSink {
  /** Upstream `sess.services.provider`. The provider to route the
   *  one-shot review call through. */
  readonly provider: LLMProvider;
  /** Optional service bag present on live `Session`. The delegate uses
   *  `modelsManager` when available to match upstream's reviewer-model
   *  capability lookup before the provider call. */
  readonly services?: Partial<SessionServices> & {
    readonly modelsManager?: {
      getModelInfo(modelSlug: string, config?: unknown): Promise<ModelInfo>;
    };
  };
  /** Upstream agenc runtime `Session::spawn_task`. Used so the delegate's
   *  review turn participates in the Wave 2 task lifecycle (replace-
   *  on-new-turn, abort cascade, done promise). */
  spawnTask(opts: SpawnTaskOptions): Promise<RunningTask>;
  /** Upstream agenc runtime `Session::on_task_finished`. Called by the
   *  delegate on every termination path so the task drains cleanly. */
  onTaskFinished(subId: string): Promise<void>;
}

/**
 * Minimum `TurnContext` surface the delegate consumes when
 * synthesizing the review-scoped context. The full `TurnContext` is
 * accepted via `TurnContext`, but the structural shape below
 * documents exactly which fields participate in the review-scoped
 * override so a future ThreadContext-style refactor can narrow the
 * coupling.
 */
export type AgenCDelegateTurnContextLike = TurnContext;

// ─────────────────────────────────────────────────────────────────────
// Request / response shapes
// ─────────────────────────────────────────────────────────────────────

/**
 * Input shape for `runAgenCReviewOneShot`. Mirrors the positional arg
 * list of the upstream one-shot child-thread helper:
 *   (config, auth_manager, models_manager, input, parent_session,
 *    parent_ctx, cancel_token, subagent_source,
 *    final_output_json_schema, initial_history)
 */
export interface AgenCReviewOneShotRequest {
  /** Upstream `sub_id`. Identifier the session registers the task
   *  under. The delegate reuses this as the `TurnContext.subId` so the
   *  review-scoped context stamps emitted events with the caller's id. */
  readonly subId: string;
  /** Upstream `config`. The review-scoped `Config` from
   *  {@link buildGuardianReviewSessionConfig}. Required so the one-shot
   *  call uses the reviewer-scoped sandbox/approval/feature settings
   *  instead of the parent's. */
  readonly config: Config;
  /** Upstream `parent_ctx`. The parent `TurnContext` used as the
   *  basis for the review-scoped `TurnContext`. */
  readonly parentContext: AgenCDelegateTurnContextLike;
  /** Upstream `input: Vec<UserInput>`. Gut delegate accepts a
   *  pre-formed `LLMMessage[]` because the upstream `UserInput::Text`
   *  → provider-message plumbing lives outside this module's scope. */
  readonly input: ReadonlyArray<LLMMessage>;
  /** Review request context (target + user-facing hint). Attached to
   *  the synthesized `exit_review_mode` event so UIs can render which
   *  review this result belongs to. */
  readonly request: ReviewRequest;
  /** Optional reviewer-model override. Upstream reads this from
   *  `config.review_model` / `parent_ctx.model_info.slug`. When
   *  provided here, the delegate rebinds the review-scoped
   *  `TurnContext.modelInfo.slug` before issuing the provider call. */
  readonly reviewerModel?: string;
  /** Optional model metadata for the reviewer model. When omitted,
   *  the delegate inherits the parent context's `modelInfo`. */
  readonly reviewerModelInfo?: ModelInfo;
  /** Upstream `final_output_json_schema`. Passed through to the
   *  provider's structured-output slot when supported. `undefined`
   *  runs the reviewer as free-form text. */
  readonly finalOutputJsonSchema?: unknown;
  /** Upstream `cancel_token`. Parent abort signal; the delegate
   *  derives a child controller from this so it can shut down
   *  independently on completion. */
  readonly signal?: AbortSignal;
  /** Optional hard deadline for the one-shot turn. Upstream's
   *  `run_before_review_deadline` enforces a per-review timeout at
   *  the manager level; exposing it on the delegate as well lets
   *  callers without a `ReviewManager` bound still apply a budget. */
  readonly timeoutMs?: number;
  /**
   * Optional reviewer system prompt override. Generic `/review` uses
   * `REVIEW_SYSTEM_PROMPT`; guardian approval review supplies the
   * stricter approval-policy prompt while still reusing the same
   * one-shot provider envelope.
   */
  readonly systemPrompt?: string;
  /**
   * Defaults to `true`. Guardian approval review runs inside an
   * already-active main turn; spawning a Session task there would
   * replace and abort that turn. `false` keeps the one-shot provider
   * call inline while preserving timeout/abort/model/tool-disable
   * semantics.
   */
  readonly registerTask?: boolean;
  /**
   * Persist upstream-style synthetic review user/assistant records on
   * `exit_review_mode`. Defaults to true for standalone review tasks
   * and false for inline approval reviewers (`registerTask:false`).
   */
  readonly recordExitRollout?: boolean;
  /** Optional child-session history reused by ReviewManager snapshot caching. */
  readonly initialHistory?: ReadonlyArray<LLMMessage>;
  /**
   * Snapshot reuse key. `false` disables reuse for sensitive ephemeral
   * delegates such as guardian approval review.
   */
  readonly reuseKey?: string | false;
}

/**
 * Upstream agenc runtime `agenc runtime` return value of `run_agenc runtime_thread_one_shot`
 * (the wrapped `agenc runtime` struct from `agenc runtime_delegate.rs:230-236`). Gut
 * collapses this into a synchronous outcome because there is no
 * child-Session event channel to drain. Shape preserves the
 * essential fields a caller needs:
 *
 *   - `verdict` — `pass` / `fail` / `partial` / `aborted` / `timeout`.
 *     `pass` / `fail` / `partial` mirror upstream's structured
 *     `ReviewOutputEvent` outcomes; `aborted` / `timeout` cover the
 *     teardown paths where no model output is available.
 *   - `output` — parsed `ReviewOutput` (upstream `ReviewOutputEvent`).
 *     Always present so callers do not branch on undefined. Empty on
 *     abort/timeout.
 *   - `rawText` — the raw assistant text the reviewer model
 *     produced, pre-`parseReviewOutput`. `null` on abort/timeout.
 *   - `modelUsed` — the effective reviewer model slug (the overridden
 *     model when supplied, else the parent's).
 *   - `error` — populated on `aborted` / `timeout` / unexpected
 *     provider failure. Carries the underlying error reason for
 *     telemetry. `null` on success paths.
 */
export interface AgenCReviewOneShotOutcome {
  readonly verdict: "pass" | "fail" | "partial" | "aborted" | "timeout";
  readonly output: ReviewOutput;
  readonly rawText: string | null;
  readonly modelUsed: string;
  readonly error: Error | null;
}

// ─────────────────────────────────────────────────────────────────────
// Error shapes (upstream agenc runtimeErr / guardian review errors)
// ─────────────────────────────────────────────────────────────────────

/**
 * Raised when the request specifies a reviewer model that the
 * provider does not support. Upstream agenc runtime surfaces this through
 * `ModelsManager::get_model_info` failing to resolve the model slug.
 * Gut's delegate checks it up-front so callers get a typed rejection
 * before any provider round-trip.
 */
export class ReviewerModelMismatchError extends Error {
  readonly reviewerModel: string;
  readonly providerName: string;
  constructor(reviewerModel: string, providerName: string) {
    super(
      `reviewer model \`${reviewerModel}\` is not supported by provider \`${providerName}\``,
    );
    this.name = "ReviewerModelMismatchError";
    this.reviewerModel = reviewerModel;
    this.providerName = providerName;
  }
}

// ─────────────────────────────────────────────────────────────────────
// build_guardian_review_session_config port
// ─────────────────────────────────────────────────────────────────────

/**
 * Options for {@link buildGuardianReviewSessionConfig}. Mirrors the
 * positional args of upstream
 * `guardian/review_session.rs::build_guardian_review_session_config`
 * (`review_session.rs:831-836`) with a couple of gut-friendly
 * additions for the feature-flag surface.
 */
export interface BuildGuardianReviewSessionConfigOptions {
  /** Upstream `parent_config: &Config`. The session's live config. */
  readonly parentConfig: Config;
  /** Upstream `active_model: &str`. Reviewer model slug. */
  readonly activeModel: string;
  /**
   * Upstream `reasoning_effort: Option<ReasoningEffort>`. Gut's
   * `Config.modelReasoningEffort` covers the same slot; passing it
   * explicitly mirrors upstream's per-turn override semantics.
   */
  readonly reasoningEffort?: Config["modelReasoningEffort"];
  /**
   * Optional reviewer system prompt override. Defaults to
   * {@link REVIEW_SYSTEM_PROMPT}. Upstream wires this via
   * `guardian_policy_prompt(_with_config)`; gut uses the review
   * guidelines directly (upstream `tasks/review.rs:115`).
   */
  readonly baseInstructions?: string;
}

/**
 * Synthesize the review-scoped `Config` that the AgenC delegate runs
 * under. Mirrors upstream
 * `guardian/review_session.rs::build_guardian_review_session_config`
 * (`review_session.rs:831-897`).
 *
 * The fields that get rewritten (and the upstream evidence):
 *   - `model` ← `activeModel` (upstream line 838)
 *   - `modelReasoningEffort` ← `reasoningEffort` (line 839)
 *   - approval/sandbox → `never` / `read_only` (lines 849-851)
 * Child-session service isolation clears runtime tool/MCP visibility
 * at delegate construction time (`buildChildServices`) rather than by
 * mutating `Config`, because AgenC wires those surfaces through
 * `SessionServices`.
 *
 * Pure function: does not mutate the input config. Returns a fresh
 * frozen snapshot via the standard structuredClone+graft path used by
 * `buildPerTurnConfig` so the reviewer config cannot accidentally be
 * mutated by a later phase.
 */
export function buildGuardianReviewSessionConfig(
  opts: BuildGuardianReviewSessionConfigOptions,
): Readonly<Config> {
  const {
    parentConfig,
    activeModel,
    reasoningEffort,
  } = opts;

  // Gut's Config is readonly; structuredClone+graft-preserved the
  // non-serializable features field mirrors `buildPerTurnConfig`
  // (turn-context.ts::cloneConfigForSnapshot). Strip the features
  // callbacks before cloning because `structuredClone` rejects
  // function refs with `DataCloneError`.
  const { features: _features, ...rest } = parentConfig;
  void _features;
  const cloned = structuredClone(rest) as Config;
  // Graft the live features reference back so
  // `features.appsEnabledForAuth` keeps working.
  (cloned as { features: Config["features"] }).features = parentConfig.features;

  const mutable = cloned as unknown as Record<string, unknown>;
  mutable.model = activeModel;
  if (reasoningEffort !== undefined) {
    mutable.modelReasoningEffort = reasoningEffort;
  }
  // Upstream: approval_policy = Never, sandbox_policy = read_only.
  // Gut's `Config` holds approval/sandbox on `SessionConfiguration`
  // (not directly on Config). The reviewer-scoped TurnContext pulls
  // approval/sandbox from the parent sessionConfiguration during
  // `buildTurnContext`; the review delegate path overrides them there.
  // Documenting the indirection here so the contract is visible.

  // Freeze so callers cannot silently mutate.
  return Object.freeze(cloned);
}

// ─────────────────────────────────────────────────────────────────────
// AgenC one-shot review delegate
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the review-scoped `TurnContext` from the parent context +
 * reviewer overrides. Mirrors the inline turn-context assembly at
 * upstream `agenc-rs/core/src/session/review.rs:101-146`.
 *
 * Unlike upstream's hand-built `TurnContext { ... }` struct literal,
 * gut threads the overrides through `buildTurnContext` so the frozen-
 * config invariant + metadata state get the same treatment as every
 * other turn. The caller-visible difference: reviewer web/view-image
 * features are disabled (features call is inert because gut's
 * `ManagedFeatures` is functions-only — see RESERVED comment below),
 * and the reviewer system prompt is applied at call-site (the
 * delegate prepends a system message before the user prompt).
 */
function buildReviewTurnContext(
  parentCtx: AgenCDelegateTurnContextLike,
  reviewerModel: string,
  reviewerModelInfo: ModelInfo | undefined,
  reviewSubId: string,
  provider: LLMProvider = parentCtx.provider,
): TurnContext {
  const modelInfo: ModelInfo = reviewerModelInfo ?? {
    ...parentCtx.modelInfo,
    slug: reviewerModel,
  };
  // Reviewer-scoped SessionConfiguration derived from parent. The
  // reviewer must not surface the parent's user/developer
  // instructions (those are the author's context, not the reviewer's)
  // and must carry the reviewer-scoped `collaborationMode.model` +
  // review-forced `approvalPolicy: never` / `sandboxPolicy:
  // read_only`.
  const sc = {
    cwd: parentCtx.cwd,
    approvalPolicy: { value: "never" as const },
    sandboxPolicy: { value: "read_only" as const },
    fileSystemSandboxPolicy: parentCtx.fileSystemSandboxPolicy,
    networkSandboxPolicy: parentCtx.networkSandboxPolicy,
    windowsSandboxLevel: parentCtx.windowsSandboxLevel,
    collaborationMode: {
      model: reviewerModel,
      ...(parentCtx.collaborationMode.reasoningEffort !== undefined
        ? { reasoningEffort: parentCtx.collaborationMode.reasoningEffort }
        : modelInfo.defaultReasoningLevel !== undefined &&
            modelInfo.defaultReasoningLevel !== "none"
          ? { reasoningEffort: modelInfo.defaultReasoningLevel }
          : {}),
    },
    // Upstream zeroes developer_instructions / user_instructions for
    // the reviewer (session/review.rs:121-122). Preserve that contract.
    dynamicTools: [],
    sessionSource: parentCtx.sessionSource,
  };
  return buildTurnContext({
    conversationId: parentCtx.turnMetadataState.conversationId,
    subId: reviewSubId,
    config: parentCtx.config,
    modelInfo,
    provider,
    sessionConfiguration: sc,
    ...(parentCtx.authManager !== undefined
      ? { authManager: parentCtx.authManager }
      : {}),
    ...(parentCtx.environment !== undefined
      ? { environment: parentCtx.environment }
      : {}),
    ...(parentCtx.network !== undefined ? { network: parentCtx.network } : {}),
    jsRepl: parentCtx.jsRepl,
  });
}

async function resolveReviewerModelInfo(
  session: AgenCDelegateSessionLike,
  req: AgenCReviewOneShotRequest,
  reviewerModel: string,
): Promise<ModelInfo> {
  if (req.reviewerModelInfo !== undefined) {
    return req.reviewerModelInfo;
  }
  const modelsManager = session.services?.modelsManager;
  if (modelsManager !== undefined) {
    try {
      return await modelsManager.getModelInfo(reviewerModel, req.config);
    } catch {
      throw new ReviewerModelMismatchError(reviewerModel, session.provider.name);
    }
  }
  return {
    ...req.parentContext.modelInfo,
    slug: reviewerModel,
  };
}

export type AgenCDelegateOp =
  | { readonly type: "user_input"; readonly input: ReadonlyArray<LLMMessage> }
  | { readonly type: "interrupt"; readonly reason?: unknown }
  | { readonly type: "shutdown"; readonly reason?: unknown };

export interface AgenCDelegateThread {
  readonly childSession: Session;
  readonly rxEvent: AsyncQueue<Event>;
  readonly txSub: AsyncQueue<AgenCDelegateOp>;
  readonly agentStatus: BehaviorSubject<AgentStatus>;
  readonly completion: Promise<void>;
  shutdown(reason?: unknown): Promise<void>;
}

interface InternalDelegateThread extends AgenCDelegateThread {
  lastAssistantText(): string | null;
  error(): Error | null;
}

const DELEGATE_EVENT_QUEUE_DEPTH = 1_000;
const DELEGATE_SHUTDOWN_DRAIN_MS = 500;

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function asRealSession(session: AgenCDelegateSessionLike): Session | null {
  return session instanceof Session ? session : null;
}

function createDisabledToolRegistry(): ToolRegistry {
  return {
    tools: [],
    toLLMTools: () => [],
    dispatch: async (name: string) => ({
      content: `tool ${name} is unavailable in AgenC review delegates`,
      isError: true,
    }),
    getDiscoveredToolNames: () => [],
  } as unknown as ToolRegistry;
}

function createDelegateProvider(
  parentProvider: LLMProvider,
  reviewerModel: string,
  finalOutputJsonSchema?: unknown,
): LLMProvider {
  const structuredOutput =
    finalOutputJsonSchema !== undefined
      ? ({
          schema: finalOutputJsonSchema,
        } as LLMChatOptions["structuredOutput"])
      : undefined;
  let provider = parentProvider;
  const providerName = readProviderIdentity(parentProvider);
  if (providerName !== null) {
    try {
      provider = createProvider(providerName, {
        ...readProviderFactoryOptions(parentProvider),
        model: reviewerModel,
        tools: [],
        ...(finalOutputJsonSchema !== undefined
          ? { extra: { structuredOutput: finalOutputJsonSchema } }
          : {}),
      });
    } catch {
      provider = parentProvider;
    }
  }
  return {
    ...provider,
    name: provider.name,
    healthCheck: (...args: Parameters<LLMProvider["healthCheck"]>) =>
      provider.healthCheck(...args),
    chat: (messages, options) =>
      provider.chat(messages, {
        ...options,
        model: reviewerModel,
        tools: [],
        toolRouting: { allowedToolNames: [] },
        toolChoice: "none",
        parallelToolCalls: false,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      } as LLMChatOptions),
    chatStream: async (messages, onChunk, options) => {
      const mergedOptions = {
        ...options,
        model: reviewerModel,
        tools: [],
        toolRouting: { allowedToolNames: [] },
        toolChoice: "none",
        parallelToolCalls: false,
        ...(structuredOutput !== undefined ? { structuredOutput } : {}),
      } as LLMChatOptions;
      if (provider.chatStream.length < 3) {
        const response = await provider.chat(messages, mergedOptions);
        if (response.content.length > 0) {
          onChunk({ content: response.content, done: false });
        }
        return response;
      }
      return provider.chatStream(messages, onChunk, mergedOptions);
    },
  };
}

function buildChildSessionConfiguration(
  parentCtx: TurnContext,
  reviewerModel: string,
): SessionConfiguration {
  return {
    cwd: parentCtx.cwd,
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: parentCtx.fileSystemSandboxPolicy,
    networkSandboxPolicy: parentCtx.networkSandboxPolicy,
    windowsSandboxLevel: parentCtx.windowsSandboxLevel,
    collaborationMode: {
      model: reviewerModel,
      ...(parentCtx.collaborationMode.reasoningEffort !== undefined
        ? { reasoningEffort: parentCtx.collaborationMode.reasoningEffort }
        : {}),
    },
    dynamicTools: [],
    sessionSource: parentCtx.sessionSource,
  };
}

function buildChildServices(
  parent: Session,
  provider: LLMProvider,
): SessionServices {
  return {
    ...parent.services,
    provider,
    registry: createDisabledToolRegistry(),
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
    approvalResolver: parent.services.approvalResolver,
    permissionRequestHooks: parent.services.permissionRequestHooks,
  };
}

function shouldQueueDelegateEvent(event: Event): boolean {
  switch (event.msg.type) {
    case "session_configured":
    case "agent_message_delta":
    case "token_count":
      return false;
    default:
      return true;
  }
}

function shouldForwardEventToParent(event: Event): boolean {
  switch (event.msg.type) {
    case "exec_approval_request":
    case "request_permissions":
    case "mcp_tool_call_begin":
    case "mcp_tool_call_end":
      return true;
    default:
      return false;
  }
}

function messageText(message: LLMMessage): string {
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
    .filter((part) => part.length > 0)
    .join("\n");
}

function splitDelegateInput(
  req: AgenCReviewOneShotRequest,
): { readonly history: LLMMessage[]; readonly userMessage: string } {
  const input = [...(req.initialHistory ?? []), ...req.input];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const message = input[i];
    if (message?.role !== "user") continue;
    return {
      history: [...input.slice(0, i), ...input.slice(i + 1)],
      userMessage: messageText(message),
    };
  }
  return {
    history: input.slice(0, -1),
    userMessage: input.length > 0 ? messageText(input[input.length - 1]!) : "",
  };
}

export function spawnAgenCDelegateThread(
  parent: Session,
  req: AgenCReviewOneShotRequest,
  reviewerModel: string,
  reviewerModelInfo: ModelInfo,
  childController: AbortController,
): InternalDelegateThread {
  const provider = createDelegateProvider(
    parent.provider,
    reviewerModel,
    req.finalOutputJsonSchema,
  );
  const childSessionConfiguration = buildChildSessionConfiguration(
    req.parentContext,
    reviewerModel,
  );
  const childSession = new Session({
    conversationId: `${parent.conversationId}:review:${req.subId}`,
    roleWorkspace: parent.roleWorkspace,
    agentDefinitions: parent.agentDefinitions,
    initialState: {
      sessionConfiguration: childSessionConfiguration,
      history: [...(req.initialHistory ?? [])],
    },
    features: parent.features,
    services: buildChildServices(parent, provider),
    jsRepl: parent.jsRepl,
    config: req.config,
    modelInfo: reviewerModelInfo,
    agentStatus: { status: "pending_init" },
  });

  const rxEvent = new AsyncQueue<Event>({ maxDepth: DELEGATE_EVENT_QUEUE_DEPTH });
  const txSub = new AsyncQueue<AgenCDelegateOp>();
  let assistantText: string | null = null;
  let runError: Error | null = null;

  const unsubscribe = childSession.eventLog.subscribe((event) => {
    if (event.msg.type === "agent_message") {
      assistantText = event.msg.payload.message;
    }
    if (shouldQueueDelegateEvent(event)) {
      rxEvent.send(event);
    }
    if (shouldForwardEventToParent(event)) {
      parent.emit({
        id: req.subId,
        msg: event.msg,
      });
    }
  });

  const completion = (async () => {
    try {
      while (true) {
        const op = await txSub.recv();
        if (op === null || op.type === "shutdown") break;
        if (op.type === "interrupt") {
          if (!childController.signal.aborted) {
            childController.abort(op.reason ?? "interrupted");
          }
          await childSession.abortAllTasks("interrupted");
          continue;
        }

        const { history, userMessage } = splitDelegateInput({
          ...req,
          input: op.input,
        });
        const reviewCtx = buildReviewTurnContext(
          req.parentContext,
          reviewerModel,
          reviewerModelInfo,
          req.subId,
          provider,
        );
        for await (const phase of childSession.runTurn(userMessage, {
          ctx: reviewCtx,
          systemPrompt: req.systemPrompt ?? REVIEW_SYSTEM_PROMPT,
          history,
          signal: childController.signal,
          displayUserMessage: userMessage,
        })) {
          if (phase.type === "assistant_text") {
            assistantText = phase.content;
          } else if (
            phase.type === "turn_complete" &&
            "error" in phase &&
            phase.error instanceof Error
          ) {
            runError = phase.error;
          }
        }
        break;
      }
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    } finally {
      unsubscribe();
      rxEvent.close();
      txSub.close();
      await childSession.shutdown().catch(() => {});
    }
  })();

  return {
    childSession,
    rxEvent,
    txSub,
    agentStatus: childSession.agentStatus,
    completion,
    lastAssistantText: () => assistantText,
    error: () => runError,
    shutdown: async (reason?: unknown) => {
      if (!childController.signal.aborted) {
        childController.abort(reason ?? "shutdown");
      }
      txSub.send({ type: "interrupt", reason });
      txSub.send({ type: "shutdown", reason });
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DELEGATE_SHUTDOWN_DRAIN_MS);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    },
  };
}

/**
 * Runs a review through an isolated AgenC child Session and returns the
 * parsed one-shot outcome. Parent review task registration remains on
 * the parent session when requested; model sampling, events, tools, and
 * approval forwarding happen in the child delegate.
 */
export async function runAgenCReviewOneShot(
  session: AgenCDelegateSessionLike,
  req: AgenCReviewOneShotRequest,
): Promise<AgenCReviewOneShotOutcome> {
  // Reviewer-model resolution. Upstream consults ModelsManager before
  // spawning the child review session; AgenC mirrors that when the
  // live Session service bag is present and falls back to the parent
  // metadata shape only for slim test fixtures.
  const reviewerModel =
    (req.reviewerModel ?? req.parentContext.modelInfo.slug).trim();
  if (reviewerModel.length === 0) {
    throw new ReviewerModelMismatchError(reviewerModel, session.provider.name);
  }
  const reviewerModelInfo = await resolveReviewerModelInfo(
    session,
    req,
    reviewerModel,
  );
  const effectiveReviewerModel = reviewerModelInfo.slug.trim();
  if (effectiveReviewerModel.length === 0) {
    throw new ReviewerModelMismatchError(reviewerModel, session.provider.name);
  }
  const parentSession = asRealSession(session);
  if (parentSession === null) {
    throw new Error("AgenC review delegate requires a live Session parent");
  }

  const childController = new AbortController();
  const parentSignal = req.signal;
  let parentAbortListener: (() => void) | undefined;
  if (parentSignal) {
    if (parentSignal.aborted) {
      childController.abort(parentSignal.reason);
    } else {
      parentAbortListener = () => {
        childController.abort(parentSignal.reason);
      };
      parentSignal.addEventListener("abort", parentAbortListener, {
        once: true,
      });
    }
  }

  const task = req.registerTask === false
    ? undefined
    : await session.spawnTask({
        subId: req.subId,
        kind: "review",
        abortController: childController,
        startedAtMs: Date.now(),
      });

  let timeoutFired = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      childController.abort("timeout");
    }, req.timeoutMs);
  }

  let assistantText: string | null = null;
  let providerError: Error | null = null;
  let thread: InternalDelegateThread | null = null;
  try {
    if (!childController.signal.aborted) {
      thread = spawnAgenCDelegateThread(
        parentSession,
        req,
        effectiveReviewerModel,
        reviewerModelInfo,
        childController,
      );
      thread.txSub.send({ type: "user_input", input: req.input });
      await Promise.race([thread.completion, waitForAbort(childController.signal)]);
      assistantText = thread.lastAssistantText();
      providerError = thread.error();
    }
  } catch (err) {
    providerError = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (parentSignal && parentAbortListener !== undefined) {
      parentSignal.removeEventListener("abort", parentAbortListener);
    }
    if (thread !== null && !thread.rxEvent.isClosed) {
      await thread.shutdown("review_complete");
    }
  }

  // Verdict classification. Order matches upstream: timeout → abort
  // → provider error → parsed output. Timeout wins over generic
  // abort so the UI can surface the more-specific reason.
  let verdict: AgenCReviewOneShotOutcome["verdict"];
  let output: ReviewOutput;
  let error: Error | null = null;
  if (timeoutFired) {
    verdict = "timeout";
    output = emptyReviewOutput();
    error = new Error("review timed out");
  } else if (childController.signal.aborted && assistantText === null) {
    verdict = "aborted";
    output = emptyReviewOutput();
    const reason = childController.signal.reason;
    error =
      reason instanceof Error
        ? reason
        : new Error(
            typeof reason === "string" && reason.length > 0
              ? reason
              : "aborted",
          );
  } else if (providerError !== null && assistantText === null) {
    // Provider failed without returning any content. Classify as a
    // "fail" verdict (the review could not complete), surface the
    // typed error in `error` so the caller can telemetry-route.
    verdict = "fail";
    output = emptyReviewOutput();
    error = providerError;
  } else {
    output = assistantText !== null ? parseReviewOutput(assistantText) : emptyReviewOutput();
    if (output.findings.length > 0) {
      verdict = "fail"; // findings present → reviewer flagged issues
    } else if (output.overallExplanation.trim().length === 0) {
      verdict = "partial"; // nothing useful came back
    } else {
      verdict = "pass"; // reviewer had something to say but no findings
    }
  }

  // Emit the `exit_review_mode` event on every termination path so
  // consumers do not have to reconcile "did the task emit the event
  // or did I need to emit it myself". Upstream emits from
  // `tasks/review.rs::exit_review_mode` (`tasks/review.rs:213-283`)
  // including the rollout record; AgenC mirrors that by persisting the
  // synthetic review user/assistant records before the exit event.
  const exitPayload: ExitReviewModePayload = {
    subId: req.subId,
    reason:
      verdict === "timeout"
        ? "timeout"
        : verdict === "aborted"
          ? "aborted"
          : "completed",
    reviewOutput: output,
    modelUsed: effectiveReviewerModel,
    request: req.request,
  };
  if (req.recordExitRollout ?? req.registerTask !== false) {
    await recordReviewExitRollout(session, exitPayload);
  }
  session.sendEvent(req.subId, {
    type: "exit_review_mode",
    payload: exitPayload,
  });

  // Drain the task from the session registry. Upstream
  // `SessionTaskContext::on_task_finished` fires after `ReviewTask::run`
  // returns; gut's `Session.onTaskFinished` clears the activeTurn
  // slot when the task registry empties. `void`-await is fine because
  // the lifecycle awaits `task.done` elsewhere (graceful interruption
  // path); we resolve `done` here by explicitly finishing.
  if (task !== undefined) {
    await session.onTaskFinished(task.subId);
  }

  return {
    verdict,
    output,
    rawText: assistantText,
    modelUsed: effectiveReviewerModel,
    error,
  };
}

// ─────────────────────────────────────────────────────────────────────
// exit_review_mode event payload
// ─────────────────────────────────────────────────────────────────────

/**
 * Upstream agenc runtime `ExitedReviewModeEvent`
 * (`protocol/src/protocol.rs:2157-2159`). Carries the review output
 * so the UI can render results; gut adds the termination `reason`
 * and the `modelUsed` for telemetry + a compact `subId` for event
 * correlation.
 *
 * `reason` values:
 *   - `"completed"` — reviewer produced output; `reviewOutput` is the
 *     structured findings + explanation.
 *   - `"timeout"` — the `timeoutMs` budget elapsed.
 *   - `"aborted"` — parent abort signal fired (session teardown,
 *     session.abortAllTasks, user interrupt).
 */
export interface ExitReviewModePayload {
  readonly subId: string;
  readonly reason: "completed" | "timeout" | "aborted";
  readonly reviewOutput: ReviewOutput;
  readonly modelUsed: string;
  readonly request: ReviewRequest;
}
