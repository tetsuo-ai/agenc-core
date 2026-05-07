/**
 * run-turn — orchestration for one user turn.
 *
 * Port of agenc runtime `core/src/session/turn.rs` (2,230 LOC). The outer
 * orchestration shape follows agenc runtime `run_turn` line-for-line; the
 * per-iteration body delegates to AgenC's 6-phase machine
 * (`runtime/src/phases/`) which in turn ports AgenC's query.ts.
 *
 * agenc runtime → AgenC call-graph mapping:
 *
 *   run_turn()                         → runTurn()
 *   run_pre_sampling_compact()         → runPreSamplingCompact()
 *   maybe_run_previous_model_inline_compact() → maybeRunPreviousModelInlineCompact()
 *   run_auto_compact()                 → runAutoCompact()
 *   build_prompt()                     → buildPrompt()
 *   run_sampling_request()             → runSamplingRequest()
 *   try_run_sampling_request()         → tryRunSamplingRequest()
 *   drain_in_flight()                  → drainInFlight()
 *   built_tools()                      → builtTools()
 *   get_last_assistant_message_from_turn() → getLastAssistantMessageFromTurn()
 *
 * Forward-dep subsystems that the ported methods call into route
 * through `SessionServices` placeholder interfaces (session.ts:327).
 * Placeholders return sensible defaults today; T6/T7/T8/T9/T10/T11/T13
 * land the real subsystems and the call sites upgrade without
 * touching this file.
 *
 * Invariants honored here:
 *   I-7  (terminal abort) — merged AbortController observed at top of
 *        loop + propagated to phase calls.
 *   I-13 (pending provider/model switch) — checked between turns;
 *        triggers maybeRunPreviousModelInlineCompact before next turn.
 *   I-22 (token budget) — pending decision stashed on TurnState is
 *        acted on at commit; mid-turn overshoot aborts cleanly.
 *   I-30 (config snapshot per-turn-immutable) — TurnContext is built
 *        once and passed by reference throughout.
 *   I-42 (recovery re-entry cap) — transition field consulted between
 *        iterations; cap lives on TurnState (T8 wires the logic).
 *
 * @module
 */

import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMMessageValidationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../llm/errors.js";
import type {
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  LLMTool,
  LLMUsage,
} from "../llm/types.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import { safeStringify } from "../tools/types.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../constants/toolLimits.js";
import type { CompactionResult, RuntimeMessage } from "../services/compact/types.js";
import { startCodeModeTurnWorker } from "../tools/code-mode/turn-host.js";
import { commit } from "../phases/commit.js";
import { continuationNudge } from "../phases/continuation-nudge.js";
import type { PhaseEvent } from "../phases/events.js";
import { executeTools } from "../phases/execute-tools.js";
import { drainPendingExtraction } from "../services/extractMemories/extractMemories.js";
import { runMagicDocsPostSamplingHook } from "../services/MagicDocs/magicDocs.js";
import { runSessionMemoryPostSamplingHook } from "../memory/session/sessionMemory.js";
import { postSampleRecovery } from "../phases/post-sample-recovery.js";
import { getAttachments } from "../prompts/attachments/orchestrator.js";
import { attachmentsToMessages } from "../prompts/attachments/messages.js";
import { extractMentionAllowedRoots } from "../prompts/file-mentions.js";
import {
  realtimeEndInstructionMessage,
  realtimeStartInstructionMessage,
  realtimeStartWithInstructionsMessage,
} from "../conversation/realtime/instructions/messages.js";
import {
  getModelInstructions,
  modelSupportsPersonality,
  normalizePersonality,
  personalityMessageForModel,
  personalitySpecInstructionMessage,
  type Personality,
} from "../context/personality-spec-instructions.js";
import {
  streamModel,
  StreamModelError,
  type StreamModelRequestContract,
} from "../phases/stream-model.js";
import { isTransientProviderError } from "../recovery/api-errors.js";
import { reconnectWithBackoff } from "../recovery/reconnection.js";
import { reserveRecoveryReentry } from "../recovery/fallback-ladder.js";
import * as planModeHelpers from "./plan-mode.js";
import type { CompactedItem, ResponseItem } from "./rollout-item.js";
import type { Session } from "./session.js";
import {
  modelContextWindow,
  TurnTimingState,
  toTurnContextItem,
  type TurnContext,
  type TurnContextItem,
} from "./turn-context.js";
import type {
  SessionTask,
  SessionTaskAbortContext,
  SessionTaskRunContext,
  RunningTask,
} from "./tasks.js";
import { emitError } from "./event-log.js";
import {
  buildInitialTurnState,
  resetIterationFields,
  type AssistantMessage,
  type Continue,
  type Terminal,
  type TurnState,
} from "./turn-state.js";
import {
  AGENC_COMPACT_CALL_METRIC,
  AGENC_COMPACT_DURATION_METRIC,
  AGENC_TURN_TTFM_DURATION_METRIC,
  AGENC_TURN_TTFT_DURATION_METRIC,
  agencTelemetry,
  toMetricTags,
} from "../observability/telemetry.js";

export interface RunTurnOptions {
  readonly systemPrompt?: string;
  readonly history?: readonly LLMMessage[];
  readonly signal?: AbortSignal;
  /**
   * Optional transcript-facing text when the model-visible prompt was
   * expanded. `null` suppresses the user-message transcript event for
   * internal meta turns such as autonomous keepalive ticks.
   */
  readonly displayUserMessage?: string | null;
}

class RegularTurnTask implements SessionTask {
  kind(): "regular" {
    return "regular";
  }

  spanName(): string {
    return "session_task.regular";
  }

  async run(_ctx: SessionTaskRunContext): Promise<null> {
    // The current AgenC run-turn surface is an AsyncGenerator so the
    // task body is driven by `runTurnKernelInner` below. The task
    // object still owns the lifecycle metadata and abort hook so
    // `Session.handleTaskAbort` can dispatch through the same concrete
    // task interface as agenc runtime.
    return null;
  }

  async abort(_ctx: SessionTaskAbortContext): Promise<void> {
    // Regular turns observe cancellation via the merged AbortSignal in
    // the phase loop. No extra teardown is needed at the task object
    // boundary today.
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function recordTurnTimingForPhaseEvent(
  ctx: TurnContext,
  event: PhaseEvent,
): void {
  ensureTurnTimingState(ctx);
  const tags = toMetricTags({ turn_id: ctx.subId, event: event.type });
  const ttftMs = ctx.turnTimingState.recordTtftForPhaseEvent(event);
  if (ttftMs !== undefined) {
    agencTelemetry.recordDuration(
      AGENC_TURN_TTFT_DURATION_METRIC,
      ttftMs,
      tags,
    );
  }
  if (event.type === "assistant_text") {
    const ttfmMs = ctx.turnTimingState.recordTtfmForAssistantText(
      event.content,
    );
    if (ttfmMs !== undefined) {
      agencTelemetry.recordDuration(
        AGENC_TURN_TTFM_DURATION_METRIC,
        ttfmMs,
        tags,
      );
    }
  }
}

function ensureTurnTimingState(ctx: TurnContext): TurnTimingState {
  if (ctx.turnTimingState !== undefined) return ctx.turnTimingState;
  const timingState = new TurnTimingState();
  (ctx as { turnTimingState: TurnTimingState }).turnTimingState = timingState;
  return timingState;
}

const MAX_PLAN_TOOL_REQUIRED_RETRIES = 2;
const AUTOCOMPACT_NOTICE_BUFFER_TOKENS = 13_000;
const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);


interface AgenCModelContext {
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

function toAgenCModelContext(ctx: TurnContext): AgenCModelContext {
  const contextWindowTokens = modelContextWindow(ctx) ?? ctx.modelInfo.contextWindow;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    throw new Error(`Missing context window for model ${ctx.modelInfo.slug}`);
  }
  return {
    model: ctx.modelInfo.slug,
    contextWindowTokens,
    ...(ctx.modelInfo.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.modelInfo.maxOutputTokens }
      : {}),
  };
}



interface AgenCToolUseContext {
  readonly abortController: AbortController;
  readonly agentId?: string;
  readonly sessionId: string;
  readonly options: {
    readonly mainLoopModel: string;
    readonly tools: readonly AgenCRuntimeTool[];
    readonly mcpClients: readonly unknown[];
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly providerOverride?: {
      readonly model: string;
      readonly baseURL: string;
      readonly apiKey: string;
    };
    readonly querySource?: string;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly isNonInteractiveSession: boolean;
    readonly cwd?: string;
    readonly verbose: boolean;
  };
  readonly getAppState: () => {
    readonly toolPermissionContext: unknown;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly tasks: Record<string, unknown>;
  };
  readonly readFileState: Map<string, unknown>;
  readonly loadedNestedMemoryPaths: Set<string>;
  readonly setStreamMode: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength: (updater: (length: number) => number) => void;
  readonly onCompactProgress: (event: unknown) => void;
  readonly setSDKStatus: (status: "compacting" | null) => void;
  readonly addNotification: (notification: unknown) => void;
  readonly emitWarning: (warning: { readonly cause: string; readonly message: string }) => void;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly clearProviderResponseId: () => void;
  readonly rolloutStore?: unknown;
  readonly session?: { readonly rolloutStore?: unknown };
  readonly provider?: LLMProvider;
  readonly cwd?: string;
}

type AgenCRuntimeTool = LLMTool & {
  readonly name: string;
  readonly description: string;
  readonly inputJSONSchema: Record<string, unknown>;
  readonly isMcp: boolean;
  readonly maxResultSizeChars: number;
};

function buildAgenCToolUseContext(
  session: Session,
  ctx: TurnContext,
  opts: { readonly querySource?: string; readonly verbose?: boolean } = {},
): AgenCToolUseContext {
  const model = toAgenCModelContext(ctx);
  const providerOverride = buildProviderOverride(session, model.model);
  const surface = readSessionSurface(session);
  const agentDefinitions = {
    activeAgents: Array.isArray(surface.agentDefinitions?.activeAgents)
      ? [...surface.agentDefinitions.activeAgents]
      : [],
  };
  const cwd = ctx.cwd;
  return {
    abortController: session.abortController ?? new AbortController(),
    sessionId: session.conversationId,
    options: {
      mainLoopModel: model.model,
      tools: toAgenCRuntimeTools(session.services.registry.toLLMTools()),
      mcpClients: Array.isArray(surface.mcpClients) ? surface.mcpClients : [],
      contextWindowTokens: model.contextWindowTokens,
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(providerOverride !== undefined ? { providerOverride } : {}),
      ...(opts.querySource !== undefined ? { querySource: opts.querySource } : {}),
      agentDefinitions,
      isNonInteractiveSession: false,
      cwd,
      verbose: opts.verbose ?? false,
    },
    getAppState: () => ({
      toolPermissionContext:
        session.permissionModeRegistry?.current?.() ??
        session.services.permissionModeRegistry?.current?.() ??
        createEmptyToolPermissionContext(),
      agentDefinitions,
      tasks: surface.tasks ?? {},
    }),
    readFileState: surface.readFileState ?? new Map<string, unknown>(),
    loadedNestedMemoryPaths:
      surface.loadedNestedMemoryPaths ?? new Set<string>(),
    setStreamMode: surface.setStreamMode ?? (() => {}),
    setResponseLength: surface.setResponseLength ?? (() => {}),
    onCompactProgress: surface.onCompactProgress ?? (() => {}),
    setSDKStatus: surface.setSDKStatus ?? (() => {}),
    addNotification: surface.addNotification ?? (() => {}),
    emitWarning:
      surface.emitWarning ??
      ((warning) => {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: warning,
          },
        });
      }),
    ...(surface.queryTracking !== undefined
      ? { queryTracking: surface.queryTracking }
      : {}),
    clearProviderResponseId: () => session.clearProviderResponseId(),
    ...(session.rolloutStore !== undefined ? { rolloutStore: session.rolloutStore } : {}),
    ...(session.rolloutStore !== undefined
      ? { session: { rolloutStore: session.rolloutStore } }
      : {}),
    provider: session.services.provider,
    cwd,
  };
}

function toAgenCRuntimeTools(tools: readonly LLMTool[]): AgenCRuntimeTool[] {
  return tools.map((tool) => {
    const name = tool.function.name;
    return {
      ...tool,
      name,
      description: tool.function.description,
      inputJSONSchema: tool.function.parameters,
      isMcp: name.startsWith("mcp__"),
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    };
  });
}

function buildProviderOverride(
  session: Session,
  fallbackModel: string,
): AgenCToolUseContext["options"]["providerOverride"] | undefined {
  const provider = session.services.provider;
  const options = readProviderFactoryOptions(provider);
  const model = firstNonEmpty(options.model, fallbackModel);
  const baseURL = firstNonEmpty(options.baseURL);
  if (!model || !baseURL) return undefined;
  return {
    model,
    baseURL,
    apiKey: options.apiKey ?? "",
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

type SessionSurface = {
  readonly readFileState?: Map<string, unknown>;
  readonly loadedNestedMemoryPaths?: Set<string>;
  readonly mcpClients?: readonly unknown[];
  readonly agentDefinitions?: { readonly activeAgents?: readonly unknown[] };
  readonly tasks?: Record<string, unknown>;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength?: (updater: (length: number) => number) => void;
  readonly onCompactProgress?: (event: unknown) => void;
  readonly setSDKStatus?: (status: "compacting" | null) => void;
  readonly addNotification?: (notification: unknown) => void;
  readonly emitWarning?: (warning: { readonly cause: string; readonly message: string }) => void;
};

function readSessionSurface(session: Session): SessionSurface {
  const snapshot = session.state.unsafePeek() as unknown as Record<string, unknown>;
  const direct = session as unknown as Record<string, unknown>;
  const read = <T>(key: keyof SessionSurface): T | undefined => {
    const directValue = direct[key];
    if (directValue !== undefined) return directValue as T;
    const snapshotValue = snapshot[key];
    if (snapshotValue !== undefined) return snapshotValue as T;
    return undefined;
  };
  return {
    readFileState: read<Map<string, unknown>>("readFileState"),
    loadedNestedMemoryPaths: read<Set<string>>("loadedNestedMemoryPaths"),
    mcpClients: read<readonly unknown[]>("mcpClients"),
    agentDefinitions:
      read<{ readonly activeAgents?: readonly unknown[] }>("agentDefinitions"),
    tasks: read<Record<string, unknown>>("tasks"),
    queryTracking: read<{ readonly chainId?: string; readonly depth?: number }>(
      "queryTracking",
    ),
    setStreamMode:
      read<(mode: "requesting" | "responding" | null) => void>("setStreamMode"),
    setResponseLength:
      read<(updater: (length: number) => number) => void>("setResponseLength"),
    onCompactProgress: read<(event: unknown) => void>("onCompactProgress"),
    setSDKStatus: read<(status: "compacting" | null) => void>("setSDKStatus"),
    addNotification: read<(notification: unknown) => void>("addNotification"),
    emitWarning:
      read<(warning: { readonly cause: string; readonly message: string }) => void>(
        "emitWarning",
      ),
  };
}



const AGENC_COMPACT_BOUNDARY = "<compact>";
const PREPARED_TERMINAL = Symbol("agenc_prepared_terminal");
const COMPACT_CONTEXT_GUARD_ENV = [
  "AGENC_USE_OPENAI",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW",
] as const;

interface AgenCPreparedTerminal {
  readonly terminal: Terminal;
  readonly assistantMessage: AssistantMessage;
}

type PreparedState = TurnState & {
  [PREPARED_TERMINAL]?: AgenCPreparedTerminal;
};

interface AgenCAutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: {
    readonly message: string;
    readonly replacementHistory: readonly LLMMessage[];
    readonly preCompactTokens?: number;
    readonly postCompactTokens?: number;
  };
  readonly consecutiveFailures?: number;
}

type AgenCMessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

interface AgenCMessage {
  readonly role: AgenCMessageRole;
  readonly content: string | readonly LLMContentPart[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: string;
}

type AgenCRuntimeWireRole = NonNullable<RuntimeMessage["role"]>;

type AgenCRuntimeMessage = Omit<
  RuntimeMessage,
  "role" | "originalRole" | "message"
> & {
  readonly role?: AgenCRuntimeWireRole;
  readonly originalRole?: AgenCMessage["role"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string }[];
  readonly phase?: string;
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
};

type AgenCCompactionResult = {
  readonly boundaryMarker?: AgenCRuntimeMessage;
  readonly summaryMessages?: readonly AgenCRuntimeMessage[];
  readonly messagesToKeep?: readonly AgenCRuntimeMessage[];
  readonly attachments?: readonly AgenCRuntimeMessage[];
  readonly hookResults?: readonly AgenCRuntimeMessage[];
  readonly userDisplayMessage?: string;
  readonly preCompactTokenCount?: number;
  readonly postCompactTokenCount?: number;
  readonly truePostCompactTokenCount?: number;
};

type CompactGuardEnv = Partial<Record<(typeof COMPACT_CONTEXT_GUARD_ENV)[number], string>>;

async function prepareAgenCTurnContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<void> {
  delete (state as PreparedState)[PREPARED_TERMINAL];
  if (signal?.aborted) return;
  toAgenCModelContext(ctx);
  const messages = messagesAfterAgenCBoundary(state.messages);
  const toolUseContext = buildAgenCToolUseContext(session, ctx, {
    querySource: "repl_main_thread",
  });
  try {
    const prepared = await prepareAgenCQueryMessages({
      messages,
      toolUseContext,
      querySource: "repl_main_thread",
      applyContextCollapse: isAgenCContextCollapseRequested(),
    });
    state.messagesForQuery = prepared.messages;
    state.snipTokensFreed = prepared.snipTokensFreed;
    if (prepared.committed) {
      state.messages = [...state.messagesForQuery];
    }
  } catch {
    state.messagesForQuery = messages.map(cloneLLMMessage);
    state.snipTokensFreed = 0;
  }
}

function getAgenCPreparedTerminal(
  state: TurnState,
): AgenCPreparedTerminal | undefined {
  return (state as PreparedState)[PREPARED_TERMINAL];
}

async function runAgenCAutoCompact(params: {
  readonly session?: Session;
  readonly ctx?: TurnContext;
  readonly state?: TurnState;
  readonly querySource?: string;
  readonly reason?: string;
  readonly phase?: string;
  readonly initialContextInjection?: string;
}): Promise<AgenCAutoCompactResult> {
  const finishTelemetry = startCompactTelemetry("auto", {
    query_source: params.querySource,
    reason: params.reason,
    phase: params.phase,
  });
  if (!params.session || !params.ctx || !params.state) {
    finishTelemetry("not_configured");
    return compactionNotRun();
  }
  try {
    const state = params.state;
    const sourceMessages =
      state.messagesForQuery.length > 0
        ? state.messagesForQuery
        : state.messages;
    const messages = toAgenCRuntimeMessages(sourceMessages);
    const toolUseContext = buildAgenCToolUseContext(
      params.session,
      params.ctx,
      { querySource: params.querySource },
    );
    const cacheSafeParams = {
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext,
      forkContextMessages: messages,
    };
    const result = await withCompactContextGuards(async () => {
      const { autoCompactIfNeeded } =
        await import("../services/compact/autoCompact.js");
      return autoCompactIfNeeded(
        messages,
        toolUseContext,
        cacheSafeParams,
        params.querySource,
        state.autoCompactTracking,
        state.snipTokensFreed ?? 0,
      );
    }, envForToolUseContext(toolUseContext));
    if (!result.wasCompacted || !result.compactionResult) {
      finishTelemetry("skipped", {
        consecutive_failures: result.consecutiveFailures,
      });
      return compactionNotRun(result.consecutiveFailures);
    }
    params.session.clearProviderResponseId();
    const compactionResult = await toAgenCCompactionResult(
      result.compactionResult as AgenCCompactionResult,
    );
    finishTelemetry("compacted", {
      consecutive_failures: result.consecutiveFailures,
    });
    return {
      wasCompacted: true,
      compactionResult,
      ...(result.consecutiveFailures !== undefined
        ? { consecutiveFailures: result.consecutiveFailures }
        : {}),
    };
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

function buildAgenCCompactedRolloutItem(
  result: NonNullable<AgenCAutoCompactResult["compactionResult"]>,
) {
  return buildCompactedRolloutPayload({
    message: result.message,
    replacementHistory: result.replacementHistory,
    preCompactTokens: result.preCompactTokens,
    postCompactTokens: result.postCompactTokens,
  });
}

function buildAgenCPostCompactMessages(
  result: NonNullable<AgenCAutoCompactResult["compactionResult"]>,
): LLMMessage[] {
  return result.replacementHistory.map((message) => ({ ...message }));
}

function toAgenCMessage(message: LLMMessage): AgenCMessage {
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

function buildCompactedRolloutPayload(params: {
  readonly message: string;
  readonly replacementHistory?: readonly LLMMessage[];
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}): CompactedItem {
  return {
    message: params.message,
    ...(params.replacementHistory !== undefined
      ? { replacementHistory: params.replacementHistory.map(toResponseItem) }
      : {}),
    ...(params.preCompactTokens !== undefined
      ? { preCompactTokens: params.preCompactTokens }
      : {}),
    ...(params.postCompactTokens !== undefined
      ? { postCompactTokens: params.postCompactTokens }
      : {}),
  };
}

function messagesAfterAgenCBoundary(
  messages: readonly LLMMessage[],
): LLMMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(AGENC_COMPACT_BOUNDARY)
    ) {
      return messages.slice(index + 1).map((item) => ({ ...item }));
    }
  }
  return messages.map((item) => ({ ...item }));
}

async function prepareAgenCQueryMessages(params: {
  readonly messages: readonly LLMMessage[];
  readonly toolUseContext: AgenCToolUseContext;
  readonly querySource: string;
  readonly applyContextCollapse: boolean;
}): Promise<{
  readonly messages: LLMMessage[];
  readonly snipTokensFreed: number;
  readonly committed: boolean;
}> {
  const finishTelemetry = startCompactTelemetry("prepare_query", {
    query_source: params.querySource,
    context_collapse: params.applyContextCollapse,
  });
  try {
    const result = await withCompactContextGuards(async () => {
      let messages = toAgenCRuntimeMessages(params.messages);
      const budgeted = await applyToolResultBudget(
        messages,
      );
      messages = budgeted.messages as AgenCRuntimeMessage[];
      const { microcompactMessages } =
        await import("../services/compact/microCompact.js");
      const microcompactResult = await microcompactMessages(
        messages,
        params.toolUseContext,
        params.querySource,
      );
      messages = microcompactResult.messages as AgenCRuntimeMessage[];
      let committed = false;
      if (params.applyContextCollapse) {
        const projected = await applyCollapsesIfNeeded(
          messages,
        );
        messages = projected.messages as AgenCRuntimeMessage[];
        committed = projected.committed > 0;
      }
      return {
        messages: fromAgenCRuntimeMessages(messages),
        snipTokensFreed: 0,
        committed,
      };
    }, envForToolUseContext(params.toolUseContext));
    finishTelemetry(result.committed ? "committed" : "unchanged");
    return {
      messages: result.messages,
      snipTokensFreed: result.snipTokensFreed,
      committed: result.committed,
    };
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

async function applyToolResultBudget(
  messages: RuntimeMessage[],
): Promise<{
  readonly messages: RuntimeMessage[];
  readonly newlyReplaced: readonly unknown[];
}> {
  return { messages, newlyReplaced: [] };
}

async function applyCollapsesIfNeeded(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[]; readonly committed: number }> {
  return { messages, committed: 0 };
}

function startCompactTelemetry(
  mode: string,
  attributes: Readonly<Record<string, unknown>> = {},
): (status: string, additionalAttributes?: Readonly<Record<string, unknown>>) => void {
  const baseTags = toMetricTags({ mode, ...attributes });
  const timer = agencTelemetry.timer(AGENC_COMPACT_DURATION_METRIC, baseTags);
  let finished = false;
  return (
    status: string,
    additionalAttributes: Readonly<Record<string, unknown>> = {},
  ) => {
    if (finished) return;
    finished = true;
    const tags = toMetricTags({ mode, ...attributes, status, ...additionalAttributes });
    agencTelemetry.counter(AGENC_COMPACT_CALL_METRIC, 1, tags);
    timer.end(tags);
  };
}

async function toAgenCCompactionResult(
  result: AgenCCompactionResult,
  toolUseContext?: AgenCToolUseContext,
): Promise<NonNullable<AgenCAutoCompactResult["compactionResult"]>> {
  const replacementHistory = await withCompactContextGuards(async () => {
    const { buildPostCompactMessages } =
      await import("../services/compact/compact.js");
    return fromAgenCRuntimeMessages(
      buildPostCompactMessages(toCompactServiceResult(result)) as AgenCRuntimeMessage[],
    );
  }, toolUseContext ? envForToolUseContext(toolUseContext) : undefined);
  const postCompactTokens =
    result.truePostCompactTokenCount ?? result.postCompactTokenCount;
  return {
    message:
      result.userDisplayMessage ??
      extractMessageText(result.summaryMessages?.at(-1)) ??
      "Conversation compacted",
    replacementHistory,
    ...(result.preCompactTokenCount !== undefined
      ? { preCompactTokens: result.preCompactTokenCount }
      : {}),
    ...(postCompactTokens !== undefined ? { postCompactTokens } : {}),
  };
}

function toCompactServiceResult(result: AgenCCompactionResult): CompactionResult {
  if (!result.boundaryMarker) {
    throw new Error("Compaction result is missing its boundary marker");
  }
  return {
    boundaryMarker: result.boundaryMarker,
    summaryMessages: result.summaryMessages ?? [],
    attachments: result.attachments ?? [],
    hookResults: result.hookResults ?? [],
    ...(result.messagesToKeep !== undefined
      ? { messagesToKeep: result.messagesToKeep }
      : {}),
    ...(result.userDisplayMessage !== undefined
      ? { userDisplayMessage: result.userDisplayMessage }
      : {}),
    ...(result.preCompactTokenCount !== undefined
      ? { preCompactTokenCount: result.preCompactTokenCount }
      : {}),
    ...(result.postCompactTokenCount !== undefined
      ? { postCompactTokenCount: result.postCompactTokenCount }
      : {}),
    ...(result.truePostCompactTokenCount !== undefined
      ? { truePostCompactTokenCount: result.truePostCompactTokenCount }
      : {}),
  };
}

function toAgenCRuntimeMessages(
  messages: readonly LLMMessage[],
): AgenCRuntimeMessage[] {
  return messages.map((message, index) => {
    const converted = toAgenCMessage(message);
    const runtimeContent = toRuntimeMessageContent(message.content);
    if (message.role === "system") {
      return {
        ...converted,
        role: "system",
        type: "system",
        content: runtimeContent,
        uuid: `agenc-system-${index}`,
        timestamp: new Date(0).toISOString(),
      };
    }
    const role = toAgenCRuntimeWireRole(message.role);
    return {
      ...converted,
      content: runtimeContent,
      role,
      ...(message.role !== role ? { originalRole: message.role } : {}),
      type: role,
      message: {
        role,
        content: runtimeContent,
      },
      uuid: `agenc-${role}-${index}`,
      timestamp: new Date(0).toISOString(),
      ...(message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
            })),
          }
        : {}),
      ...(message.role === "tool" ? { isMeta: true } : {}),
    };
  });
}

function toAgenCRuntimeWireRole(role: LLMMessage["role"]): AgenCRuntimeWireRole {
  if (role === "tool") return "user";
  if (role === "developer") return "system";
  return role;
}

function fromAgenCRuntimeMessages(
  messages: readonly AgenCRuntimeMessage[],
): LLMMessage[] {
  return messages
    .map(fromAgenCRuntimeMessage)
    .filter((message): message is LLMMessage => message !== null);
}

function fromAgenCRuntimeMessage(
  message: AgenCRuntimeMessage,
): LLMMessage | null {
  if (message.role && message.content !== undefined) {
    const role = message.originalRole ?? message.role;
    return {
      role,
      content: fromRuntimeMessageContent(message.content),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.phase === "commentary" || message.phase === "final_answer"
        ? { phase: message.phase }
        : {}),
    };
  }
  const role = normalizeRole(message.message?.role ?? message.type);
  if (!role) return null;
  return {
    role,
    content: fromRuntimeMessageContent(readContent(message)),
  };
}

function normalizeRole(value: unknown): LLMMessage["role"] | null {
  if (
    value === "system" ||
    value === "developer" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }
  return null;
}

function readContent(
  message: AgenCRuntimeMessage,
): LLMMessage["content"] {
  const content = message.message?.content ?? message.content ?? "";
  return cloneContent(content);
}

function extractMessageText(
  message: AgenCRuntimeMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  const content = readContent(message);
  if (typeof content === "string") return content;
  const text = content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function cloneDocumentContentPart(item: object): LLMContentPart | null {
  const record = item as Record<string, unknown>;
  if (record.type !== "document") return null;
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;
  if (
    source?.type !== "base64" ||
    source.media_type !== "application/pdf" ||
    typeof source.data !== "string" ||
    source.data.length === 0
  ) {
    return null;
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: source.data,
    },
    ...(typeof record.title === "string" && record.title.length > 0
      ? { title: record.title }
      : {}),
    ...(typeof record.filename === "string" && record.filename.length > 0
      ? { filename: record.filename }
      : {}),
    ...(typeof record.fallbackText === "string"
      ? { fallbackText: record.fallbackText }
      : {}),
    ...(typeof record.fallbackTextTruncated === "boolean"
      ? { fallbackTextTruncated: record.fallbackTextTruncated }
      : {}),
    ...(typeof record.fallbackTextError === "string" &&
    record.fallbackTextError.length > 0
      ? { fallbackTextError: record.fallbackTextError }
      : {}),
  };
}

function cloneContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: LLMContentPart[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const document = cloneDocumentContentPart(item);
      if (document !== null) {
        parts.push(document);
        continue;
      }
      if (
        "type" in item &&
        item.type === "image_url" &&
        "image_url" in item &&
        item.image_url &&
        typeof item.image_url === "object" &&
        "url" in item.image_url &&
        typeof item.image_url.url === "string"
      ) {
        parts.push({
          type: "image_url",
          image_url: { url: item.image_url.url },
        });
        continue;
      }
      if ("text" in item && typeof item.text === "string") {
        parts.push({ type: "text", text: item.text });
      }
    }
    return parts;
  }
  return "";
}

function toRuntimeMessageContent(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    if (!item || typeof item !== "object") return { type: "text", text: "" };
    const document = cloneDocumentContentPart(item);
    if (document !== null) return document;
    if (
      "type" in item &&
      item.type === "image_url" &&
      "image_url" in item &&
      item.image_url &&
      typeof item.image_url === "object" &&
      "url" in item.image_url &&
      typeof item.image_url.url === "string"
    ) {
      return {
        type: "image",
        source: { type: "url", url: item.image_url.url },
      };
    }
    if ("text" in item && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    return { ...item };
  });
}

function fromRuntimeMessageContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: LLMContentPart[] = [];
  let textOnly = true;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const document = cloneDocumentContentPart(item);
    if (document !== null) {
      textOnly = false;
      parts.push(document);
      continue;
    }
    if (
      "type" in item &&
      item.type === "image" &&
      "source" in item &&
      item.source &&
      typeof item.source === "object" &&
      "url" in item.source &&
      typeof item.source.url === "string"
    ) {
      textOnly = false;
      parts.push({
        type: "image_url",
        image_url: { url: item.source.url },
      });
      continue;
    }
    if (
      "type" in item &&
      item.type === "image_url" &&
      "image_url" in item &&
      item.image_url &&
      typeof item.image_url === "object" &&
      "url" in item.image_url &&
      typeof item.image_url.url === "string"
    ) {
      textOnly = false;
      parts.push({
        type: "image_url",
        image_url: { url: item.image_url.url },
      });
      continue;
    }
    if ("text" in item && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    }
  }
  if (textOnly) {
    return parts.map((part) => part.type === "text" ? part.text : "").join("\n");
  }
  return parts;
}

function compactionNotRun(
  consecutiveFailures?: number,
): AgenCAutoCompactResult {
  return {
    wasCompacted: false,
    ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
  };
}

function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneContent(message.content),
  };
}

async function withCompactContextGuards<T>(
  fn: () => Promise<T>,
  env: CompactGuardEnv = {},
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env) as Array<keyof CompactGuardEnv>) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function envForToolUseContext(
  toolUseContext: AgenCToolUseContext,
): CompactGuardEnv {
  const providerOverride = toolUseContext.options.providerOverride;
  if (!providerOverride) return {};
  return {
    AGENC_USE_OPENAI: "1",
    OPENAI_MODEL: providerOverride.model,
    OPENAI_BASE_URL: providerOverride.baseURL,
    OPENAI_API_KEY: providerOverride.apiKey,
    AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW:
      toolUseContext.options.contextWindowTokens.toString(),
  };
}

function isAgenCContextCollapseRequested(): boolean {
  return true;
}


function streamRetryErrorCause(error: unknown): unknown {
  return error instanceof StreamModelError ? error.cause : error;
}

function streamRetryErrorStatus(error: unknown): number | undefined {
  const cause = streamRetryErrorCause(error);
  if (!cause || typeof cause !== "object") return undefined;
  const record = cause as {
    readonly status?: unknown;
    readonly statusCode?: unknown;
  };
  const status = record.status ?? record.statusCode;
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

function streamRetryErrorMessage(error: unknown): string {
  const cause = streamRetryErrorCause(error);
  return cause instanceof Error ? cause.message : String(cause);
}

function streamInterruptedToolResult(
  block: { readonly id: string; readonly name: string },
  error: unknown,
): string {
  const detail = streamRetryErrorMessage(error);
  return JSON.stringify({
    tool_use_id: block.id,
    is_error: true,
    content: `<tool_use_error>stream disconnected before ${block.name} completed: ${detail}</tool_use_error>`,
  });
}

function cleanupInterruptedStreamAttempt(
  state: TurnState,
  session: Session,
  error: unknown,
): void {
  const completedToolCallIds = new Set<string>();
  for (const result of state.toolResults) {
    if (
      "toolCallId" in result &&
      typeof result.toolCallId === "string" &&
      result.toolCallId.length > 0
    ) {
      completedToolCallIds.add(result.toolCallId);
    }
  }
  for (const block of state.toolUseBlocks) {
    if (completedToolCallIds.has(block.id)) continue;
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "tool_call_completed",
        payload: {
          callId: block.id,
          result: streamInterruptedToolResult(block, error),
          isError: true,
          metadata: { cause: "stream_disconnected" },
        },
      },
    });
  }
  const executor = state.streamingToolExecutor as
    | { abort?: (reason?: string) => void; discard?: (reason?: string) => void }
    | null;
  try {
    if (typeof executor?.abort === "function") {
      executor.abort("connection_lost");
    } else if (typeof executor?.discard === "function") {
      executor.discard("connection_lost");
    }
  } catch {
    // I-41: cleanup paths must remain idempotent if the executor is already aborting.
  }
  state.assistantMessages = [];
  state.toolUseBlocks = [];
  state.toolResults = [];
  state.needsFollowUp = false;
  state.streamingToolExecutor = null;
}

function isReplaySafeStreamTool(
  session: Session,
  toolName: string,
): boolean {
  const tool = session.services.registry.tools.find(
    (candidate) => candidate.name === toolName,
  );
  try {
    if (tool?.requiresUserInteraction?.() === true) return false;
  } catch {
    return false;
  }
  return tool?.isReadOnly === true || tool?.metadata?.mutating === false;
}

function interruptedStreamRetryBlockReason(
  state: TurnState,
  session: Session,
): string | null {
  if (state.toolUseBlocks.length === 0) return null;
  const executor = state.streamingToolExecutor as
    | {
        getToolStates?: () => ReadonlyArray<{
          readonly id: string;
          readonly status: string;
          readonly toolName: string;
        }>;
      }
    | null;
  const toolStates = new Map(
    executor?.getToolStates?.().map((tool) => [tool.id, tool]) ?? [],
  );
  for (const block of state.toolUseBlocks) {
    if (isReplaySafeStreamTool(session, block.name)) continue;
    const status = toolStates.get(block.id)?.status ?? "queued";
    return `not retrying because streamed tool ${block.name} (${block.id}) reached ${status} without an explicit read-only replay contract`;
  }
  return null;
}

function cancelQueuedInterruptedTools(state: TurnState): void {
  const executor = state.streamingToolExecutor as
    | { cancelQueued?: (reason?: "connection_lost") => void }
    | null;
  executor?.cancelQueued?.("connection_lost");
}

function suppressInterruptedStreamToolHistory(state: TurnState): void {
  (state as TurnState & { suppressInterruptedStreamToolHistory?: boolean })
    .suppressInterruptedStreamToolHistory = true;
}

function buildSeedMessages(
  opts: RunTurnOptions,
  userContent: string | LLMContentPart[],
): { system?: LLMMessage; prior: LLMMessage[]; user: LLMMessage } {
  const system: LLMMessage | undefined = opts.systemPrompt
    ? { role: "system", content: opts.systemPrompt }
    : undefined;
  const prior: LLMMessage[] = [...(opts.history ?? [])];
  const user: LLMMessage = { role: "user", content: userContent };
  return { system, prior, user };
}

interface ContextualUpdatePreviousTurnSettings {
  readonly realtimeActive?: boolean;
  readonly personality?: Personality;
}

function readRealtimeUpdateBaseline(session: Session): {
  readonly previousContextItem?: TurnContextItem;
  readonly previousTurnSettings?: ContextualUpdatePreviousTurnSettings;
} {
  const peek = (session.state as unknown as {
    unsafePeek?: () => {
      readonly referenceContextItem?: TurnContextItem;
      readonly previousTurnSettings?: ContextualUpdatePreviousTurnSettings;
    };
  }).unsafePeek?.();
  return {
    ...(peek?.referenceContextItem !== undefined
      ? { previousContextItem: peek.referenceContextItem }
      : {}),
    ...(peek?.previousTurnSettings !== undefined
      ? { previousTurnSettings: peek.previousTurnSettings }
      : {}),
  };
}

function buildRealtimeInstructionUpdateMessage(
  previousContextItem: TurnContextItem | undefined,
  previousTurnSettings: ContextualUpdatePreviousTurnSettings | undefined,
  ctx: TurnContext,
): LLMMessage | undefined {
  const previousRealtimeActive =
    previousContextItem?.realtimeActive ?? previousTurnSettings?.realtimeActive;
  if (previousRealtimeActive === true && ctx.realtimeActive === false) {
    return realtimeEndInstructionMessage("inactive");
  }
  if (
    (previousRealtimeActive === false || previousRealtimeActive === undefined) &&
    ctx.realtimeActive === true
  ) {
    const instructions = realtimeStartInstructionsOverride(ctx);
    return instructions !== undefined
      ? realtimeStartWithInstructionsMessage(instructions)
      : realtimeStartInstructionMessage();
  }
  return undefined;
}

function buildPersonalitySpecUpdateMessage(
  previousContextItem: TurnContextItem | undefined,
  previousTurnSettings: ContextualUpdatePreviousTurnSettings | undefined,
  ctx: TurnContext,
): LLMMessage | undefined {
  if (ctx.features?.enabled?.("personality") === false) return undefined;
  const hasPrevious =
    previousContextItem !== undefined || previousTurnSettings !== undefined;
  if (!hasPrevious) return undefined;
  const personality = resolveTurnPersonality(ctx);
  if (personality === undefined || personality === "none") return undefined;
  if (!modelSupportsPersonality(ctx.modelInfo.modelMessages)) return undefined;
  const previousPersonality = normalizePersonality(
    previousContextItem?.personality ?? previousTurnSettings?.personality,
  );
  if (previousPersonality === personality) return undefined;
  const message = personalityMessageForModel(ctx.modelInfo, personality);
  return message !== undefined && message.length > 0
    ? personalitySpecInstructionMessage(message)
    : undefined;
}

function resolveTurnPersonality(ctx: TurnContext): Personality | undefined {
  return normalizePersonality(ctx.personality ?? ctx.config.personality);
}

function resolveModelInstructionsForTurn(
  ctx: TurnContext,
  baseInstructions: string,
): string {
  return getModelInstructions({
    modelInfo: ctx.modelInfo,
    baseInstructions,
    personality: resolveTurnPersonality(ctx),
  });
}

function realtimeStartInstructionsOverride(ctx: TurnContext): string | undefined {
  const value = (ctx.config as {
    readonly experimental_realtime_start_instructions?: unknown;
  }).experimental_realtime_start_instructions;
  return typeof value === "string" ? value : undefined;
}

function messageText(message: LLMMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return safeStringify(message.content);
}

function userContentHasInput(content: string | LLMContentPart[]): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  return content.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    if (part.type === "document") return part.source.data.trim().length > 0;
    return part.image_url.url.trim().length > 0;
  });
}

function userContentDisplayText(content: string | LLMContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "document") return "[document]";
      return "[image]";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function appendTextPart(parts: LLMContentPart[], text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = {
      type: "text",
      text: `${last.text}\n\n${trimmed}`,
    };
    return;
  }
  parts.push({ type: "text", text: trimmed });
}

function mergePendingInputIntoUserContent(
  userMessage: string | readonly LLMContentPart[],
  pending: readonly LLMMessage[],
): string | LLMContentPart[] {
  if (pending.length === 0) {
    return typeof userMessage === "string" ? userMessage : [...userMessage];
  }
  const hasMultimodalContent = pending.some(
    (message) => Array.isArray(message.content) &&
      message.content.some((part) => part.type !== "text"),
  ) || Array.isArray(userMessage);
  if (!hasMultimodalContent) {
    const parts = [
      typeof userMessage === "string" && userMessage.trim().length > 0
        ? userMessage
        : "",
      ...pending.map(messageText).filter((part) => part.trim().length > 0),
    ].filter((part) => part.length > 0);
    return parts.join("\n\n");
  }

  const contentParts: LLMContentPart[] = [];
  if (typeof userMessage === "string") {
    appendTextPart(contentParts, userMessage);
  } else {
    contentParts.push(...userMessage);
  }
  for (const message of pending) {
    if (typeof message.content === "string") {
      appendTextPart(contentParts, message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        appendTextPart(contentParts, part.text);
      } else if (part.type === "document") {
        if (part.source.data.trim().length > 0) contentParts.push(part);
      } else if (part.image_url.url.trim().length > 0) {
        contentParts.push(part);
      }
    }
  }
  return contentParts;
}

function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const merged = new AbortController();
  const onA = () => merged.abort((a as AbortSignal & { reason?: unknown }).reason);
  const onB = () => merged.abort((b as AbortSignal & { reason?: unknown }).reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return merged.signal;
}

function cumulativeUsage(acc: LLMUsage, next: LLMUsage | undefined): LLMUsage {
  if (!next) return acc;
  return {
    promptTokens: acc.promptTokens + (next.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (next.completionTokens ?? 0),
    totalTokens: acc.totalTokens + (next.totalTokens ?? 0),
  };
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function getAutoCompactTokenLimit(ctx: TurnContext): number | undefined {
  if (!isAutoCompactEnabledForNotices()) return undefined;

  const explicit = finitePositive(
    (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit,
  );
  if (explicit !== undefined) return explicit;

  const effectiveWindow = finitePositive(modelContextWindow(ctx));
  if (effectiveWindow === undefined) return undefined;
  return Math.max(
    1,
    effectiveWindow > AUTOCOMPACT_NOTICE_BUFFER_TOKENS
      ? effectiveWindow - AUTOCOMPACT_NOTICE_BUFFER_TOKENS
      : effectiveWindow,
  );
}

function messageHasImageContent(message: LLMMessage | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some(
    (part) => part.type === "image_url" && part.image_url.url.trim().length > 0,
  );
}

function isAutoCompactEnabledForNotices(): boolean {
  const raw = process.env.DISABLE_AUTO_COMPACT ??
    process.env.AGENC_DISABLE_AUTO_COMPACT;
  if (raw === undefined) return true;
  return !TRUTHY_ENV.has(raw.trim().toLowerCase());
}

function toResponseItem(message: LLMMessage): ResponseItem {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ({ ...part })),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

function terminalToStopReason(
  reason: Terminal["reason"],
): Extract<PhaseEvent, { type: "turn_complete" }>["stopReason"] {
  switch (reason) {
    case "completed":
    case "max_turns":
    case "cancelled":
      return reason;
    default:
      return "error";
  }
}

function sessionQuerySourceForPostSampling(session: Session): string {
  const raw =
    typeof session.services.querySource === "string" &&
      session.services.querySource.length > 0
      ? session.services.querySource
      : "repl_main_thread";
  const source = (session as unknown as {
    readonly sessionConfiguration?: {
      readonly sessionSource?: unknown;
    };
  }).sessionConfiguration?.sessionSource;
  const sourceKind =
    typeof source === "object" && source !== null
      ? (source as { readonly kind?: unknown }).kind
      : undefined;
  if (
    raw === "repl_main_thread" &&
    sourceKind === "subagent"
  ) {
    return `agent:${session.conversationId}`;
  }
  return raw;
}

function launchMagicDocsPostSampling(
  state: TurnState,
  session: Session,
  signal?: AbortSignal,
): void {
  void runMagicDocsPostSamplingHook({
    messages: state.messages,
    querySource: sessionQuerySourceForPostSampling(session),
    session,
    ...(signal !== undefined ? { signal } : {}),
  }).catch((error) => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "magic_docs_update_failed",
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      },
    });
  });
}

function launchSessionMemoryPostSampling(
  state: TurnState,
  session: Session,
  ctx: TurnContext,
  signal?: AbortSignal,
): void {
  const baseInstructions =
    typeof (ctx as TurnContext & { baseInstructions?: unknown })
      .baseInstructions === "string"
      ? (ctx as TurnContext & { baseInstructions: string }).baseInstructions
      : undefined;
  const messages =
    state.messagesForQuery.length > 0 ? state.messagesForQuery : state.messages;
  void runSessionMemoryPostSamplingHook({
    messages,
    ...(baseInstructions !== undefined ? { baseInstructions } : {}),
    querySource: sessionQuerySourceForPostSampling(session),
    session,
    ...(signal !== undefined ? { signal } : {}),
  }).catch((error) => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "session_memory_update_failed",
          message:
            error instanceof Error
              ? error.message
              : String(error),
        },
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// agenc runtime port: compaction helpers
// ─────────────────────────────────────────────────────────────────────

/** Reason passed to runAutoCompact. Port of agenc runtime `CompactionReason`. */
export type CompactionReason =
  | "context_limit"
  | "model_downshift"
  | "manual"
  | "reactive_recovery";

/** Phase passed to runAutoCompact. Port of agenc runtime `CompactionPhase`. */
export type CompactionPhase = "pre_turn" | "in_turn" | "post_turn";

/** Whether to inject the initial context on post-compact. Port of
 *  agenc runtime `InitialContextInjection`. */
export type InitialContextInjection =
  | "before_last_user_message"
  | "do_not_inject";

/**
 * Structural shape of the resolved AgenC auto-compact export.
 * Kept loose so tests can inject a compact dispatcher without depending
 * on the full provider request graph.
 */
export interface AutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: AgenCAutoCompactResult["compactionResult"];
  readonly consecutiveFailures?: number;
}
export type AutoCompactImpl = (
  ...args: unknown[]
) => Promise<AutoCompactResult>;

// Test-only override — when set, `runAutoCompact` calls this instead of
// the normal compact pipeline. Lets unit tests assert the dispatcher was
// reached with the expected arguments without spinning up the full
// AgenC compact subsystem. Clear via
// `setAutoCompactImplForTests(null)` between tests.
type AutoCompactImplOverrideGlobal = typeof globalThis & {
  __agencRunTurnAutoCompactImplOverride?: AutoCompactImpl | null;
};

function autoCompactImplOverrideGlobal(): AutoCompactImplOverrideGlobal {
  return globalThis as AutoCompactImplOverrideGlobal;
}

function getAutoCompactImplOverride(): AutoCompactImpl | null {
  return autoCompactImplOverrideGlobal().__agencRunTurnAutoCompactImplOverride ??
    null;
}

export function setAutoCompactImplForTests(
  impl: AutoCompactImpl | null,
): void {
  autoCompactImplOverrideGlobal().__agencRunTurnAutoCompactImplOverride = impl;
}

/**
 * Port of agenc runtime `run_auto_compact` (turn.rs:790-818). Dispatcher that
 * picks between inline and remote compact task based on provider info.
 * AgenC routes the inline path through the turn-owned compact pipeline.
 *
 * Behavior:
 *   - Resolves the compact implementation or test override.
 *   - Calls the compact pipeline with the session's current messages plus
 *     per-turn context. Threshold/circuit-breaker logic lives inside
 *     AgenC; the dispatcher only handles state splicing and telemetry.
 *   - When `state` is provided and compaction ran, splices the post-
 *     compact messages back into `state.messages` / `state.messagesForQuery`
 *     and stamps `state.autoCompactTracking` so the next phase sees the
 *     compacted view. (agenc runtime's pre-sampling compact runs before the
 *     first phase iteration; mutating state here is how we guarantee
 *     `prepareContext` reads the compacted view.)
 *   - Never swallows errors silently — emits `warning:auto_compact_failed`
 *     and returns false so the caller proceeds with uncompacted state.
 *
 * Returns true when compaction actually ran.
 */
async function runAutoCompact(
  session: Session,
  ctx: TurnContext,
  initialContextInjection: InitialContextInjection,
  reason: CompactionReason,
  phase: CompactionPhase,
  state?: TurnState,
): Promise<boolean> {
  // Source-of-truth for the message set depends on when the dispatcher
  // is called. Pre-sampling compact runs before the phase loop, so
  // `state.messages` holds the seed history. Inline compact (T13)
  // called mid-loop would prefer `messagesForQuery`. Prefer the latter
  // when populated, fall back to `messages`.
  const messages =
    state && state.messagesForQuery.length > 0
      ? state.messagesForQuery
      : (state?.messages ?? []);
  const shouldKeepUnsentImageTurn =
    phase === "pre_turn" &&
    state !== undefined &&
    state.messagesForQuery.length === 0 &&
    messageHasImageContent(state.messages.at(-1));
  const querySource =
    reason === "model_downshift" ? "model_downshift" : "repl_main_thread";
  try {
    const autoCompactImplOverride = getAutoCompactImplOverride();
    const result = autoCompactImplOverride
      ? await autoCompactImplOverride(
        messages,
        { session, ctx, querySource },
        state?.autoCompactTracking,
        state?.snipTokensFreed ?? 0,
        initialContextInjection,
      )
      : await runAgenCAutoCompact({
        session,
        ctx,
        state,
        querySource,
        reason,
        phase,
        initialContextInjection,
      });

    if (result.wasCompacted && state) {
      if (!result.compactionResult) {
        throw new Error(
          "autoCompactIfNeeded reported success without a compactionResult",
        );
      }
      const cr = result.compactionResult;
      if (cr) {
        session.rolloutStore?.appendRollout(
          {
            type: "compacted",
            payload: buildAgenCCompactedRolloutItem(cr),
          },
          { durable: true },
        );
      }
      const compacted = buildAgenCPostCompactMessages(cr);
      const unsentImageTurn = shouldKeepUnsentImageTurn
        ? state.messages.at(-1)
        : undefined;
      // Replace both the full history view and the per-iteration
      // projection so `prepareContext` (next phase) sees the same
      // post-compact replacement history the rollout recorded.
      state.messages = unsentImageTurn
        ? [...compacted, { ...unsentImageTurn }]
        : compacted;
      state.messagesForQuery = [...compacted];
      if (unsentImageTurn) {
        state.messagesForQuery.push({ ...unsentImageTurn });
      }
      // Stamp auto-compact tracking so the commit phase emits the
      // boundary marker (runtime/src/phases/commit.ts).
      state.autoCompactTracking = {
        compacted: true,
        turnId: `auto-${reason}-${phase}-${Date.now().toString(36)}`,
        turnCounter: 0,
        consecutiveFailures: 0,
      };
      return true;
    }

    if (
      result.consecutiveFailures !== undefined &&
      state?.autoCompactTracking
    ) {
      state.autoCompactTracking = {
        ...state.autoCompactTracking,
        consecutiveFailures: result.consecutiveFailures,
      };
    }

    return result.wasCompacted === true;
  } catch (error) {
    // Never silently swallow compact failures. Emit a structured
    // warning carrying the reason/phase so downstream observability can
    // distinguish model-downshift compacts from context-limit compacts.
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "auto_compact_failed",
          message: `${reason}/${phase}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      },
    });
    return false;
  }
}

/**
 * Port of agenc runtime `maybe_run_previous_model_inline_compact` (turn.rs:749-788).
 * When the user switches to a model with a smaller context window and
 * total token usage exceeds the new auto-compact limit, compact
 * against the PREVIOUS model's context before continuing.
 *
 * Returns true when compaction ran, false otherwise.
 */
export async function maybeRunPreviousModelInlineCompact(
  session: Session,
  ctx: TurnContext,
  _totalUsageTokens: number,
  state?: TurnState,
): Promise<boolean> {
  // A1 fix: agenc runtime resolves the previous model's TurnContext via
  // `turn_context.with_model(previous_turn_settings.model, models_manager)`
  // and reads its context_window. AgenC has no models_manager yet, so
  // we accept an optional pre-resolved `contextWindow` (and/or
  // `modelInfo`) carried alongside `previousTurnSettings.model`. The
  // new context window always comes from the CURRENT turn's
  // `ctx.modelInfo`, not from the previous turn. This makes the
  // model-downshift branch reachable instead of comparing
  // `oldContextWindow > oldContextWindow`, which can never be true.
  const previousTurnSettings = (session.state as unknown as {
    unsafePeek?: () => {
      previousTurnSettings?: {
        model: string;
        contextWindow?: number;
        modelInfo?: { contextWindow?: number };
      };
    };
  }).unsafePeek?.()?.previousTurnSettings;
  if (!previousTurnSettings) return false;

  const newContextWindow =
    (ctx.modelInfo as unknown as { contextWindow?: number }).contextWindow;
  const oldContextWindow =
    previousTurnSettings.contextWindow ??
    previousTurnSettings.modelInfo?.contextWindow;
  if (oldContextWindow === undefined || newContextWindow === undefined) {
    return false;
  }
  const newAutoCompactLimit =
    getAutoCompactTokenLimit(ctx) ?? Number.POSITIVE_INFINITY;
  const totalUsageTokens = _totalUsageTokens;
  const shouldRun =
    totalUsageTokens > newAutoCompactLimit &&
    previousTurnSettings.model !== ctx.modelInfo.slug &&
    oldContextWindow > newContextWindow;
  if (!shouldRun) return false;

  return await runAutoCompact(
    session,
    ctx,
    "do_not_inject",
    "model_downshift",
    "pre_turn",
    state,
  );
}

/**
 * Port of agenc runtime `run_pre_sampling_compact` (turn.rs:712-741). Runs
 * (a) previous-model inline compact on model downshift and
 * (b) auto-compact when total-usage-tokens exceeds the current
 * model's auto-compact limit.
 *
 * Returns true when any compaction ran.
 */
async function runPreSamplingCompact(
  session: Session,
  ctx: TurnContext,
  state?: TurnState,
): Promise<boolean> {
  const totalUsageTokensBefore = getTotalTokenUsage(session);
  let preSamplingCompacted = await maybeRunPreviousModelInlineCompact(
    session,
    ctx,
    totalUsageTokensBefore,
    state,
  );
  const autoCompactLimit = getAutoCompactTokenLimit(ctx);
  if (autoCompactLimit !== undefined) {
    const contextLimitCompacted = await runAutoCompact(
      session,
      ctx,
      "do_not_inject",
      "context_limit",
      "pre_turn",
      state,
    );
    preSamplingCompacted = preSamplingCompacted || contextLimitCompacted;
  }
  return preSamplingCompacted;
}

function getTotalTokenUsage(session: Session): number {
  const peek = (session.state as unknown as {
    unsafePeek?: () => {
      totalTokenUsage?: number | { totalTokens?: number };
    };
  }).unsafePeek?.();
  const field = peek?.totalTokenUsage;
  if (typeof field === "number") return Number.isFinite(field) ? field : 0;
  const totalTokens = field?.totalTokens;
  return typeof totalTokens === "number" && Number.isFinite(totalTokens)
    ? totalTokens
    : 0;
}

// ─────────────────────────────────────────────────────────────────────
// agenc runtime port: prompt + tool building
// ─────────────────────────────────────────────────────────────────────

export interface BuiltPrompt {
  readonly input: ReadonlyArray<LLMMessage>;
  readonly tools: ReadonlyArray<LLMTool>;
  readonly parallelToolCalls: boolean;
  readonly baseInstructions: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

/**
 * Port of agenc runtime `build_prompt` (turn.rs:946-976). Builds the per-
 * request prompt shape. `dynamicTools[].deferLoading` filters out
 * deferred tools per agenc runtime 952-966.
 */
export function buildPrompt(
  input: ReadonlyArray<LLMMessage>,
  tools: ReadonlyArray<LLMTool>,
  ctx: TurnContext,
  baseInstructions: string,
): BuiltPrompt {
  const deferred = new Set(
    ctx.dynamicTools
      .filter((t) => (t as unknown as { deferLoading?: boolean }).deferLoading)
      .map((t) => t.name),
  );
  const visibleTools =
    deferred.size === 0 ? tools : tools.filter((spec) => !deferred.has(spec.function.name));
  const contextWindowTokens = modelContextWindow(ctx) ?? ctx.modelInfo.contextWindow;
  return {
    input,
    tools: visibleTools,
    parallelToolCalls: ctx.modelInfo.supportsParallelToolCalls ?? false,
    baseInstructions,
    ...(contextWindowTokens !== undefined
      ? { contextWindowTokens }
      : {}),
    ...(ctx.modelInfo.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.modelInfo.maxOutputTokens }
      : {}),
  };
}

/**
 * Insert runtime context/attachment messages without moving the stable
 * system-prompt prefix into the middle of the API transcript. AgenC keeps
 * the system prompt separate from conversation messages; in AgenC the prompt
 * is represented as leading `role: "system"` messages before provider wiring,
 * so user-channel context belongs immediately after that leading prefix.
 */
export function insertContextMessagesAfterLeadingSystem(
  messages: ReadonlyArray<LLMMessage>,
  contextMessages: ReadonlyArray<LLMMessage>,
): LLMMessage[] {
  if (contextMessages.length === 0) return [...messages];
  let insertAt = 0;
  while (messages[insertAt]?.role === "system") {
    insertAt += 1;
  }
  return [
    ...messages.slice(0, insertAt),
    ...contextMessages,
    ...messages.slice(insertAt),
  ];
}

/**
 * Port of agenc runtime `built_tools` (turn.rs:1130-1268). Assembles the
 * tool list visible to the model. agenc runtime threads through connectors,
 * MCP tools, skill injections, plan-mode restrictions, etc. AgenC's
 * T5 version reads the static tool registry; T7 + T9 + T10 add the
 * dynamic filters as their subsystems land.
 */
/**
 * Extract the most recent user-channel message text for the per-turn
 * attachments orchestrator. Walks backwards through the projected query
 * messages, returning the first user message's text or null if none
 * exist (e.g. opening-turn replays where the rolled-back projection is
 * empty).
 */
function extractLastUserText(messages: ReadonlyArray<LLMMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") {
      return message.content.length > 0 ? message.content : null;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          const text = (part as { text: string }).text;
          if (text.length > 0) return text;
        }
      }
    }
    return null;
  }
  return null;
}

export function builtTools(session: Session, _ctx: TurnContext): ReadonlyArray<LLMTool> {
  return session.services.registry.toLLMTools();
}

function buildSamplingRequestContract(
  state: TurnState,
  session: Session,
  ctx: TurnContext,
): StreamModelRequestContract {
  const baseInstructions = (
    ctx as TurnContext & { baseInstructions?: string }
  ).baseInstructions;
  const request = buildPrompt(
    state.messagesForQuery,
    builtTools(session, ctx),
    ctx,
    baseInstructions ?? "",
  );
  return {
    ...request,
    ...(state.maxOutputTokensOverride !== undefined
      ? { maxOutputTokens: state.maxOutputTokensOverride }
      : {}),
  };
}

function removeLastAssistantMessage(state: TurnState): void {
  const last = state.messages.at(-1);
  if (last?.role === "assistant") {
    state.messages.pop();
  }
}

function enforcePlanModeToolBoundary(
  state: TurnState,
  ctx: TurnContext,
  request: StreamModelRequestContract,
): void {
  if (!planModeHelpers.isPlanMode(ctx)) return;
  if (request.tools.length === 0) return;
  if (state.toolUseBlocks.length > 0) {
    state.planToolRequiredRetryCount = 0;
    return;
  }

  const assistant = state.assistantMessages.at(-1);
  const assistantText = assistant?.text?.trim() ?? "";
  if (assistantText.length === 0) return;

  state.planToolRequiredRetryCount += 1;
  if (state.planToolRequiredRetryCount > MAX_PLAN_TOOL_REQUIRED_RETRIES) {
    throw new StreamModelError(
      new Error(
        "plan_mode_tool_required: provider returned assistant text without a tool call",
      ),
    );
  }

  removeLastAssistantMessage(state);
  state.assistantMessages = [];
  state.toolUseBlocks = [];
  state.needsFollowUp = false;
  state.messages.push({
    role: "user",
    content:
      "Plan mode requires this step to end with a tool call. Do not ask questions or request approval in assistant text. If you need user input, call AskUserQuestion with concrete options. If the plan is ready for approval, call ExitPlanMode. If you need more context, call a read-only tool.",
  });
  state.transition = { reason: "plan_tool_required" };
}

// ─────────────────────────────────────────────────────────────────────
// agenc runtime port: sampling request orchestration
// ─────────────────────────────────────────────────────────────────────

export interface SamplingRequestResult {
  readonly needsFollowUp: boolean;
  readonly lastAgentMessage?: string;
  readonly assistantText: string;
  readonly usage: LLMUsage;
  readonly terminal?: Terminal;
}

/**
 * Port of agenc runtime `try_run_sampling_request` (turn.rs:1828-2222). In
 * agenc runtime this is the single-attempt stream consumer: it builds the
 * request, streams events, dispatches tool calls via the
 * ToolCallRuntime, and returns a SamplingRequestResult when the
 * stream completes or an Err on retryable failure.
 *
 * AgenC's translation runs ONE phase-machine iteration. The phase
 * machine handles the stream (stream-model phase), tool dispatch
 * (execute-tools phase), nudging (continuation-nudge phase), and
 * history commit (commit phase). The resulting TurnState tells us
 * whether a follow-up iteration is needed.
 *
 * On retry-worthy errors (stream idle, transient provider error),
 * throw so `runSamplingRequest` can apply the retry policy. Fatal
 * errors throw too; the caller routes them as terminal.
 */
async function tryRunSamplingRequest(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal: AbortSignal,
  events: PhaseEvent[],
): Promise<SamplingRequestResult> {
  // Phase 1: prepare context.
  await prepareAgenCTurnContext(state, ctx, session, signal);
  const prepareTerminal = getAgenCPreparedTerminal(state);
  if (prepareTerminal) {
    const assistantText = prepareTerminal.assistantMessage.text ?? "";
    if (assistantText.length > 0) {
      state.assistantMessages = [prepareTerminal.assistantMessage];
      state.messages.push({
        role: "assistant",
        content: assistantText,
      });
      events.push({ type: "assistant_text", content: assistantText });
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "agent_message",
          payload: { message: assistantText },
        },
      });
    }
    return {
      needsFollowUp: false,
      lastAgentMessage: assistantText,
      assistantText,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      terminal: prepareTerminal.terminal,
    };
  }
  // Per-turn attachments orchestrator (agenc `getAttachments()`
  // parity, ported into AgenC). Runs after `prepareContext` projects
  // the post-compaction history onto `state.messagesForQuery` and
  // before `buildSamplingRequestContract` snapshots it for the model
  // request. Each registered producer reads cross-turn state via
  // `attachment-state.ts` and emits zero or more attachments. The
  // attachments are converted to user-channel `LLMMessage`s and
  // prepended to `state.messagesForQuery` so they ride into the model
  // request through the existing build path. Producer registry lives
  // in `runtime/src/prompts/attachments/orchestrator.ts`.
  const agencHome = session.services.configStore?.agencHome;
  const currentConfig = session.services.configStore?.current();
  const fileMentionAllowedRoots = extractMentionAllowedRoots(
    currentConfig,
  );
  const attachments = await getAttachments({
    sessionKey: session,
    userInput: extractLastUserText(state.messagesForQuery),
    loadedTools: builtTools(session, ctx),
    discoveredToolNames:
      session.services.registry.getDiscoveredToolNames?.() ?? new Set(),
    messages: state.messagesForQuery,
    permissionContext:
      session.permissionModeRegistry.current(),
    cwd: ctx.cwd,
    subagentDepth: ctx.depth,
    signal,
    ...(typeof agencHome === "string" && agencHome.length > 0
      ? { agencHome }
      : {}),
    ...(fileMentionAllowedRoots !== undefined ? { fileMentionAllowedRoots } : {}),
    skillsManager: session.services.skillsManager,
    config: currentConfig,
    contextWindowTokens: ctx.modelInfo.contextWindow,
  });
  if (attachments.length > 0) {
    const attachmentMessages = attachmentsToMessages(attachments);
    if (attachmentMessages.length > 0) {
      state.messagesForQuery = insertContextMessagesAfterLeadingSystem(
        state.messagesForQuery,
        attachmentMessages,
      );
    }
  }

  const request = buildSamplingRequestContract(state, session, ctx);

  // Plan-mode stream state (T11). When the turn's collaboration mode is
  // `plan`, stash per-turn plan-mode bookkeeping on turn-state so the
  // post-stream finalize hook below (and future delta callbacks) share
  // one `PlanModeStreamState` instance.
  if (planModeHelpers.isPlanMode(ctx)) {
    const withPlan = state as TurnState & {
      planModeStream?: planModeHelpers.PlanModeStreamState;
    };
    if (withPlan.planModeStream === undefined) {
      withPlan.planModeStream = planModeHelpers.createPlanModeStreamState(
        ctx.subId,
      );
    }
  }

  // Phase 2: stream model.
  let streamModelError: StreamModelError | null = null;
  try {
    await streamModel(state, ctx, session, request, signal);
    enforcePlanModeToolBoundary(state, ctx, request);
  } catch (error) {
    if (error instanceof StreamModelError) {
      streamModelError = error;
    } else {
      streamModelError = new StreamModelError(error);
    }
  }

  // Plan-mode: after the stream finishes, let the helper finalize any
  // plan item embedded in the final assistant message. No-op when not
  // in plan mode or when no `<plan>` block was found.
  if (planModeHelpers.isPlanMode(ctx)) {
    const withPlan = state as TurnState & {
      planModeStream?: planModeHelpers.PlanModeStreamState;
    };
    const planStream = withPlan.planModeStream;
    if (planStream) {
      const last = state.messages.at(-1);
      if (
        last?.role === "assistant" &&
        typeof last.content === "string" &&
        last.content.length > 0
      ) {
        planModeHelpers.maybeCompletePlanItemFromMessage(
          session,
          ctx,
          planStream,
          {
            role: "assistant",
            content: [{ type: "output_text", text: last.content }],
          },
        );
      }
    }
  }

  // T8: stash any wire-layer error on state for the recovery ladder
  // to consume. FallbackTriggeredError + stream_idle + provider 5xx
  // all become stream errors here; the ladder classifies them via
  // `state.lastStreamError` + ordered trigger evaluation (I-10).
  if (streamModelError) {
    (state as TurnState & { lastStreamError?: unknown }).lastStreamError =
      streamModelError.cause ?? streamModelError;
  } else {
    (state as TurnState & { lastStreamError?: unknown }).lastStreamError =
      undefined;
  }

  const assistantText = state.assistantMessages.at(-1)?.text ?? "";
  if (assistantText.length > 0) {
    events.push({ type: "assistant_text", content: assistantText });
  }

  // Phase 3: post-sample recovery. Always runs — even on stream
  // error — so the ladder can decide between recovery vs terminal.
  await postSampleRecovery(state, ctx, session, signal);

  // If recovery applied a transition (any of I-10's triggers fired),
  // swallow the stream error and let the outer loop re-enter
  // PrepareContext.
  if (state.transition !== undefined) {
    (state as TurnState & { lastStreamError?: unknown }).lastStreamError = undefined;
    streamModelError = null;
  }

  // Still-unrecovered stream error → bubble for runSamplingRequest's
  // retry policy to decide (stream_idle + transient).
  if (streamModelError) {
    throw streamModelError;
  }

  // Phase 4: continuation nudge.
  await continuationNudge(state, ctx, session, signal);

  return {
    needsFollowUp: state.needsFollowUp,
    lastAgentMessage: assistantText,
    assistantText,
    // D1 fix: thread the real provider-reported usage stashed by
    // streamModel. Falling back to zeros only when the provider
    // genuinely reported nothing (e.g. aborted before first chunk).
    usage: state.lastResponseUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

/**
 * Port of agenc runtime `run_sampling_request` (turn.rs:987-1129). Applies the
 * per-provider retry policy around `tryRunSamplingRequest`.
 *
 * T8: retries route through `reconnectWithBackoff` from
 * `recovery/reconnection.ts` so every attempt shares the suspend-aware
 * jittered exponential backoff used by the rest of the recovery ladder.
 * Transient classification fans through two predicates in order:
 *
 *   1. `isRetryableStreamError` — typed discrimination on
 *      `StreamModelError.cause`. Covers `LLMServerError`,
 *      `LLMRateLimitError`, `LLMTimeoutError`, and the `stream_idle`
 *      watchdog path. Also fails closed on
 *      `LLMContextWindowExceededError` / auth failures.
 *   2. `isTransientProviderError` — substring + `status` classifier
 *      over the raw underlying error. Catches socket hangups /
 *      `5xx`-tagged errors that bubbled up without a typed wrapper.
 *
 * Non-transient errors bubble out of `reconnectWithBackoff` immediately
 * (`throw err`) so `runTurn` can route them to terminal.
 */
async function runSamplingRequest(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal: AbortSignal,
  events: PhaseEvent[],
): Promise<SamplingRequestResult> {
  const outcome = await reconnectWithBackoff<SamplingRequestResult>({
    session,
    signal,
    attempt: () => tryRunSamplingRequest(state, ctx, session, signal, events),
    isTransient: (err) => {
      if (isRetryableStreamError(err)) return true;
      // Fall-through: the raw-error classifier covers bare
      // ECONNRESET / 5xx / socket-hang-up failures that never got
      // wrapped in StreamModelError.
      if (err instanceof StreamModelError) {
        return isTransientProviderError(err.cause);
      }
      return isTransientProviderError(err);
    },
    onTransientRetry: async (attempt, err) => {
      const blockedReason = interruptedStreamRetryBlockReason(state, session);
      if (blockedReason !== null) {
        suppressInterruptedStreamToolHistory(state);
        cancelQueuedInterruptedTools(state);
        emitError(session.eventLog, session.nextInternalSubId(), {
          cause: "stream_disconnected",
          message: `Stream interrupted after streamed tool work; ${blockedReason}.`,
          provider: session.services.provider.name,
          status: streamRetryErrorStatus(err),
          streamError: true,
        });
        return false;
      }
      const reservation = await reserveRecoveryReentry(session, state, {
        triggerName: "reconnect",
      });
      if (reservation.kind !== "reserved") {
        suppressInterruptedStreamToolHistory(state);
        cancelQueuedInterruptedTools(state);
        return false;
      }
      cleanupInterruptedStreamAttempt(state, session, err);
      emitError(session.eventLog, session.nextInternalSubId(), {
        cause: "stream_disconnected",
        message: `Reconnecting after stream interruption (attempt ${attempt}): ${streamRetryErrorMessage(err)}`,
        provider: session.services.provider.name,
        status: streamRetryErrorStatus(err),
        streamError: true,
      });
      return true;
    },
  });

  if (outcome.kind === "ok") return outcome.value;
  if (outcome.kind === "aborted") {
    const abortReason =
      (signal as AbortSignal & { reason?: unknown }).reason ?? outcome.reason;
    throw new StreamModelError(
      abortReason instanceof Error ? abortReason : new Error(String(abortReason)),
    );
  }
  // exhausted
  const lastError = outcome.lastError;
  if (lastError instanceof Error) throw lastError;
  throw new Error(`stream_retries_exhausted: ${String(lastError)}`);
}

/**
 * agenc runtime `is_retryable()` on agenc runtimeErr. AgenC classifies via typed
 * error discrimination on the underlying cause rather than substring
 * matching against `error.message`, which is fragile: a
 * `LLMContextWindowExceededError` whose provider message happens to
 * contain "504" in metadata would previously false-match.
 *
 * Retryable causes:
 *   - stream_idle watchdog abort (thrown from stream-model with a
 *     plain `Error` whose message begins `stream_idle:` — the only
 *     remaining message-based check, since it carries no type).
 *   - `LLMServerError`   (HTTP 5xx from the provider envelope)
 *   - `LLMTimeoutError`  (request timed out / abort)
 *   - `LLMRateLimitError` (429 + retry-after)
 *   - transient node networking: error `code` in
 *     {ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, EAI_AGAIN}
 *
 * Non-retryable (explicit):
 *   - `LLMContextWindowExceededError` (413 — reactive compact owns it)
 *   - `LLMAuthenticationError`
 *   - `LLMMessageValidationError`
 *
 * T8 wires the full classification (reactive compact recovery, etc.).
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof StreamModelError)) return false;
  const cause = error.cause;

  // Explicitly non-retryable typed causes — fail closed before any
  // generic branch so a provider message containing "504" can't
  // accidentally retry a context-window or auth failure.
  if (cause instanceof LLMContextWindowExceededError) return false;
  if (cause instanceof LLMAuthenticationError) return false;
  if (cause instanceof LLMMessageValidationError) return false;

  // Typed retryable causes.
  if (cause instanceof LLMServerError) return true;
  if (cause instanceof LLMTimeoutError) return true;
  if (cause instanceof LLMRateLimitError) return true;

  // Transient node networking via error `code`.
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN"
    ) {
      return true;
    }
  }

  // stream_idle watchdog path throws a plain `Error` whose message is
  // `stream_idle: no data for Nms`. That's the sole remaining
  // message-based check and it's a controlled runtime string, not a
  // provider payload that could contain user-supplied substrings.
  if (cause instanceof Error && cause.message?.startsWith("stream_idle")) {
    return true;
  }

  return false;
}

/**
 * D1 fix: resolve the outer-loop iteration cap. agenc runtime terminates on
 * the model's stop-signal, not on an iteration count; AgenC keeps the
 * cap as a safety net so a buggy provider can't spin forever. The
 * default is raised from 100 to 1000 (deep agent plans routinely cross
 * 100 tool iterations) and an env override lets ops dial it per
 * deployment without rebuilding. `ctx.config.maxTurns` still wins when
 * present so explicit session configuration is authoritative.
 */
function resolveMaxTurns(ctx: TurnContext): number {
  const explicit = (ctx.config as unknown as { maxTurns?: number }).maxTurns;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const envRaw = process.env.AGENC_MAX_TURNS;
  if (envRaw !== undefined) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1000;
}

/**
 * Port of agenc runtime `drain_in_flight` (turn.rs:1794-1818). On abort/error,
 * drain any still-in-flight tool futures so their side effects record
 * into conversation state.
 *
 * AgenC behavior (`query.ts:1046-1060`): each synthetic tool_result
 * yielded from the executor MUST be surfaced back into the output
 * stream and appended to `state.messages` / `state.toolResults` so
 * every orphan `tool_use` block sent by the model during the
 * abort/error window has a paired `tool_result`. Without this, the
   * next turn's provider request would fail the tool-use-id pairing
   * contract enforced by chat-completion providers.
  *
 * The executor's internal abort + discard logic is responsible for
 * generating the synthetic terminal results themselves. This helper
 * only closes the queue, iterates the result stream, records each
 * pair, and emits the `tool_call_completed` event the same way
 * `execute-tools` does so observers and rollouts see the turn close
 * cleanly.
 */
/** @internal — exported for drainInFlight unit tests only. */
export async function drainInFlight(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
): Promise<void> {
  const suppressToolHistory =
    (state as TurnState & { suppressInterruptedStreamToolHistory?: boolean })
      .suppressInterruptedStreamToolHistory === true;
  const exec = state.streamingToolExecutor as
    | {
        close?: () => void;
        getRemainingResults?: () => AsyncIterable<{
          toolCall: { id: string; name: string };
          result: {
            content: string;
            isError?: boolean;
            metadata?: Record<string, unknown>;
          };
          status: "completed" | "synthetic_error";
        }>;
      }
    | null;
  if (!exec || typeof exec.close !== "function") {
    delete (state as TurnState & {
      suppressInterruptedStreamToolHistory?: boolean;
    }).suppressInterruptedStreamToolHistory;
    return;
  }
  try {
    exec.close();
    if (typeof exec.getRemainingResults === "function") {
      for await (const drained of exec.getRemainingResults()) {
        const callId = drained.toolCall.id;
        const toolName = drained.toolCall.name;
        const result = drained.result;
        // Emit the tool_call_completed event so rollouts + observers
        // close the turn boundary with the synthetic result (I-8).
        const toolResultBytes = Buffer.byteLength(result.content, "utf8");
        session.emit(
          {
            id: session.nextInternalSubId(),
            msg: {
              type: "tool_call_completed",
              payload: {
                callId,
                result: result.content,
                isError: result.isError === true,
                ...(result.metadata !== undefined
                  ? { metadata: result.metadata }
                  : {}),
              },
            },
          },
          {
            turnId: ctx.subId,
            toolResultBytes,
          },
        );
        if (!suppressToolHistory) {
          // Append both the LLM-facing tool message and the user-facing
          // tool_result record so the pair shows up in the next
          // request and in session history.
          state.toolResults.push({
            uuid: crypto.randomUUID(),
            role: "user",
            toolCallId: callId,
            toolName,
            content: result.content,
          });
          state.messages.push({
            role: "tool",
            toolCallId: callId,
            content: result.content,
          });
        }
      }
    }
    // Clear the executor so a fresh one is created on the next
    // iteration, mirroring the per-iteration lifecycle in
    // executeTools().
    state.streamingToolExecutor = null;
  } catch (error) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "drain_in_flight_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
  } finally {
    delete (state as TurnState & {
      suppressInterruptedStreamToolHistory?: boolean;
    }).suppressInterruptedStreamToolHistory;
  }
}

/**
 * Port of agenc runtime `get_last_assistant_message_from_turn` (turn.rs:2223-2230).
 * Scans the response history for the most recent assistant message
 * and returns its text content.
 */
export function getLastAssistantMessageFromTurn(
  responses: ReadonlyArray<LLMMessage>,
): string | undefined {
  for (let i = responses.length - 1; i >= 0; i -= 1) {
    const m = responses[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string" && m.content.length > 0) return m.content;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level runTurn kernel — agenc runtime `run_turn` (turn.rs:130-665).
// Session owns the live entrypoint; the exported free function below is
// a compatibility path that delegates back into Session.
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of agenc runtime `run_turn` (turn.rs:130). Drives one user turn from
 * pre-sampling compact through N sampling-request iterations until
 * the turn terminates (no tool calls, no transition, stop-gate
 * allowed) or maxTurns is exceeded.
 *
 * Yields `PhaseEvent` values (same shape as the retired QueryEvent)
 * so bin/agenc.ts renders without a rewrite. Returns the terminal
 * reason as the generator return value.
 */
export async function* runTurnKernel(
  session: Session,
  ctx: TurnContext,
  userMessage: string | readonly LLMContentPart[],
  opts: RunTurnOptions = {},
): AsyncGenerator<PhaseEvent, Terminal> {
  // T6 gap #119: canonical turn-lifecycle emits. Each `runTurn`
  // invocation must flank its work with a `turn_started` +
  // `turn_context` pair and either a matching `turn_complete` (happy
  // path) or `turn_aborted` (cancel/error path) so durable rollouts
  // see closed turn boundaries. Without these, I-48 orphan-TurnStarted
  // recovery in rollout-reconstruction would treat every clean turn
  // as a `process_killed` abort.
  const turnStartedAt = Date.now();
  ensureTurnTimingState(ctx).markTurnStarted(turnStartedAt);
  const emitTurnStarted = (): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_started",
        payload: {
          turnId: ctx.subId,
          startedAt: turnStartedAt,
          ...(ctx.modelInfo.contextWindow !== undefined
            ? { modelContextWindow: ctx.modelInfo.contextWindow }
            : {}),
          collaborationModeKind: ctx.collaborationMode.model,
        },
      },
    });
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_context",
        payload: toTurnContextItem(ctx),
      },
    });
  };
  const emitTurnComplete = (content: string): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_complete",
        payload: {
          turnId: ctx.subId,
          lastAgentMessage: content,
          completedAt: Date.now(),
          durationMs: Date.now() - turnStartedAt,
        },
      },
    });
  };
  const emitTurnAborted = (reason: string): void => {
    session.emitTurnAbortedOnce(ctx.subId, reason);
  };
  const referenceContextItem = toTurnContextItem(ctx);

  // I-13 consumer: apply any staged provider/model/profile switch from
  // a prior `/model`, `/provider`, `/config profile <name>`, or
  // recovery-side `model_fallback` before this turn's lifecycle emits
  // so downstream `turn_context` reflects the intended model slug (for
  // callers that rebuild `ctx` from `session.state` per turn). The
  // existing `pendingProviderSwitch` check inside the inner sampling
  // loop stays as a safety net — the clear here prevents it from
  // re-terminating this fresh turn.
  const sessionOwner = session as Session & {
    consumePendingProviderSwitch?: () => Promise<void>;
  };
  if (typeof sessionOwner.consumePendingProviderSwitch === "function") {
    await sessionOwner.consumePendingProviderSwitch();
  }
  session.bindProviderConversation();

  const pendingInputMessages =
    typeof session.drainPendingInputMessages === "function"
      ? session.drainPendingInputMessages()
      : [];
  const userContent = mergePendingInputIntoUserContent(
    userMessage,
    pendingInputMessages,
  );

  // agenc runtime: `if input.is_empty() && !sess.has_pending_input().await { return None }`
  // Empty/no-pending-input is a no-op turn, not a synthetic completed
  // turn. Callers that want to force work must enqueue pending input or
  // pass a non-empty user message.
  if (!userContentHasInput(userContent) && !session.hasPendingInput()) {
    return { reason: "completed" };
  }

  // Upstream agenc runtime `tasks/mod.rs::spawn_task` — register this turn with
  // the session's task dispatcher BEFORE any state-mutation work runs.
  // This takes the `activeTurn` lock and aborts any prior in-flight
  // turn with `TurnAbortReason::Replaced`, then installs the new
  // `ActiveTurn` keyed on `ctx.subId`. `onTaskFinished` in the finally
  // block below clears the registry on every exit path (normal, abort,
  // error). The returned task's `abortController` is merged into the
  // kernel's signal so `abortAllTasks` propagates to in-flight phases.
  const runningTask = await session.spawnTask({
    subId: ctx.subId,
    kind: "regular",
    task: new RegularTurnTask(),
    turnContext: ctx,
    autoStart: false,
    startedAtMs: turnStartedAt,
  });
  const codeModeTurnWorker = startCodeModeTurnWorker(session);

  try {
    return yield* runTurnKernelInner(
      session,
      ctx,
      userContent,
      opts,
      runningTask,
      {
        turnStartedAt,
        emitTurnStarted,
        emitTurnComplete,
        emitTurnAborted,
        referenceContextItem,
        sessionOwner,
      },
    );
  } finally {
    codeModeTurnWorker.dispose();
    // Upstream agenc runtime emits `on_task_finished` uniformly from the spawn
    // site so every task-kind shares the same lifecycle. In gut the
    // kernel BOTH runs the task body AND owns its finish emit.
    await session.onTaskFinished(ctx.subId);
  }
}

/**
 * Inner body of `runTurnKernel` extracted so the outer generator can
 * wrap it in a try/finally that funnels every exit path through
 * `session.onTaskFinished`. The outer wrapper also owns the
 * `session.spawnTask` call (see upstream agenc runtime `tasks/mod.rs::spawn_task`
 * → `start_task` → task body → `on_task_finished` sequence).
 */
interface RunTurnKernelCommons {
  readonly turnStartedAt: number;
  readonly emitTurnStarted: () => void;
  readonly emitTurnComplete: (content: string) => void;
  readonly emitTurnAborted: (reason: string) => void;
  readonly referenceContextItem: TurnContextItem;
  readonly sessionOwner: Session & {
    consumePendingProviderSwitch?: () => Promise<void>;
  };
}

async function* runTurnKernelInner(
  session: Session,
  ctx: TurnContext,
  userContent: string | LLMContentPart[],
  opts: RunTurnOptions,
  runningTask: RunningTask,
  commons: RunTurnKernelCommons,
): AsyncGenerator<PhaseEvent, Terminal> {
  const {
    emitTurnStarted,
    emitTurnComplete,
    emitTurnAborted,
    referenceContextItem,
    sessionOwner,
  } = commons;

  // Seed the initial TurnState BEFORE pre-sampling compact so the
  // dispatcher can splice post-compact messages back into state and the
  // first `prepareContext` call reads the compacted view. agenc runtime's
  // equivalent operates on the session-held conversation directly;
  // AgenC's phase machine reads `state.messages`, so the compact result
  // has to land there.
  const ctxBaseInstructions =
    typeof (ctx as TurnContext & { baseInstructions?: unknown })
      .baseInstructions === "string"
      ? (ctx as TurnContext & { baseInstructions: string }).baseInstructions
      : undefined;
  const rawSystemPrompt =
    opts.systemPrompt !== undefined ? opts.systemPrompt : ctxBaseInstructions;
  const effectiveSystemPrompt =
    rawSystemPrompt !== undefined
      ? resolveModelInstructionsForTurn(ctx, rawSystemPrompt)
      : undefined;
  const { system, prior, user } = buildSeedMessages(
    effectiveSystemPrompt !== undefined
      ? { ...opts, systemPrompt: effectiveSystemPrompt }
      : opts,
    userContent,
  );
  const priorExisting = system ? [system, ...prior] : prior;
  const realtimeBaseline = readRealtimeUpdateBaseline(session);
  const realtimeInstructionUpdate = buildRealtimeInstructionUpdateMessage(
    realtimeBaseline.previousContextItem,
    realtimeBaseline.previousTurnSettings,
    ctx,
  );
  const personalityInstructionUpdate = buildPersonalitySpecUpdateMessage(
    realtimeBaseline.previousContextItem,
    realtimeBaseline.previousTurnSettings,
    ctx,
  );
  const contextualInstructionUpdates = [
    realtimeInstructionUpdate,
    personalityInstructionUpdate,
  ].filter((message): message is LLMMessage => message !== undefined);
  const priorFull =
    contextualInstructionUpdates.length > 0
      ? [...priorExisting, ...contextualInstructionUpdates]
      : priorExisting;
  const durableHistoryStartIndex = system ? 1 : 0;

  let state: TurnState = buildInitialTurnState(ctx, user, {
    priorMessages: priorFull,
  });
  let persistedMessageCount = priorExisting.length;
  const rolloutPersistenceSuspended = (): boolean =>
    session.isRolloutPersistenceSuspended?.() === true;
  const persistTurnRolloutBaseline = (): void => {
    if (rolloutPersistenceSuspended()) return;
    session.rolloutStore?.appendRollout({
      type: "turn_context",
      payload: referenceContextItem,
    });
  };
  const persistNewResponseItems = (): void => {
    if (rolloutPersistenceSuspended()) return;
    if (!session.rolloutStore) return;
    if (state.messages.length < persistedMessageCount) {
      persistedMessageCount = state.messages.length;
    }
    const nextItems = state.messages.slice(persistedMessageCount);
    for (const message of nextItems) {
      session.rolloutStore.appendRollout({
        type: "response_item",
        payload: toResponseItem(message),
      });
    }
    persistedMessageCount = state.messages.length;
  };
  const syncSessionState = async (): Promise<void> => {
    persistNewResponseItems();
    const durableHistory = state.messages.slice(durableHistoryStartIndex);
    const autoCompactTokenLimit = getAutoCompactTokenLimit(ctx);
    const resolvedPersonality = resolveTurnPersonality(ctx);
    await session.state.with((sessionState) => {
      sessionState.history = durableHistory.map((message) => ({
        ...message,
        ...(Array.isArray(message.content)
          ? { content: message.content.map((part) => ({ ...part })) }
          : {}),
        ...(message.toolCalls !== undefined
          ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) }
          : {}),
      }));
      sessionState.previousTurnSettings = {
        model: ctx.modelInfo.slug,
        ...(ctx.realtimeActive !== undefined
          ? { realtimeActive: ctx.realtimeActive }
          : {}),
        ...(resolvedPersonality !== undefined
          ? { personality: resolvedPersonality }
          : {}),
        ...(autoCompactTokenLimit !== undefined
          ? { autoCompactTokenLimit }
          : {}),
        ...(ctx.modelInfo.contextWindow !== undefined
          ? {
              contextWindow: ctx.modelInfo.contextWindow,
              modelInfo: {
                contextWindow: ctx.modelInfo.contextWindow,
                ...(autoCompactTokenLimit !== undefined
                  ? { autoCompactTokenLimit }
                  : {}),
              },
            }
          : {}),
      };
      sessionState.referenceContextItem = referenceContextItem;
    });
  };

  // Upstream agenc runtime resets per-turn guardian-denial counters at the top
  // of every new turn (see `GuardianRejectionCircuitBreaker::clear_turn`
  // usage around task start in `agenc-rs/core/src/guardian/review.rs`).
  // We run it here — after `spawnTask` installed the new `ActiveTurn`
  // for `ctx.subId` and before any phase work that could record a
  // denial — so a previous turn's leftover counters or interrupt flag
  // cannot bleed into this turn's `isOpen(ctx.subId)` check below.
  session.services.guardianRejectionCircuitBreaker?.clearTurn(ctx.subId);

  emitTurnStarted();
  persistTurnRolloutBaseline();
  session.budgetTracker?.resetForTurn();

  // T6 gap #119: emit the seed user message exactly once per runTurn
  // invocation. Continuation turns (needsFollowUp=true) stay inside the
  // same generator so this fires once per user-initiated turn, not per
  // phase iteration.
  if (opts.displayUserMessage !== null) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "user_message",
        payload: {
          message: opts.displayUserMessage ?? userContent,
          displayText: opts.displayUserMessage ?? userContentDisplayText(userContent),
          ...(Array.isArray(userContent)
            ? {
                images: userContent
                  .filter((part) => part.type === "image_url")
                  .map((part) => part.image_url.url),
              }
            : {}),
        },
      },
    });
  }
  persistNewResponseItems();

  // agenc runtime: run_pre_sampling_compact before any phase runs. Returns
  // whether compaction happened; if yes and we had a prewarmed
  // client session, reset it (agenc runtime 155-157 — AgenC has no prewarm
  // today).
  try {
    await runPreSamplingCompact(session, ctx, state);
  } catch (error) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "error",
        payload: {
          cause: "pre_sampling_compact_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
    // agenc runtime: "return None" on pre-compact failure.
    await syncSessionState();
    emitTurnComplete("");
    const terminal: Terminal = { reason: "completed" };
    yield {
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    return terminal;
  }

  // Merge external opts.signal, the session-level abort, and the
  // task-local abort from `spawnTask`. Upstream agenc runtime `start_task`
  // constructs a child `CancellationToken` for the running task
  // (see `tasks/mod.rs` line 269) whose cancellation is triggered
  // by `abort_all_tasks`. The merged signal here is the gut
  // equivalent of `task_cancellation_token.child_token()`.
  const signal = mergeSignals(
    mergeSignals(opts.signal, session.abortController.signal),
    runningTask.abortController.signal,
  );

  let usage: LLMUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let lastContent = "";

  yield { type: "turn_start", turnIndex: 0 };

  // The phase loop — agenc runtime's "while streaming & tools" outer loop.
  while (true) {
    if (signal.aborted) {
      await drainInFlight(state, ctx, session);
      // T6 gap #119: cancellation path gets `turn_aborted` so rollouts
      // close the turn boundary with the actual reason.
      await syncSessionState();
      emitTurnAborted(
        String((signal as AbortSignal & { reason?: unknown }).reason ?? "cancelled"),
      );
      const terminal: Terminal = { reason: "cancelled" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      };
      return terminal;
    }

    // Guardian-rejection circuit-breaker interrupt (inspected runtime
    // `guardian/review.rs::record_guardian_denial` → `session.abort_turn_if_active(turn_id, Interrupted)`).
    // Detection-site writers call `recordDenial(turnId)` on the breaker
    // when a guardian review rejects an approval; the first crossing of
    // the consecutive-or-total threshold flips `interruptTriggered=true`
    // for that turn. We re-check here at the top of every phase
    // iteration so an interrupt raised during the just-finished
    // iteration's tool dispatch aborts the next iteration cleanly
    // instead of issuing another sampling request. The live writer is
    // `permissions/guardian/reviewer.ts`, reached from the tool approval
    // orchestrator when `approvalsReviewer` is `auto_review`.
    const breaker = session.services.guardianRejectionCircuitBreaker;
    if (breaker?.isOpen(ctx.subId) === true) {
      await drainInFlight(state, ctx, session);
      await syncSessionState();
      emitTurnAborted("guardian_breaker_open");
      // Propagate the interrupt through the task dispatcher so in-flight
      // tasks see their cancellation signal trip and pending approvals
      // clear under the active-turn lock. Upstream invokes
      // `session.abort_turn_if_active(turn_id, TurnAbortReason::Interrupted)`.
      await session.abortTurnIfActive(ctx.subId, "interrupted");
      const terminal: Terminal = { reason: "cancelled" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      };
      return terminal;
    }

    const maxTurns = resolveMaxTurns(ctx);
    if (state.turnCount > maxTurns) {
      await drainInFlight(state, ctx, session);
      await syncSessionState();
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "max_turns" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "max_turns",
      };
      return terminal;
    }

    // I-13: pending provider switch — complete this turn cleanly so
    // the next turn's pre-sampling compact considers the new model.
    if (session.pendingProviderSwitch) {
      await drainInFlight(state, ctx, session);
      await syncSessionState();
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "completed",
      };
      return terminal;
    }

    resetIterationFields(state);

    // agenc runtime run_sampling_request — phases 1-4.
    const pending: PhaseEvent[] = [];
    // Hoisted so the mid-turn compaction check after the try/catch can
    // read the just-returned model_needs_follow_up signal. agenc runtime reads
    // this from `SamplingRequestResult` at turn.rs:468-476 right before
    // the `token_limit_reached && needs_follow_up` arm at turn.rs:493.
    let modelNeedsFollowUp = false;
    try {
      const result = await runSamplingRequest(state, ctx, session, signal, pending);
      for (const ev of pending) {
        recordTurnTimingForPhaseEvent(ctx, ev);
        yield ev;
      }
      // D1 fix: accumulate real provider usage returned from the
      // sampling request so the terminal turn_complete event carries
      // cumulative token consumption across continuation iterations.
      usage = cumulativeUsage(usage, result.usage);
      modelNeedsFollowUp = result.needsFollowUp;
      if (result.terminal) {
        if (result.assistantText.length > 0) {
          lastContent = result.assistantText;
        }
        await syncSessionState();
        emitTurnComplete(lastContent);
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: terminalToStopReason(result.terminal.reason),
        };
        return result.terminal;
      }
    } catch (error) {
      await drainInFlight(state, ctx, session);
      for (const ev of pending) {
        recordTurnTimingForPhaseEvent(ctx, ev);
        yield ev;
      }
      const sme = error instanceof StreamModelError ? error : undefined;
      const underlying =
        (sme?.cause instanceof Error ? sme.cause : undefined) ??
        (error instanceof Error ? error : new Error(String(error)));
      if (signal.aborted) {
        // T6 gap #119: cancelled-with-error still gets `turn_aborted`
        // so rollout reconstruction sees a closed turn boundary.
        emitTurnAborted(
          String(
            (signal as AbortSignal & { reason?: unknown }).reason ??
              underlying.message ??
              "cancelled",
          ),
        );
        const terminal: Terminal = { reason: "cancelled" };
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: "cancelled",
          error: underlying,
        };
        return terminal;
      }
      // T6 gap #119: error-terminated turn still completes the turn
      // boundary for rollout reducers.
      await syncSessionState();
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "completed", error: underlying };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "error",
        error: underlying,
      };
      return terminal;
    }

    // Recovery re-entry? postSampleRecovery or continuationNudge may
    // have set state.transition — all 8 reasons route to PrepareContext
    // per PhaseTransition table.
    if (state.transition !== undefined) {
      if (
        state.transition.reason === "model_fallback" &&
        session.pendingProviderSwitch !== null &&
        typeof sessionOwner.consumePendingProviderSwitch === "function"
      ) {
        await sessionOwner.consumePendingProviderSwitch();
      }
      state.transition = undefined;
      continue;
    }

    // Mid-turn compaction — port of agenc runtime `turn.rs:493-508`. When the
    // just-finished sampling step pushed total token usage at or past
    // the current model's auto-compact limit AND a follow-up is still
    // required (tool calls pending or mailbox has queued user input),
    // compact before the next sampling request instead of letting the
    // next prepareContext stage blow through the window.
    //
    // agenc runtime contract reconstructed here:
    //   token_limit_reached = total_usage_tokens >= auto_compact_limit
    //   needs_follow_up     = model_needs_follow_up || has_pending_input
    //   if both: run_auto_compact(MidTurn) -> reset_websocket_session -> continue
    //
    // AgenC signal mapping:
    //   model_needs_follow_up ← `result.needsFollowUp` (set by stream-model
    //     when `toolUseBlocks.length > 0`; cleared by execute-tools after
    //     dispatch, so we must evaluate BEFORE execute-tools runs below).
    //   has_pending_input     ← `session.hasPendingInput()` (mailbox queue).
    //   total_usage_tokens    ← `getTotalTokenUsage(session)` reads the
    //     cross-turn cumulative `SessionState.totalTokenUsage` maintained
    //     by the stream-model writer (phases/stream-model.ts) after every
    //     provider response, mirroring agenc runtime
    //     `TokenUsageInfo::append_last_usage` (protocol.rs:2294-2297).
    //   auto_compact_limit    ← `ctx.modelInfo.autoCompactTokenLimit`.
    //
    // Provider continuity reset (agenc runtime `client_session.reset_websocket_session()`):
    //   `runAutoCompact` → `autoCompactIfNeeded` → `runPostCompactCleanup`
    //   → `context.clearProviderResponseId()` wires through
    //   `session.clearProviderResponseId()`, which is AgenC's equivalent.
    //   That covers the reset when compaction actually runs; we add an
    //   explicit `session.bindProviderConversation()` rebind after
    //   compaction to mirror agenc runtime's "the next sampling request must
    //   look like a fresh conversation" guarantee.
    //
    // AgenC behavior: mid-turn compaction must re-inject the current
    // reference-context snapshot immediately before the last real user
    // message in the compacted replacement history. That wiring is
    // carried by `before_last_user_message` through runAutoCompact →
    // autoCompactIfNeeded → compactConversation/session-memory compact.
    const hasPendingInput = session.hasPendingInput();
    const pendingAssistantToolCalls =
      state.assistantMessages.at(-1)?.toolCalls.length ?? 0;
    const needsFollowUpForCompact =
      modelNeedsFollowUp ||
      state.toolUseBlocks.length > 0 ||
      pendingAssistantToolCalls > 0 ||
      hasPendingInput;
    const explicitAutoCompactLimit = finitePositive(
      (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
        .autoCompactTokenLimit,
    );
    const autoCompactLimit =
      explicitAutoCompactLimit ??
      getAutoCompactTokenLimit(ctx) ??
      Number.POSITIVE_INFINITY;
    const totalUsageTokens = Math.max(
      getTotalTokenUsage(session),
      usage.totalTokens,
      state.lastResponseUsage?.totalTokens ?? 0,
    );
    const tokenLimitReached = totalUsageTokens >= autoCompactLimit;

    if (tokenLimitReached && needsFollowUpForCompact) {
      let midTurnCompacted = false;
      try {
        midTurnCompacted = await runAutoCompact(
          session,
          ctx,
          "before_last_user_message",
          "context_limit",
          "in_turn",
          state,
        );
      } catch (error) {
        // agenc runtime returns None on mid-turn compact failure. AgenC's
        // analogue is to terminate the turn cleanly with an error
        // event so rollout reducers see a closed turn boundary.
        // Matches the failure handling pattern used by
        // `pre_sampling_compact_failed` at the top of runTurnKernel.
        await drainInFlight(state, ctx, session);
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "error",
            payload: {
              cause: "mid_turn_compact_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        });
        await syncSessionState();
        emitTurnComplete(lastContent);
        const underlying =
          error instanceof Error ? error : new Error(String(error));
        const terminal: Terminal = { reason: "completed", error: underlying };
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: "error",
          error: underlying,
        };
        return terminal;
      }

      if (!midTurnCompacted) {
        // agenc runtime's `is_err()` arm fires only on dispatcher failure. If
        // the dispatcher ran but reported `wasCompacted=false` (circuit
        // breaker tripped, feature disabled, or threshold logic inside
        // the compact module disagreed with our outer check), we do NOT
        // loop — that would spin forever with unchanged state. Surface
        // the token-limit condition as a terminal error matching the
        // semantics of agenc runtime's `return None`.
        await drainInFlight(state, ctx, session);
        const reasonText = `mid_turn_compact_skipped: tokens=${totalUsageTokens} limit=${autoCompactLimit}`;
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "error",
            payload: {
              cause: "mid_turn_compact_failed",
              message: reasonText,
            },
          },
        });
        await syncSessionState();
        emitTurnComplete(lastContent);
        const underlying = new Error(reasonText);
        const terminal: Terminal = { reason: "completed", error: underlying };
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: "error",
          error: underlying,
        };
        return terminal;
      }

      // agenc runtime `client_session.reset_websocket_session()` parity.
      // `runAutoCompact` → `runPostCompactCleanup` already called
      // `session.clearProviderResponseId()` via the compact context;
      // rebind the provider HTTP client to the current conversation
      // so the next request opens a fresh continuation under the same
      // conversationId (agenc runtime's websocket session is keyed per
      // conversation the same way).
      session.bindProviderConversation();
      // agenc runtime sets `can_drain_pending_input = !model_needs_follow_up;`
      // to gate mailbox drain on the outer loop's next iteration. AgenC
      // does not yet surface a matching gate (the phase machine drains
      // pending input whenever `prepareContext` decides), so there is
      // nothing to set here; the session mailbox fires naturally on the
      // next iteration.
      continue;
    }

    const lastAssistant = state.assistantMessages.at(-1);
    const assistantText = lastAssistant?.text ?? "";
    if (assistantText.length > 0) lastContent = assistantText;

    // No tool calls + no transition → commit + terminate.
    if (!state.needsFollowUp && state.toolUseBlocks.length === 0) {
      await commit(state, ctx, session, signal);
      await syncSessionState();
      // commit may set a stop-hook transition (I-17). If so, re-enter.
      if (state.transition !== undefined) {
        state.transition = undefined;
        continue;
      }
      const stopReason = assistantText.length === 0 ? "empty_response" : "completed";
      launchMagicDocsPostSampling(state, session, signal);
      launchSessionMemoryPostSampling(state, session, ctx, signal);
      // T6 gap #119: canonical happy-path `turn_complete` so rollouts
      // record the close of this turn's lifecycle.
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason,
      };
      await drainPendingExtraction();
      return terminal;
    }

    // Phase 5 — execute tools. Emit tool_call / tool_result events
    // around the dispatch.
    if (lastAssistant && lastAssistant.toolCalls.length > 0) {
      for (const toolCall of lastAssistant.toolCalls) {
        const event: PhaseEvent = { type: "tool_call", toolCall };
        recordTurnTimingForPhaseEvent(ctx, event);
        yield event;
      }
    }
    await executeTools(state, ctx, session, signal);
    if (lastAssistant) {
      const completedByCallId = new Map(
        state.completedToolResults.map((record) => [record.callId, record]),
      );
      for (let i = 0; i < lastAssistant.toolCalls.length; i += 1) {
        const call = lastAssistant.toolCalls[i];
        const userRec = state.toolResults[i];
        if (!call || !userRec) continue;
        const completed = completedByCallId.get(call.id);
        yield {
          type: "tool_result",
          toolCall: call,
          result: {
            content:
              completed?.content ??
              (typeof userRec.content === "string" ? userRec.content : ""),
            isError: completed?.isError ?? false,
            ...(completed?.metadata !== undefined
              ? { metadata: completed.metadata }
              : {}),
          },
        };
      }
    }

    const postToolExplicitAutoCompactLimit = finitePositive(
      (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
        .autoCompactTokenLimit,
    );
    const postToolAutoCompactLimit =
      postToolExplicitAutoCompactLimit ??
      getAutoCompactTokenLimit(ctx) ??
      Number.POSITIVE_INFINITY;
    const postToolTokenLimitReached =
      Math.max(
        getTotalTokenUsage(session),
        usage.totalTokens,
        state.lastResponseUsage?.totalTokens ?? 0,
      ) >= postToolAutoCompactLimit;
    if (
      postToolTokenLimitReached &&
      (state.needsFollowUp || state.toolResults.length > 0)
    ) {
      const midTurnCompacted = await runAutoCompact(
        session,
        ctx,
        "before_last_user_message",
        "context_limit",
        "in_turn",
        state,
      );
      if (midTurnCompacted) {
        session.bindProviderConversation();
        continue;
      }
    }

    // Phase 6 — commit iteration. Stop-hook may request re-entry.
    await commit(state, ctx, session, signal);
    await syncSessionState();

    // Token-budget decision from streamModel: if exceeded, run-turn
    // today takes the cautious path and terminates. T8 wires the
    // token_budget_continuation recovery that re-enters prepare.
    if (state.pendingBudgetDecision?.kind === "stop") {
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "completed",
      };
      return terminal;
    }

    // D1 fix: usage is accumulated immediately after runSamplingRequest
    // returns (above). No-op dummy accumulation removed.
    // loop back for another sampling request
  }
}

export function runTurn(
  session: Session,
  ctx: TurnContext,
  userMessage: string | readonly LLMContentPart[],
  opts: RunTurnOptions = {},
): AsyncGenerator<PhaseEvent, Terminal> {
  const sessionOwner = session as Session & {
    runTurn?: (
      userMessage: string | readonly LLMContentPart[],
      opts?: {
        ctx?: TurnContext;
        systemPrompt?: string;
        history?: readonly LLMMessage[];
        signal?: AbortSignal;
        displayUserMessage?: string | null;
      },
    ) => AsyncGenerator<PhaseEvent, Terminal>;
  };
  if (typeof sessionOwner.runTurn === "function") {
    return sessionOwner.runTurn(userMessage, {
      ctx,
      systemPrompt: opts.systemPrompt,
      history: opts.history,
      signal: opts.signal,
      displayUserMessage: opts.displayUserMessage,
    });
  }
  return runTurnKernel(session, ctx, userMessage, opts);
}

export type { Continue, Terminal };

// ─────────────────────────────────────────────────────────────────────
// Plan-mode helpers — port of agenc runtime turn.rs:1537-1793. Exported from
// run-turn.ts so existing call sites can tree-shake them. The
// implementations live in `./plan-mode.ts` because they're pure helpers
// with no dependency on the outer turn loop.
// ─────────────────────────────────────────────────────────────────────

export {
  createPlanModeStreamState,
  emitAgentMessageInPlanMode,
  emitStreamedAssistantTextDelta,
  flushAssistantTextSegmentsAll,
  flushAssistantTextSegmentsForItem,
  handleAssistantItemDoneInPlanMode,
  handlePlanSegments,
  isPlanMode,
  maybeCompletePlanItemFromMessage,
  realtimeTextForEvent,
} from "./plan-mode.js";

export type {
  AssistantMessageStreamParsersLike,
  ParsedAssistantTextDelta,
  PlanItem,
  PlanItemState,
  PlanModeStreamState,
  PlanResponseItem,
  PlanSegment,
  PlanTurnItem,
} from "./plan-mode.js";
