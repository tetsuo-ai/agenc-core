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

import type {
  LLMContentPart,
  LLMMessage,
  LLMToolCall,
  LLMUsage,
} from "../llm/types.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../tools/untrusted-tool-result-framing.js";
import {
  hasExactLedgerMention,
  LEDGER_ROOT_TURN_ROUTING_GUIDANCE,
} from "../elicitation/request-ledger-transfer.js";
import {
  hasLedgerWalletCliMention,
  LEDGER_WALLET_CLI_ROUTING_GUIDANCE,
} from "../elicitation/ledger-wallet-cli.js";
import { startCodeModeTurnWorker } from "../tools/code-mode/turn-host.js";
import { commit } from "../phases/commit.js";
import {
  continuationNudge,
  injectNudgeMessage,
} from "../phases/continuation-nudge.js";
import type { PhaseEvent } from "../phases/events.js";
import { executeTools } from "../phases/execute-tools.js";
import { runMagicDocsPostSamplingHook } from "../services/MagicDocs/magicDocs.js";
import { runSessionMemoryPostSamplingHook } from "../memory/session/sessionMemory.js";
import { createAdmittedMemorySelector } from "../memory/admitted-selector.js";
import {
  applyPendingBudgetContinuation,
  postSampleRecovery,
} from "../phases/post-sample-recovery.js";
import { getAttachments } from "../prompts/attachments/orchestrator.js";
import { getAttachmentTrackingState } from "./attachment-state.js";
import { claimRequiredSwarmToolChoice } from "../prompts/attachments/swarm-mode.js";
import {
  frameWorkspaceAgentRoleGuidance,
  resolveLiveInstructionEnvelope,
  type LiveInstructionPolicy,
} from "../prompts/live-instructions.js";
import { attachmentsToMessages } from "../prompts/attachments/messages.js";
import { projectRetainedAttachments } from "./attachment-retention.js";
import { extractMentionAllowedRoots } from "../prompts/file-mentions.js";
import { seedFileMentionAttachmentSessionReads } from "./file-mention-session-reads.js";
import {
  streamModel,
  StreamModelError,
  type StreamModelRequestContract,
} from "../phases/stream-model.js";
import {
  isMediaTooLargeMessage,
  isPartialProviderResponseError,
  isTransientProviderError,
  isWithheld413Message,
  isWithheldMaxOutputTokens,
} from "../recovery/api-errors.js";
import { reconnectWithBackoff } from "../recovery/reconnection.js";
import {
  MAX_RECOVERY_REENTRIES,
  reserveRecoveryReentry,
} from "../recovery/fallback-ladder.js";
import * as planModeHelpers from "./plan-mode.js";
import type { ResponseItem } from "./rollout-item.js";
import type { Session } from "./session.js";
import {
  llmMessageToCheckpointResponseItem,
  llmMessageToDurableResponseItem,
} from "./message-history-conversion.js";
import {
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
import { SLEEP_TOOL_NAME } from "../tools/SleepTool/prompt.js";
import {
  advanceModelSampleOrdinal,
  buildInitialTurnState,
  resetIterationFields,
  restoreFromCheckpoint,
  toCheckpointSlice,
  type Continue,
  type Terminal,
  type TurnState,
} from "./turn-state.js";
import {
  currentBuildId,
  resolveDurableTurnsConfig,
  sideEffectHaltMessage,
} from "./durable-turns.js";
import {
  DURABLE_CHECKPOINT_WRITE_VERSION,
  computeCheckpointPrefixHashV3,
} from "./durable-checkpoint-reader.js";
import {
  createToolResultIntegrity,
  verifyToolResultIntegrity,
} from "./tool-result-integrity.js";
import {
  evaluateBehavioralBackstop,
  recordBehavioralStep,
  resolveBehavioralConfig,
  type BehavioralConfig,
} from "./behavioral-backstop.js";
import {
  EDITOR_INTERACTION_MAX_SAMPLING_ITERATIONS,
  EDITOR_INTERACTION_MAX_TOOL_CALLS,
} from "./editor-interaction.js";
import { EDITOR_PROPOSAL_TOOL_NAME } from "../tools/system/editor-proposal.js";
import type { AssistantOutputStreamSink } from "../contracts/assistant-output-stream.js";
import {
  buildPersonalitySpecUpdateMessage,
  buildRealtimeInstructionUpdateMessage,
  buildSeedMessages,
  excludeFromDurableHistory,
  mergePendingInputIntoUserContent,
  messageText,
  readRealtimeUpdateBaseline,
  resolveModelInstructionsForTurn,
  resolveTurnPersonality,
  userContentDisplayText,
  userContentHasInput,
} from "./run-turn-messages.js";
import {
  drainQueuedCommandsAfterTools,
  isMainThreadQueueSource,
  isSubagentSessionSource,
  pendingInputOwnershipForTurn,
  sessionQuerySourceForTurn,
} from "./run-turn-queued-commands.js";
import {
  cancelQueuedInterruptedTools,
  cleanupInterruptedStreamAttempt,
  interruptedStreamRetryBlockReason,
  isRetryableStreamError,
  streamRetryErrorStatus,
  streamRetryNoticeMessage,
  suppressInterruptedStreamToolHistory,
  type InterruptedStreamHistoryState,
} from "./run-turn-stream-retry.js";
import {
  boundInMemoryToolResultContent,
  getAgenCPreparedTerminal,
  prepareAgenCTurnContext,
} from "./run-turn-query-messages.js";
import {
  extractLastUserText,
  insertContextMessagesBeforeCurrentUser,
  placeRetainedAttachments,
} from "./run-turn-attachments.js";
import {
  buildSamplingRequestContract,
  builtTools,
  discoverDirectMcpToolMentions,
  enforcePlanModeToolBoundary,
  snapshotSamplingRequestContract,
} from "./run-turn-sampling-request.js";
import {
  getActiveContextTokenUsage,
  getAutoCompactTokenLimit,
  getPreSamplingAutoCompactTokenLimit,
  runAutoCompact,
  runPreSamplingCompact,
} from "./run-turn-compaction.js";

// Declarations that moved to the run-turn-* sibling modules. Re-exported so
// every importer of run-turn.js keeps its surface.
export {
  streamRetryNoticeMessage,
  isRetryableStreamError,
} from "./run-turn-stream-retry.js";
export {
  EDITOR_INTERACTION_MAX_QUERY_TOKENS,
} from "./run-turn-query-messages.js";
export {
  insertContextMessagesAfterLeadingSystem,
  insertContextMessagesBeforeCurrentUser,
} from "./run-turn-attachments.js";
export { buildPrompt, builtTools } from "./run-turn-sampling-request.js";
export type { BuiltPrompt } from "./run-turn-sampling-request.js";
export {
  projectTurnCompactionReplacementHistoryForTests,
  setAutoCompactImplForTests,
  maybeRunPreviousModelInlineCompact,
} from "./run-turn-compaction.js";
export type {
  CompactionReason,
  CompactionPhase,
  InitialContextInjection,
  AutoCompactResult,
  AutoCompactImpl,
} from "./run-turn-compaction.js";

export interface RunTurnOptions {
  readonly systemPrompt?: string;
  /** Classifies a supplemental prompt without allowing it to replace core instructions. */
  readonly systemPromptTrust?: "trusted_internal" | "workspace_role";
  /** Compatibility-only escape hatch for a caller that already assembled the full base. */
  readonly systemPromptReplacesBase?: boolean;
  readonly history?: readonly LLMMessage[];
  /** Whether caller-supplied history already exists in this rollout store. */
  readonly initialHistoryPersistence?:
    "already_persisted" | "persist_before_turn";
  /** Authenticated durable metadata for the current seed user message. */
  readonly seedUserMessageRuntimeOnly?: LLMMessage["runtimeOnly"];
  readonly signal?: AbortSignal;
  /** Optional synchronous sink for bounded provider assistant-text deltas. */
  readonly assistantOutputSink?: AssistantOutputStreamSink;
  readonly querySource?: string;
  readonly skipCacheWrite?: boolean;
  /** Workspace instruction policy. Agentic turns default to workspace_agent. */
  readonly instructionPolicy?: LiveInstructionPolicy;
  /**
   * Optional transcript-facing text when the model-visible prompt was
   * expanded. `null` suppresses the user-message transcript event for
   * internal meta turns such as autonomous keepalive ticks.
   */
  readonly displayUserMessage?: string | null;
  /**
   * Trusted root-human text for runtimes that render the transcript outside
   * runTurn and therefore pass displayUserMessage:null to suppress duplicates.
   * Never model-supplied; daemon turn drivers derive it from Session.submit.
   */
  readonly rootHumanTurnText?: string;
  /**
   * GOAL #4b Stage 1 — durable-turn resume. When set, the kernel re-enters
   * the drain loop CONTINUING an interrupted turn from the last completed
   * iteration instead of starting fresh: it restores the TurnState slice,
   * seeds the iteration/checkpoint counters, suppresses the seed
   * user-message re-emit, and emits a durable `turn_resumed` marker. Only
   * supplied by `thread-manager`'s safe-policy resume path AFTER the
   * build-pin + prefix-hash + lease gates pass.
   */
  readonly resume?: TurnResumeOptions;
}

/**
 * GOAL #4b Stage 1 — the rehydrated state handed to a resumed kernel.
 * Construction + all safety gating live in `thread-manager.ts`; the kernel
 * trusts that the caller already validated build pin, prefix hash, lease,
 * and the safe-by-default side-effect policy.
 */
export interface TurnResumeOptions {
  readonly turnId: string;
  readonly fromIteration: number;
  readonly fromCheckpointSeq: number;
  readonly persistedMessageCount: number;
  /** Applied onto the fresh TurnState via `restoreFromCheckpoint`. */
  readonly restoreSlice: import("./turn-state.js").TurnCheckpointSlice;
  /** Tool names that triggered a safe-policy halt (surfaced, not retried). */
  readonly haltedSideEffectingTools?: ReadonlyArray<string>;
  /**
   * Dangling `tool_use` blocks (in the resumed prefix, no persisted result)
   * to PAIR with a synthetic `tool` result so the message thread stays valid
   * for the first sampling request — WITHOUT re-dispatching the tool.
   * `halt:true` ⇒ side-effecting/interactive ⇒ surfaced "not retried"; else
   * read-only ⇒ note that re-invoking is safe.
   */
  readonly danglingPairings?: ReadonlyArray<{
    readonly callId: string;
    readonly toolName: string;
    readonly halt: boolean;
  }>;
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

export {
  EDITOR_INTERACTION_MAX_SAMPLING_ITERATIONS,
  EDITOR_INTERACTION_MAX_TOOL_CALLS,
} from "./editor-interaction.js";

function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!a) return { signal: b, dispose: () => {} };
  if (a.aborted) return { signal: a, dispose: () => {} };
  if (b.aborted) return { signal: b, dispose: () => {} };
  const merged = new AbortController();
  // Cross-remove both listeners when either fires so the listener left on
  // a long-lived signal (e.g. the session-level abort, which is a single
  // readonly AbortController for the whole session) is dropped on abort.
  const dispose = (): void => {
    a.removeEventListener("abort", onA);
    b.removeEventListener("abort", onB);
  };
  const onA = (): void => {
    dispose();
    merged.abort((a as AbortSignal & { reason?: unknown }).reason);
  };
  const onB = (): void => {
    dispose();
    merged.abort((b as AbortSignal & { reason?: unknown }).reason);
  };
  a.addEventListener("abort", onA);
  b.addEventListener("abort", onB);
  // The returned `dispose` is invoked by the turn kernel's finally block so
  // the happy path (turn completes without abort) also removes the listener
  // left on the long-lived session signal, preventing an unbounded
  // per-turn listener/memory leak.
  return { signal: merged.signal, dispose };
}

function cumulativeUsage(acc: LLMUsage, next: LLMUsage | undefined): LLMUsage {
  if (!next) return acc;
  return {
    promptTokens: acc.promptTokens + (next.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (next.completionTokens ?? 0),
    totalTokens: acc.totalTokens + (next.totalTokens ?? 0),
    cachedInputTokens:
      (acc.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheCreationInputTokens:
      (acc.cacheCreationInputTokens ?? 0) +
      (next.cacheCreationInputTokens ?? 0),
    reasoningOutputTokens:
      (acc.reasoningOutputTokens ?? 0) + (next.reasoningOutputTokens ?? 0),
    webSearchRequests:
      (acc.webSearchRequests ?? 0) + (next.webSearchRequests ?? 0),
  };
}

function sealToolResultMessage(message: LLMMessage, runId: string): LLMMessage {
  if (message.role !== "tool") {
    if (message.runtimeOnly?.toolResultIntegrity !== undefined) {
      throw new Error(
        "tool-result integrity metadata is attached to a non-tool message",
      );
    }
    return message;
  }
  const toolCallId = message.toolCallId;
  if (toolCallId === undefined || toolCallId.trim().length === 0) {
    throw new Error("durable tool result is missing its tool-call identity");
  }
  const existing = message.runtimeOnly?.toolResultIntegrity;
  if (existing !== undefined) {
    const verification = verifyToolResultIntegrity({
      integrity: existing,
      expectedRunId: runId,
      toolCallId,
      content: message.content,
    });
    if (verification.status !== "valid") {
      throw new Error(
        `durable tool-result integrity refused: ${verification.failure.reason}`,
      );
    }
    return message;
  }
  return {
    ...message,
    runtimeOnly: {
      ...message.runtimeOnly,
      toolResultIntegrity: createToolResultIntegrity({
        runId,
        toolCallId,
        content: message.content,
      }),
    },
  };
}

function requireSealedToolResult(message: ResponseItem): void {
  if (message.role === "tool" && message.toolResultIntegrity === undefined) {
    throw new Error("checkpoint v2 requires every tool result to be sealed");
  }
}

function terminalToStopReason(
  reason: Terminal["reason"],
): Extract<PhaseEvent, { type: "turn_complete" }>["stopReason"] {
  switch (reason) {
    case "completed":
    case "max_turns":
    case "max_budget_usd":
    case "cancelled":
    case "no_progress": // honest mapping, NOT default→"error" (would mask it as a crash)
      return reason;
    default:
      return "error";
  }
}

const PRE_SAMPLING_COMPACT_FAILED_CAUSE = "pre_sampling_compact_failed";
const MID_TURN_COMPACT_FAILED_CAUSE = "mid_turn_compact_failed";

const EMPTY_SYNTHETIC_USAGE: LLMUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  availability: "unknown",
  provenance: "synthetic",
};

function compactFailureError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function emitTurnWarning(
  session: Session,
  cause:
    | typeof PRE_SAMPLING_COMPACT_FAILED_CAUSE
    | typeof MID_TURN_COMPACT_FAILED_CAUSE
    | EditorRequestFailureCause,
  message: string,
): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause,
        message,
      },
    },
  });
}

function compactFailedTurnComplete(
  content: string,
  usage: LLMUsage,
  error: Error,
): Extract<PhaseEvent, { type: "turn_complete" }> {
  return {
    type: "turn_complete",
    content,
    usage,
    stopReason: "compact_failed",
    error,
  };
}

const EDITOR_INTERACTION_LIMIT_CAUSE = "editor_interaction_limit";
const EDITOR_PROPOSAL_MISSING_CAUSE = "editor_proposal_missing";
const EDITOR_RECOVERY_BLOCKED_CAUSE = "editor_interaction_recovery_blocked";

type EditorRequestFailureCause =
  | typeof EDITOR_INTERACTION_LIMIT_CAUSE
  | typeof EDITOR_PROPOSAL_MISSING_CAUSE
  | typeof EDITOR_RECOVERY_BLOCKED_CAUSE;

function isEditorRecoveryBlockedError(error: Error): boolean {
  return error.message.startsWith(`${EDITOR_RECOVERY_BLOCKED_CAUSE}:`);
}

function editorRequestFailedTurnComplete(
  content: string,
  usage: LLMUsage,
  error: Error,
): Extract<PhaseEvent, { type: "turn_complete" }> {
  return {
    type: "turn_complete",
    content,
    usage,
    stopReason: "editor_request_failed",
    error,
  };
}

function launchMagicDocsPostSampling(
  state: TurnState,
  session: Session,
  querySource: string,
  signal?: AbortSignal,
): void {
  void runMagicDocsPostSamplingHook({
    messages: state.messages,
    querySource,
    session,
    ...(signal !== undefined ? { signal } : {}),
  }).catch((error) => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "magic_docs_update_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
  });
}

function launchSessionMemoryPostSampling(
  state: TurnState,
  session: Session,
  ctx: TurnContext,
  querySource: string,
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
    querySource,
    session,
    ...(signal !== undefined ? { signal } : {}),
  }).catch((error) => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "session_memory_update_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
  });
}

function launchTerminalPostSampling(
  state: TurnState,
  session: Session,
  ctx: TurnContext,
  querySource: string,
  signal?: AbortSignal,
): void {
  // MagicDocs and session-memory post-sampling can launch background work
  // that writes outside the active buffer proposal. Editor turns never
  // inherit those ordinary Agent-side effects.
  if (ctx.editorInteraction !== undefined) return;
  launchMagicDocsPostSampling(state, session, querySource, signal);
  launchSessionMemoryPostSampling(state, session, ctx, querySource, signal);
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

type PreparedSamplingRequestBoundary =
  | {
      readonly kind: "request";
      readonly request: StreamModelRequestContract;
    }
  | {
      readonly kind: "terminal";
      readonly result: SamplingRequestResult;
    };

async function prepareSamplingRequestBoundary(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal: AbortSignal,
  events: PhaseEvent[],
  querySource: string,
): Promise<PreparedSamplingRequestBoundary> {
  await prepareAgenCTurnContext(state, ctx, session, querySource, signal);
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
      kind: "terminal",
      result: {
        needsFollowUp: false,
        lastAgentMessage: assistantText,
        assistantText,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          availability: "unknown",
          provenance: "synthetic",
        },
        terminal: prepareTerminal.terminal,
      },
    };
  }

  // Per-turn attachments run once, immediately before the retry-stable
  // request snapshot is captured. A reconnect must never consume one-shot
  // attachment state or observe a different prompt than the first attempt.
  const attachmentConfigStore = session.services.configStore;
  if (attachmentConfigStore === undefined) {
    throw new Error(
      "Cannot build session attachments without canonical ConfigStore home authority",
    );
  }
  const agencHome = attachmentConfigStore.homeContext.path;
  const currentConfig = attachmentConfigStore.current();
  const fileMentionAllowedRoots = extractMentionAllowedRoots(currentConfig);
  // Retained attachments first: producers see what the model already has in
  // front of it, and the bytes sent on earlier requests keep their place.
  // Editor interactions project one immutable revision and stay out of it.
  const retention =
    ctx.editorInteraction === undefined
      ? getAttachmentTrackingState(session).retainedAttachments
      : undefined;
  if (retention !== undefined) {
    state.messagesForQuery = projectRetainedAttachments(
      state.messagesForQuery,
      retention,
    ).messages;
  }
  const userInput = extractLastUserText(state.messagesForQuery);
  const rootHumanTurn = session.currentRootHumanTurn();
  if (ctx.editorInteraction === undefined) {
    discoverDirectMcpToolMentions(session, userInput);
  }
  const attachments = await getAttachments({
    ...(ctx.editorInteraction !== undefined
      ? { effectsPolicy: "local_read_only" as const }
      : {}),
    sessionKey: session,
    admittedMemorySelector: createAdmittedMemorySelector(session),
    // Producers hold only an opaque session key, so what they decide is
    // invisible to an operator unless they can report it. Routed to the
    // session log, not to the chat: these causes are outside the TUI's
    // user-visible allow-list.
    emitDiagnostic: ({ cause, message }) => {
      session.emit({
        id: session.nextInternalSubId(),
        msg: { type: "warning", payload: { cause, message } },
      });
    },
    turnProvenance: {
      turnId: ctx.subId,
      rootHumanTurn,
    },
    userInput,
    loadedTools: builtTools(session, ctx),
    discoveredToolNames:
      session.services.registry.getDiscoveredToolNames?.() ?? new Set(),
    messages: state.messagesForQuery,
    permissionContext: session.permissionModeRegistry.current(),
    cwd: ctx.cwd,
    ...(session.services.sandboxExecutionBroker !== undefined
      ? {
          sandboxExecutionBroker: session.services.sandboxExecutionBroker,
        }
      : {}),
    subagentDepth: ctx.depth,
    signal,
    agencHome,
    ...(fileMentionAllowedRoots !== undefined
      ? { fileMentionAllowedRoots }
      : {}),
    skillsManager: session.services.skillsManager,
    config: currentConfig,
    contextWindowTokens: ctx.modelInfo.contextWindow,
  });
  if (attachments.length > 0) {
    await seedFileMentionAttachmentSessionReads(
      session.conversationId,
      attachments,
    );
    const attachmentMessages = attachmentsToMessages(attachments);
    if (attachmentMessages.length > 0) {
      state.messagesForQuery =
        retention === undefined
          ? insertContextMessagesBeforeCurrentUser(
              state.messagesForQuery,
              attachmentMessages,
            )
          : placeRetainedAttachments(state, retention, attachmentMessages);
    }
  }
  if (retention !== undefined) state.attachmentsAnchoredForTurn = true;

  const request = buildSamplingRequestContract(state, session, ctx);
  const swarmToolChoice = claimRequiredSwarmToolChoice({
    trackingState: getAttachmentTrackingState(session),
    turnId: ctx.subId,
    subagentDepth: ctx.depth,
    planMode: planModeHelpers.isPlanMode(ctx),
    toolNames: request.tools.map((tool) => tool.function.name),
  });

  return {
    kind: "request",
    request: snapshotSamplingRequestContract({
      ...request,
      ...(swarmToolChoice !== undefined ? { toolChoice: swarmToolChoice } : {}),
    }),
  };
}

/**
 * Port of agenc runtime `try_run_sampling_request` (turn.rs:1828-2222). In
 * agenc runtime this is the single-attempt stream consumer: it streams the
 * already-snapshotted request, dispatches tool calls via the
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
  request: StreamModelRequestContract,
  signal: AbortSignal,
  events: PhaseEvent[],
  assistantOutputSink?: AssistantOutputStreamSink,
): Promise<SamplingRequestResult> {
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
    await streamModel(
      state,
      ctx,
      session,
      request,
      signal,
      assistantOutputSink,
    );
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
      isPartialProviderResponseError(streamModelError)
        ? streamModelError
        : (streamModelError.cause ?? streamModelError);
  } else {
    (state as TurnState & { lastStreamError?: unknown }).lastStreamError =
      undefined;
  }

  const assistantText = state.assistantMessages.at(-1)?.text ?? "";
  if (assistantText.length > 0) {
    events.push({ type: "assistant_text", content: assistantText });
  }

  if (ctx.editorInteraction !== undefined) {
    // Editor turns are bounded to the canonical model -> trusted read/proposal
    // tool loop. Agent recovery strategies may compact or rewrite messages,
    // inject continuation prompts, run hooks, or switch the shared route; none
    // of those mutations are valid inside an immutable Editor interaction.
    //
    // Do retain runSamplingRequest's outer reconnect wrapper: a transient
    // same-model transport retry replays the already-snapshotted request and
    // therefore does not change the prompt, model, or tool surface.
    state.pendingBudgetDecision = undefined;
    const lastAssistant = state.assistantMessages.at(-1);
    const blockedRecovery =
      state.transition !== undefined
        ? `transition:${state.transition.reason}`
        : lastAssistant !== undefined && isWithheld413Message(lastAssistant)
          ? "context_window"
          : lastAssistant !== undefined && isMediaTooLargeMessage(lastAssistant)
            ? "media_too_large"
            : lastAssistant !== undefined &&
                isWithheldMaxOutputTokens(lastAssistant)
              ? "max_output_tokens"
              : null;
    if (blockedRecovery !== null) {
      state.transition = undefined;
      streamModelError ??= new StreamModelError(
        new Error(`editor_interaction_recovery_blocked: ${blockedRecovery}`),
      );
    }
  } else {
    // Phase 3: post-sample recovery. Always runs — even on stream
    // error — so the ladder can decide between recovery vs terminal.
    await postSampleRecovery(state, ctx, session, signal);

    // If recovery applied a transition (any of I-10's triggers fired),
    // swallow the stream error and let the outer loop re-enter
    // PrepareContext.
    if (state.transition !== undefined) {
      (state as TurnState & { lastStreamError?: unknown }).lastStreamError =
        undefined;
      streamModelError = null;
    }
  }

  // Still-unrecovered stream error → bubble for runSamplingRequest's
  // retry policy to decide (stream_idle + transient).
  if (streamModelError) {
    throw streamModelError;
  }

  // Phase 4: continuation nudge. Editor interactions never inject an
  // Agent-side nudge/resample; their provider response is accepted as-is or
  // failed closed by the Editor contract.
  if (ctx.editorInteraction === undefined) {
    await continuationNudge(state, ctx, session, signal);
  }

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
      availability: "unknown",
      provenance: "synthetic",
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
  querySource: string,
  assistantOutputSink?: AssistantOutputStreamSink,
): Promise<SamplingRequestResult> {
  const prepared = await prepareSamplingRequestBoundary(
    state,
    ctx,
    session,
    signal,
    events,
    querySource,
  );
  if (prepared.kind === "terminal") return prepared.result;

  const outcome = await reconnectWithBackoff<SamplingRequestResult>({
    session,
    signal,
    // One initial provider call plus the five recovery-ladder reservations.
    // The reservation hook remains authoritative when another recovery path
    // has already consumed part of the shared A1 ladder.
    maxAttempts: MAX_RECOVERY_REENTRIES + 1,
    attempt: () =>
      tryRunSamplingRequest(
        state,
        ctx,
        session,
        prepared.request,
        signal,
        events,
        assistantOutputSink,
      ),
    isTransient: (err) => {
      if (isPartialProviderResponseError(err)) return false;
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
        emitError(session, session.nextInternalSubId(), {
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
      emitError(session, session.nextInternalSubId(), {
        cause: "stream_disconnected",
        message: streamRetryNoticeMessage(
          err,
          attempt,
          MAX_RECOVERY_REENTRIES + 1,
        ),
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
      abortReason instanceof Error
        ? abortReason
        : new Error(String(abortReason)),
    );
  }
  // exhausted
  const lastError = outcome.lastError;
  if (lastError instanceof Error) throw lastError;
  throw new Error(`stream_retries_exhausted: ${String(lastError)}`);
}

/**
 * Outer model↔tool loop iteration cap. Default is **no cap** — the turn ends
 * when the model stops tool-calling (or cancel / budget / behavioral
 * backstop fires). The canonical repository maps `max_turns` (including its
 * environment override) to the internal `maxTurns` snapshot once at startup.
 */
function resolveMaxTurns(ctx: TurnContext): number {
  const explicit = ctx.config.maxTurns;
  if (
    typeof explicit === "number" &&
    Number.isFinite(explicit) &&
    explicit > 0
  ) {
    return explicit;
  }
  // Unbounded: model stop-signal / cancel / budget owns termination.
  return Number.POSITIVE_INFINITY;
}

function appendInterruptedAssistantToolCalls(
  state: TurnState,
  toolCalls: ReadonlyMap<string, LLMToolCall>,
): void {
  const missing: LLMToolCall[] = [];
  for (const [id, toolCall] of toolCalls) {
    const alreadyPresent = state.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((call) => call.id === id) === true,
    );
    if (!alreadyPresent) {
      missing.push({ ...toolCall });
    }
  }
  if (missing.length === 0) return;
  state.messages.push({
    role: "assistant",
    content: "",
    toolCalls: missing,
  });
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
  const interruptedState = state as InterruptedStreamHistoryState;
  const suppressToolHistory =
    interruptedState.suppressInterruptedStreamToolHistory === true;
  const startedToolCalls = interruptedState.interruptedStartedStreamToolCalls;
  const exec = state.streamingToolExecutor as {
    close?: () => void;
    getRemainingResults?: () => AsyncIterable<{
      toolCall: LLMToolCall;
      result: {
        content: string;
        isError?: boolean;
        metadata?: Record<string, unknown>;
      };
      status: "completed" | "synthetic_error";
      durationMs?: number;
    }>;
  } | null;
  if (!exec || typeof exec.close !== "function") {
    delete interruptedState.suppressInterruptedStreamToolHistory;
    delete interruptedState.interruptedStartedStreamToolCalls;
    return;
  }
  try {
    exec.close();
    if (typeof exec.getRemainingResults === "function") {
      let appendedInterruptedAssistantToolCalls = false;
      for await (const drained of exec.getRemainingResults()) {
        const callId = drained.toolCall.id;
        const toolName = drained.toolCall.name;
        const result = drained.result;
        const registryTool = session.services.registry.tools.find(
          (tool) => tool.name === toolName,
        );
        const modelFacingContent = frameUntrustedToolResultContent(
          toolName,
          result.content,
          classifyUntrustedToolResult(toolName, registryTool),
        );
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
                ...(drained.durationMs !== undefined
                  ? { durationMs: drained.durationMs }
                  : {}),
              },
            },
          },
          {
            turnId: ctx.subId,
            toolResultBytes,
          },
        );
        const preserveInterruptedStartedResult =
          suppressToolHistory && startedToolCalls?.has(callId) === true;
        if (!suppressToolHistory || preserveInterruptedStartedResult) {
          if (!suppressToolHistory) {
            appendInterruptedAssistantToolCalls(
              state,
              new Map([[callId, drained.toolCall]]),
            );
          } else if (
            suppressToolHistory &&
            preserveInterruptedStartedResult &&
            !appendedInterruptedAssistantToolCalls &&
            startedToolCalls !== undefined
          ) {
            appendInterruptedAssistantToolCalls(state, startedToolCalls);
            appendedInterruptedAssistantToolCalls = true;
          }
          // Append both the LLM-facing tool message and the user-facing
          // tool_result record so the pair shows up in the next
          // request and in session history.
          state.toolResults.push({
            uuid: crypto.randomUUID(),
            role: "user",
            toolCallId: callId,
            toolName,
            content: modelFacingContent,
          });
          state.messages.push({
            role: "tool",
            toolCallId: callId,
            toolName,
            content: modelFacingContent,
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
    delete interruptedState.suppressInterruptedStreamToolHistory;
    delete interruptedState.interruptedStartedStreamToolCalls;
  }
}

const EMPTY_RESPONSE_RETRY_TEXT =
  "Your previous response contained no visible final answer. " +
  "Return the final answer now in the assistant output channel.";

function injectEmptyResponseRetryMessage(state: TurnState): void {
  state.messages.push({
    role: "user",
    content: EMPTY_RESPONSE_RETRY_TEXT,
    runtimeOnly: { excludeFromDurableHistory: true },
  });
}

function restoreModelSampleResumePrompt(state: TurnState): void {
  if (state.modelSampleResumePrompt === "continuation_nudge") {
    injectNudgeMessage(state);
  } else if (state.modelSampleResumePrompt === "empty_response") {
    injectEmptyResponseRetryMessage(state);
  }
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
  const emitTurnStarted = (turnContextItem: TurnContextItem): void => {
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
          // GOAL #4b Stage 1: stamp the build pin in turn_started (not the
          // checkpoint) so resume can refuse cross-build replay BEFORE
          // loading any checkpoint (§3.6).
          buildId: currentBuildId(),
        },
      },
    });
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_context",
        payload: turnContextItem,
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

  // Session.runTurn consumes a staged operator switch before constructing
  // this immutable context. Do not consume another switch here: one staged
  // after context construction belongs to the next turn, and committing it
  // now would mix that provider with this turn's model metadata and options.
  const sessionOwner = session as Session & {
    consumePendingProviderSwitch?: () => Promise<void>;
  };
  session.bindProviderConversation();

  const pendingInputOwnership = pendingInputOwnershipForTurn(ctx);
  const pendingInputMessages =
    typeof session.drainPendingInputMessages === "function"
      ? session.drainPendingInputMessages(pendingInputOwnership)
      : [];
  const userContent = mergePendingInputIntoUserContent(
    userMessage,
    pendingInputMessages,
  );
  const authorizationQuerySource = sessionQuerySourceForTurn(
    session,
    opts.querySource,
  );
  // Some compatibility adapters used by compaction/tests provide only the
  // session-owned runTurn surface. A missing source is the legacy root-session
  // shape; only an explicitly subagent source must lose root-human authority.
  const configuredSessionSource = session.sessionConfiguration?.sessionSource;
  const isRootHumanTurn =
    isMainThreadQueueSource(authorizationQuerySource) &&
    (configuredSessionSource === undefined ||
      !isSubagentSessionSource(configuredSessionSource)) &&
    (opts.rootHumanTurnText !== undefined || opts.displayUserMessage !== null);
  const rootHumanTurnText = isRootHumanTurn
    ? (opts.rootHumanTurnText ??
      opts.displayUserMessage ??
      userContentDisplayText(
        typeof userMessage === "string" ? userMessage : [...userMessage],
      ))
    : undefined;
  const ledgerRootTurnGuidance =
    rootHumanTurnText !== undefined && hasExactLedgerMention(rootHumanTurnText)
      ? LEDGER_ROOT_TURN_ROUTING_GUIDANCE
      : rootHumanTurnText !== undefined &&
          hasLedgerWalletCliMention(rootHumanTurnText)
        ? LEDGER_WALLET_CLI_ROUTING_GUIDANCE
        : undefined;

  // agenc runtime: `if input.is_empty() && !sess.has_pending_input().await { return None }`
  // Empty/no-pending-input is a no-op turn, not a synthetic completed
  // turn. Callers that want to force work must enqueue pending input or
  // pass a non-empty user message.
  //
  // GOAL #4b Stage 1 — a durable resume legitimately carries an empty
  // `userMessage` (the real user message is already inside the reconstructed
  // prefix): the work to do is CONTINUING the interrupted turn from its
  // checkpoint, so the empty-input no-op guard must not short-circuit it.
  if (
    opts.resume === undefined &&
    !userContentHasInput(userContent) &&
    !(
      pendingInputMessages.length > 0 ||
      session.hasPendingInput(pendingInputOwnership)
    )
  ) {
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
    ...(rootHumanTurnText !== undefined ? { rootHumanTurnText } : {}),
  });
  const codeModeTurnWorker = startCodeModeTurnWorker(session);
  const signalCleanups: Array<() => void> = [];

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
        ...(ledgerRootTurnGuidance !== undefined
          ? { ledgerRootTurnGuidance }
          : {}),
        signalCleanups,
      },
    );
  } finally {
    for (const cleanup of signalCleanups) cleanup();
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
  readonly emitTurnStarted: (turnContextItem: TurnContextItem) => void;
  readonly emitTurnComplete: (content: string) => void;
  readonly emitTurnAborted: (reason: string) => void;
  readonly referenceContextItem: TurnContextItem;
  readonly sessionOwner: Session & {
    consumePendingProviderSwitch?: () => Promise<void>;
  };
  /** Trusted, non-durable system guidance scoped to an exact root @ledger turn. */
  readonly ledgerRootTurnGuidance?: string;
  // Disposers for the merged abort signals built inside the kernel. The
  // outer `runTurnKernel` finally invokes these so listeners on long-lived
  // signals (the session-level abort) are removed on every turn exit.
  readonly signalCleanups: Array<() => void>;
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
    turnStartedAt,
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
  const supplementalPrompt = opts.systemPrompt?.trim() ?? "";
  const framedSupplementalPrompt =
    supplementalPrompt.length === 0
      ? ""
      : opts.systemPromptTrust === "workspace_role"
        ? frameWorkspaceAgentRoleGuidance(supplementalPrompt)
        : supplementalPrompt;
  const rawSystemPrompt = opts.systemPromptReplacesBase
    ? framedSupplementalPrompt
    : [framedSupplementalPrompt, ctxBaseInstructions ?? ""]
        .filter((part) => part.length > 0)
        .join("\n\n");
  const instructionEnvelope = await resolveLiveInstructionEnvelope({
    session,
    ctx,
    baseInstructions: rawSystemPrompt ?? "",
    ...(opts.instructionPolicy !== undefined
      ? { policy: opts.instructionPolicy }
      : {}),
  });
  const resolvedReferenceContextItem: TurnContextItem = {
    ...referenceContextItem,
    instructionEvidence: instructionEnvelope.evidence,
  };
  const systemPromptWithTrustedTurnGuidance =
    commons.ledgerRootTurnGuidance === undefined
      ? instructionEnvelope.text
      : [instructionEnvelope.text, commons.ledgerRootTurnGuidance]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
          .join("\n\n");
  const effectiveSystemPrompt =
    systemPromptWithTrustedTurnGuidance.length > 0
      ? resolveModelInstructionsForTurn(
          ctx,
          systemPromptWithTrustedTurnGuidance,
        )
      : "";
  const { system, prior, user } = buildSeedMessages(
    effectiveSystemPrompt.length > 0
      ? { ...opts, systemPrompt: effectiveSystemPrompt }
      : opts,
    userContent,
  );
  const instructionParts: string[] = [];
  if (system !== undefined) instructionParts.push(messageText(system));
  const modelInstructions = instructionParts
    .map((part) => part.trim())
    .filter(
      (part, index, all) => part.length > 0 && all.indexOf(part) === index,
    )
    .join("\n\n");
  const priorExisting = prior;
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
  // The model instruction envelope never enters conversation history. Any
  // current-turn system prompt is held in modelInstructions above. Keep this
  // seam explicit because prior/compact history may itself start with a system
  // summary; that summary is real durable content even though provider dispatch
  // folds it into the native system field.
  const durableHistoryStartIndex = (_messages: readonly LLMMessage[]): number =>
    0;

  // File-history join: give the seed user message a durable id shared
  // with the `user_message` event emitted below, so the file-history
  // sidecar's barrier snapshot (keyed by that event id) can be found
  // again from the history message during conversation rewind. A
  // standalone uuid-based id keeps the internal sub-id sequence
  // untouched.
  const seedUserMessageId =
    opts.displayUserMessage !== null ? `user-msg-${crypto.randomUUID()}` : null;
  if (seedUserMessageId !== null) {
    user.runtimeOnly = {
      ...user.runtimeOnly,
      userMessageId: seedUserMessageId,
    };
  }
  let state: TurnState = buildInitialTurnState(ctx, user, {
    priorMessages: priorFull,
    modelInstructions,
    ...(opts.skipCacheWrite !== undefined
      ? { initialSkipCacheWrite: opts.skipCacheWrite }
      : {}),
  });
  const turnQuerySource = sessionQuerySourceForTurn(session, opts.querySource);
  let persistedMessageCount =
    opts.initialHistoryPersistence === "persist_before_turn"
      ? 0
      : priorExisting.length;
  // GOAL #4b Stage 1 — resume-continuation. On resume the reconstructed
  // prefix arrives via `opts.history` (→ `priorFull`); we drop the synthetic
  // seed `user` that `buildInitialTurnState` appended (the real user message
  // is already inside the reconstructed prefix), anchor the persist cursor at
  // the checkpoint's count, and restore the resumable TurnState slice so
  // recovery caps / nudge counts / the derived budget hold their pre-crash
  // values instead of resetting. A checkpoint reserved for a model resample
  // restores its exact admission identity and any runtime-only retry prompt,
  // allowing an in-flight admission row to reattach after restart.
  if (opts.resume !== undefined) {
    state.messages = [...priorFull];
    // The reconstructed prefix is already on disk → anchor the persist
    // cursor at its length so it is not re-persisted.
    persistedMessageCount = state.messages.length;
    // Pair any dangling tool_use (no persisted result) with a SYNTHETIC
    // tool result so the message thread is valid for the first resumed
    // sampling request — without ever re-dispatching the tool. Side-
    // effecting/interactive blocks get the conservative "may have already
    // executed; not retried" result (the on-chain-safety property);
    // read-only blocks get a note that re-invoking is safe. These synthetic
    // results ARE new content → persisted on the next syncSessionState so
    // reconstruction sees a fully-paired thread.
    for (const pairing of opts.resume.danglingPairings ?? []) {
      const content = pairing.halt
        ? sideEffectHaltMessage(pairing.toolName)
        : `result not persisted before crash; the read-only tool ${pairing.toolName} was not retried automatically — safe to re-invoke if its result is needed.`;
      state.messages.push({
        role: "tool",
        content,
        toolCallId: pairing.callId,
        toolName: pairing.toolName,
      });
    }
    restoreFromCheckpoint(state, opts.resume.restoreSlice);
    restoreModelSampleResumePrompt(state);
  }
  const rolloutPersistenceSuspended = (): boolean =>
    session.isRolloutPersistenceSuspended?.() === true;
  const rolloutPersistenceActive = (): boolean =>
    session.rolloutStore !== null &&
    session.rolloutStore !== undefined &&
    !rolloutPersistenceSuspended();
  /**
   * How much of `state.messages` an in-turn compaction may offer to the
   * durable transaction. With a live rollout that is the persist cursor:
   * exactly the messages canonical history already holds. Without one
   * (none mounted, or persistence suspended for a fork) nothing is canonical
   * and the cursor never moves, so the whole history is offered as before.
   */
  const compactionDurableCount = (): number =>
    rolloutPersistenceActive()
      ? Math.min(persistedMessageCount, state.messages.length)
      : state.messages.length;
  const onCompactionReplacedHistory = (durableCount: number): void => {
    if (rolloutPersistenceActive()) persistedMessageCount = durableCount;
  };
  const persistTurnRolloutBaseline = (): void => {
    if (rolloutPersistenceSuspended()) return;
    session.rolloutStore?.appendRollout({
      type: "turn_context",
      payload: resolvedReferenceContextItem,
    });
  };
  const persistNewResponseItems = (): void => {
    if (rolloutPersistenceSuspended()) return;
    if (!session.rolloutStore) return;
    if (state.messages.length < persistedMessageCount) {
      persistedMessageCount = state.messages.length;
    }
    for (
      let messageIndex = persistedMessageCount;
      messageIndex < state.messages.length;
      messageIndex += 1
    ) {
      const sourceMessage = state.messages[messageIndex];
      if (sourceMessage === undefined) continue;
      const message = sealToolResultMessage(
        sourceMessage,
        session.conversationId,
      );
      state.messages[messageIndex] = message;
      if (excludeFromDurableHistory(message)) continue;
      const durableItem = llmMessageToDurableResponseItem(message);
      if (
        message.runtimeOnly?.toolResultIntegrity !== undefined &&
        durableItem.toolResultIntegrity !== undefined
      ) {
        state.messages[messageIndex] = {
          ...message,
          runtimeOnly: {
            ...message.runtimeOnly,
            toolResultIntegrity: {
              ...message.runtimeOnly.toolResultIntegrity,
              persisted: durableItem.toolResultIntegrity.persisted,
            },
          },
        };
      } else {
        state.messages[messageIndex] = message;
      }
      session.rolloutStore.appendRollout({
        type: "response_item",
        payload: durableItem,
      });
    }
    persistedMessageCount = state.messages.length;
  };
  const syncSessionState = async (): Promise<void> => {
    persistNewResponseItems();
    // Bound in-memory tool-result retention AFTER full content has been
    // persisted to the durable rollout (above), and only across messages
    // that have already been persisted (`persistedMessageCount`). This keeps
    // the live `state.messages` — and the `sessionState.history` derived from
    // it below — from growing ~linearly with turn count, while leaving the
    // most-recent-N tool results full and the disk rollout untouched.
    // See session-history-memory fix above.
    if (ctx.editorInteraction === undefined) {
      boundInMemoryToolResultContent(state.messages, persistedMessageCount);
    }
    const durableHistory = state.messages
      .slice(durableHistoryStartIndex(state.messages))
      .filter((message) => !excludeFromDurableHistory(message));
    const autoCompactTokenLimit = getAutoCompactTokenLimit(ctx);
    const resolvedPersonality = resolveTurnPersonality(ctx);
    await session.state.with((sessionState) => {
      sessionState.history = durableHistory.map((message) => ({
        ...message,
        ...(Array.isArray(message.content)
          ? { content: message.content.map((part) => ({ ...part })) }
          : {}),
        ...(message.toolCalls !== undefined
          ? {
              toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })),
            }
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
                effectiveContextWindowPercent:
                  ctx.modelInfo.effectiveContextWindowPercent,
                ...(autoCompactTokenLimit !== undefined
                  ? { autoCompactTokenLimit }
                  : {}),
              },
            }
          : {}),
      };
      sessionState.referenceContextItem = resolvedReferenceContextItem;
    });
  };

  // ── GOAL #4b Stage 1 — durable iteration checkpoint emit ──────────────
  // The checkpoint promotes the already-consistent CB-Iteration boundary
  // (assistant + all its tool results appended; message threading valid) to
  // a durable fsync. Emitting it via `session.emit` AFTER
  // persistNewResponseItems means the durable flush (turn_checkpoint ∈
  // DURABLE_EVENT_TYPES → flushBatch(true) → fsync) also flushes the
  // just-appended response_item batch, so the whole iteration becomes
  // durable atomically. NEVER snapshots history (reconstructed from the
  // rollout) — only the cursor + content hash + the resumable TurnState
  // slice (incl. the DERIVED taskBudgetRemaining, never a raw clock).
  const durableTurnsCfg = resolveDurableTurnsConfig(ctx.config);
  let checkpointSeq = opts.resume?.fromCheckpointSeq ?? 0;
  let iterationIndex = opts.resume?.fromIteration ?? 0;
  let lastCheckpointAtMs = 0;
  let checkpointedModelSampleOrdinal = state.modelSampleOrdinal;
  const emitTurnCheckpoint = (
    boundary: "iteration" | "postAssistant",
    options: { readonly force?: boolean } = {},
  ): void => {
    if (!durableTurnsCfg.checkpointEnabled) return;
    if (rolloutPersistenceSuspended()) return;
    if (!session.rolloutStore) return;
    if (options.force !== true && durableTurnsCfg.checkpointMinIntervalMs > 0) {
      const now = Date.now();
      if (
        lastCheckpointAtMs !== 0 &&
        now - lastCheckpointAtMs < durableTurnsCfg.checkpointMinIntervalMs
      ) {
        return;
      }
      lastCheckpointAtMs = now;
    }
    checkpointSeq += 1;
    // Hash the DURABLE-HISTORY PROJECTION of the prefix — exactly the
    // `response_item` sequence reconstruction rebuilds — so the write-side
    // and read-side hashes align by construction. This drops the leading
    // seed `system` message (re-derived from instructions, never replayed)
    // and any runtime-only messages, mirroring `syncSessionState`'s
    // `durableHistory`. `persistedMessageCount` is the LENGTH of that
    // projection (== reconstructed history length), NOT a `state.messages`
    // index. Tool-result entries contribute their authenticated persisted-body
    // identity, so the hash still represents the exact durable body even after
    // the corresponding in-memory content has been bounded.
    const durablePrefix = state.messages
      .slice(durableHistoryStartIndex(state.messages))
      .filter((message) => !excludeFromDurableHistory(message))
      .map((message) => llmMessageToCheckpointResponseItem(message));
    for (const message of durablePrefix) requireSealedToolResult(message);
    const prefixHash = computeCheckpointPrefixHashV3(
      durablePrefix,
      durablePrefix.length,
    );
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_checkpoint",
        payload: {
          turnId: ctx.subId,
          iterationIndex,
          boundary,
          checkpointSeq,
          persistedMessageCount: durablePrefix.length,
          prefixHash,
          checkpointVersion: DURABLE_CHECKPOINT_WRITE_VERSION,
          toolResultIntegrityVersion: 1,
          prefixHashVersion: 3,
          resumableState: toCheckpointSlice(state),
        },
      },
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

  emitTurnStarted(resolvedReferenceContextItem);
  persistTurnRolloutBaseline();
  session.budgetTracker?.resetForTurn();

  // GOAL #4b Stage 1 — durable turn re-opened. Emit a fsync-durable
  // `turn_resumed` marker recording which checkpoint/iteration the drain
  // loop is re-entering at, plus any side-effecting dangling tools the
  // safe-by-default policy halted on (surfaced, NOT retried). This re-opens
  // the turn lifecycle so reconstruction sees an active turn again.
  if (opts.resume !== undefined) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_resumed",
        payload: {
          turnId: ctx.subId,
          fromCheckpointSeq: opts.resume.fromCheckpointSeq,
          fromIteration: opts.resume.fromIteration,
          ...(opts.resume.haltedSideEffectingTools !== undefined &&
          opts.resume.haltedSideEffectingTools.length > 0
            ? {
                haltedSideEffectingTools: [
                  ...opts.resume.haltedSideEffectingTools,
                ],
              }
            : {}),
        },
      },
    });
    if (
      opts.resume.haltedSideEffectingTools !== undefined &&
      opts.resume.haltedSideEffectingTools.length > 0
    ) {
      for (const toolName of opts.resume.haltedSideEffectingTools) {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "durable_resume_side_effect_halt",
              message: sideEffectHaltMessage(toolName),
            },
          },
        });
      }
    }
  }

  // T6 gap #119: emit the seed user message exactly once per runTurn
  // invocation. Continuation turns (needsFollowUp=true) stay inside the
  // same generator so this fires once per user-initiated turn, not per
  // phase iteration.
  if (opts.displayUserMessage !== null) {
    session.emit({
      id: seedUserMessageId ?? session.nextInternalSubId(),
      msg: {
        type: "user_message",
        payload: {
          message: opts.displayUserMessage ?? userContent,
          displayText:
            opts.displayUserMessage ?? userContentDisplayText(userContent),
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
  if (opts.initialHistoryPersistence === "persist_before_turn") {
    if (rolloutPersistenceSuspended() || session.rolloutStore === null) {
      throw new Error(
        "initial invocation history requires an available durable rollout",
      );
    }
    // A managed child may execute tools immediately after its first provider
    // response.  Its authenticated policy/task/data seed therefore has to be
    // physically committed before compaction or provider dispatch can produce
    // any effect.  appendRollout alone only reaches the recorder's write
    // buffer; flushDurable is the fsync barrier that makes crash recovery safe.
    session.rolloutStore.flushDurable();
  }

  // agenc runtime: run_pre_sampling_compact before any phase runs. Returns
  // whether compaction happened; if yes and we had a prewarmed
  // client session, reset it (agenc runtime 155-157 — AgenC has no prewarm
  // today).
  try {
    await runPreSamplingCompact(session, ctx, turnQuerySource, state);
  } catch (error) {
    const underlying = compactFailureError(error);
    emitTurnWarning(
      session,
      PRE_SAMPLING_COMPACT_FAILED_CAUSE,
      underlying.message,
    );
    // agenc runtime: "return None" on pre-compact failure. The turn
    // ends; the daemon session must stay promptable.
    await syncSessionState();
    emitTurnComplete("");
    const terminal: Terminal = { reason: "completed", error: underlying };
    yield compactFailedTurnComplete("", EMPTY_SYNTHETIC_USAGE, underlying);
    return terminal;
  }

  // Merge external opts.signal, the session-level abort, and the
  // task-local abort from `spawnTask`. Upstream agenc runtime `start_task`
  // constructs a child `CancellationToken` for the running task
  // (see `tasks/mod.rs` line 269) whose cancellation is triggered
  // by `abort_all_tasks`. The merged signal here is the gut
  // equivalent of `task_cancellation_token.child_token()`.
  const mergedSession = mergeSignals(
    opts.signal,
    session.abortController.signal,
  );
  const mergedTask = mergeSignals(
    mergedSession.signal,
    runningTask.abortController.signal,
  );
  const signal = mergedTask.signal;
  // Both merges register `abort` listeners on their input signals; the
  // first merge can leave a listener on the long-lived session signal.
  // Hand the disposers to the outer kernel's finally so they run on every
  // exit path (completed, aborted, error, abandoned generator).
  commons.signalCleanups.push(mergedSession.dispose, mergedTask.dispose);

  let usage: LLMUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    availability: "unknown",
    provenance: "synthetic",
  };
  let lastContent = "";
  let emptyResponseRetryCount =
    state.modelSampleResumePrompt === "empty_response" ? 1 : 0;
  let editorSamplingIterations = 0;
  const finishEditorInteractionLimit = async (
    limitKind: "sampling_iterations" | "tool_calls",
    limit: number,
    observed: number,
  ): Promise<{
    readonly terminal: Terminal;
    readonly event: PhaseEvent;
  }> => {
    // Pair any model-emitted tool calls without dispatching them so the
    // transcript remains structurally valid at the fail-closed boundary.
    await drainInFlight(state, ctx, session);
    const cause = EDITOR_INTERACTION_LIMIT_CAUSE;
    const message =
      `Editor interaction stopped at the request-scoped ${limitKind} ` +
      `limit (${limit}; observed ${observed}). No additional tools ran and ` +
      "no buffer changes were applied.";
    const error = new Error(`${cause}: ${message}`);
    emitTurnWarning(session, cause, message);
    await syncSessionState();
    emitTurnComplete(message);
    return {
      terminal: { reason: "completed", error },
      event: editorRequestFailedTurnComplete(message, usage, error),
    };
  };
  const finishCancelledIfAborted = async (): Promise<{
    readonly terminal: Terminal;
    readonly event: PhaseEvent;
  } | null> => {
    if (!signal.aborted) return null;
    await drainInFlight(state, ctx, session);
    await syncSessionState();
    emitTurnAborted(
      String(
        (signal as AbortSignal & { reason?: unknown }).reason ?? "cancelled",
      ),
    );
    return {
      terminal: { reason: "cancelled" },
      event: {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      },
    };
  };

  yield { type: "turn_start", turnIndex: 0 };

  // Behavioral backstop (goal #3): resolve the no-progress config once
  // per turn so the top-of-loop evaluate site and the post-tool record
  // site share an identical config object. Pure synchronous resolution.
  const behavioralCfg: BehavioralConfig = resolveBehavioralConfig();

  // The phase loop — agenc runtime's "while streaming & tools" outer loop.
  while (true) {
    const cancelledAtLoopStart = await finishCancelledIfAborted();
    if (cancelledAtLoopStart !== null) {
      yield cancelledAtLoopStart.event;
      return cancelledAtLoopStart.terminal;
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

    if (
      ctx.editorInteraction !== undefined &&
      editorSamplingIterations >= EDITOR_INTERACTION_MAX_SAMPLING_ITERATIONS
    ) {
      const limited = await finishEditorInteractionLimit(
        "sampling_iterations",
        EDITOR_INTERACTION_MAX_SAMPLING_ITERATIONS,
        editorSamplingIterations,
      );
      yield limited.event;
      return limited.terminal;
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

    const maxBudgetUsd = ctx.config.maxBudgetUsd;
    const totalCostUsd = session.services.costSidecar?.getTotalCostUsd();
    if (
      typeof maxBudgetUsd === "number" &&
      Number.isFinite(maxBudgetUsd) &&
      maxBudgetUsd > 0 &&
      typeof totalCostUsd === "number" &&
      Number.isFinite(totalCostUsd) &&
      totalCostUsd >= maxBudgetUsd
    ) {
      await drainInFlight(state, ctx, session);
      await syncSessionState();
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "max_budget_usd" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "max_budget_usd",
      };
      return terminal;
    }

    // Behavioral backstop (goal #3): the SECOND whole-turn backstop —
    // a result-aware, NON-BLOCKING watchdog for semantic non-termination
    // (every tool settles fine but the loop spins making no progress).
    // This evaluate is a synchronous read of already-collected state; it
    // shares the identical clean-finalize path as the `max_turns` arm two
    // arms above. The Tier-2 observer inbox is polled here (never
    // awaited). A `warn` injects a one-shot nudge and continues; a
    // `terminate` finalizes the turn with the honest `no_progress`
    // terminal — never a fabricated success.
    if (ctx.editorInteraction === undefined) {
      const observerTrip = state.behavioralObserverTrip;
      const decision =
        behavioralCfg.enabled && observerTrip !== undefined
          ? ({ kind: "terminate", trip: observerTrip } as const)
          : evaluateBehavioralBackstop(
              state,
              usage,
              turnStartedAt,
              behavioralCfg,
            );

      if (decision.kind === "warn") {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "no_progress_warning",
              message: decision.detail,
            },
          },
        });
        if (
          decision.injectNudge &&
          !state.behavioralNudgeIssued &&
          decision.nudgeText !== undefined
        ) {
          state.messages.push({
            role: "user",
            content: `<system-reminder>${decision.nudgeText}</system-reminder>`,
          });
          state.behavioralNudgeIssued = true;
        }
        // fall through — loop continues (Wink course-correction)
      } else if (decision.kind === "terminate") {
        const explanation = decision.trip.userMessage; // honest, specific cause
        state.messages.push({ role: "assistant", content: explanation });
        lastContent = explanation;

        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "no_progress_detected",
              message: decision.trip.detail,
            },
          },
        });

        await drainInFlight(state, ctx, session); // pair orphan tool_use → tool_result
        await syncSessionState(); // persist history + rollout
        emitTurnComplete(lastContent); // canonical lifecycle close
        const terminal: Terminal = { reason: "no_progress" };
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: "no_progress",
        };
        return terminal;
      }
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

    // A deliberate re-sample needs a durable identity before admission is
    // acquired. The checkpoint event is the fsync barrier for both the
    // response prefix and the next ordinal; interval throttling cannot defer
    // this correctness boundary.
    if (state.modelSampleOrdinal !== checkpointedModelSampleOrdinal) {
      persistNewResponseItems();
      emitTurnCheckpoint("iteration", { force: true });
      checkpointedModelSampleOrdinal = state.modelSampleOrdinal;
    }

    // agenc runtime run_sampling_request — phases 1-4.
    const pending: PhaseEvent[] = [];
    // Hoisted so the mid-turn compaction check after the try/catch can
    // read the just-returned model_needs_follow_up signal. agenc runtime reads
    // this from `SamplingRequestResult` at turn.rs:468-476 right before
    // the `token_limit_reached && needs_follow_up` arm at turn.rs:493.
    let modelNeedsFollowUp = false;
    try {
      if (ctx.editorInteraction !== undefined) {
        editorSamplingIterations += 1;
      }
      const result = await runSamplingRequest(
        state,
        ctx,
        session,
        signal,
        pending,
        turnQuerySource,
        opts.assistantOutputSink,
      );
      for (const ev of pending) {
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
      state.modelSampleResumePrompt = undefined;
      advanceModelSampleOrdinal(state);
      if (state.transition?.reason === "continuation_nudge") {
        state.modelSampleResumePrompt = "continuation_nudge";
      }
    } catch (error) {
      await drainInFlight(state, ctx, session);
      for (const ev of pending) {
        yield ev;
      }
      const sme = error instanceof StreamModelError ? error : undefined;
      const underlying =
        (sme?.cause instanceof Error ? sme.cause : undefined) ??
        (error instanceof Error ? error : new Error(String(error)));
      if (signal.aborted) {
        // T6 gap #119: cancelled-with-error still gets `turn_aborted`
        // so rollout reconstruction sees a closed turn boundary.
        await syncSessionState();
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
      // Editor turns refuse Agent recovery (compact / resample / route
      // switch). A withheld 413, oversized media, or max-output-tokens
      // result is request-scoped: the Explain/Edit ends, but mapping
      // that to stopReason "error" latched keep-alive daemon runs.
      if (
        ctx.editorInteraction !== undefined &&
        isEditorRecoveryBlockedError(underlying)
      ) {
        const content =
          lastContent.length > 0 ? lastContent : underlying.message;
        emitTurnWarning(
          session,
          EDITOR_RECOVERY_BLOCKED_CAUSE,
          underlying.message,
        );
        await syncSessionState();
        emitTurnComplete(content);
        const terminal: Terminal = { reason: "completed", error: underlying };
        yield editorRequestFailedTurnComplete(content, usage, underlying);
        return terminal;
      }
      /*
       * T6 gap #119: an error-terminated turn still closes the turn
       * boundary for rollout reducers — but it must close it as what it
       * is. Writing the success-shaped `turn_complete` made the durable
       * record indistinguishable from a turn that finished, so a run
       * killed by, say, `execution admission deny: context_window_exceeded`
       * was replayed to clients as a completed turn whose final answer was
       * the model's previous intent sentence. `turn_aborted` is the same
       * boundary for every reducer that consumes one and carries the
       * reason with it.
       */
      await syncSessionState();
      emitTurnAborted(
        underlying instanceof Error && underlying.message.trim().length > 0
          ? underlying.message
          : "turn failed",
      );
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

    const cancelledAfterSampling = await finishCancelledIfAborted();
    if (cancelledAfterSampling !== null) {
      yield cancelledAfterSampling.event;
      return cancelledAfterSampling.terminal;
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
    const hasPendingInput = session.hasPendingInput(
      pendingInputOwnershipForTurn(ctx),
    );
    const pendingAssistantToolCalls =
      state.assistantMessages.at(-1)?.toolCalls.length ?? 0;
    const needsFollowUpForCompact =
      modelNeedsFollowUp ||
      state.toolUseBlocks.length > 0 ||
      pendingAssistantToolCalls > 0 ||
      hasPendingInput;
    /*
     * Tool calls the model just emitted are already running: the streaming
     * tool executor starts them as their input completes. A compaction begun
     * here raced them (observed live: the tool's admission and effect records
     * landed in the rollout while the summary call was in flight, and the
     * transaction refused to commit over a rollout that "advanced outside
     * the compaction admission journal"). Tools do not consume model
     * context; only the next sample does. So when tool work is pending the
     * post-tool gate compacts instead, once the results are canonical.
     */
    const toolWorkPending =
      state.toolUseBlocks.length > 0 || pendingAssistantToolCalls > 0;
    const autoCompactLimit =
      getPreSamplingAutoCompactTokenLimit(ctx) ?? Number.POSITIVE_INFINITY;
    // Mirror the donor's `tokenCountWithEstimation` (utils/tokens.ts:418):
    // anchor on the LAST provider-reported prompt size (single sample, not
    // cumulative) and treat that as the projected cost of the NEXT API
    // request. The previous logic took `Math.max(getTotalTokenUsage,
    // usage.totalTokens, lastResponseUsage.totalTokens)` where the first
    // two are CUMULATIVE counters that sum every sample's `totalTokens`
    // additively across the turn (see stream-model.ts:897-903 — these are
    // donor-parity cost-tracking surfaces from `TokenUsageInfo::
    // append_last_usage`, not context-window-pressure signals). After 19
    // samples in a single turn each ~13k, the cumulative total reached
    // 248k and falsely tripped the 236k threshold even though no single
    // prompt was anywhere near it. Use the latest sample's
    // `promptTokens` (input-side, what the model just received as
    // context); on turn 0 with no prior response, fall back to 0 so the
    // first sample is always allowed through.
    /*
     * Measure what admission measures. Admission compares the token
     * ACCOUNTING estimate (bytes-derived for any provider without a native
     * tokenizer, plus margin and reserved output) against the window, while
     * this gate used the provider's reported prompt size. On grok-4.6 the
     * estimate ran 2.12x the reported number, so admission's real ceiling
     * was ~224k while this gate waited for 462k of provider tokens: an
     * observed 306-iteration turn died on `context_window_exceeded` having
     * never once called auto-compaction. Reading the same scale here makes
     * the safety net reachable; it crossed the threshold 91 iterations
     * before that run was killed.
     */
    const totalUsageTokens = Math.max(
      state.lastResponseUsage?.promptTokens ?? 0,
      getActiveContextTokenUsage(session, ctx, state),
    );
    const tokenLimitReached = totalUsageTokens >= autoCompactLimit;

    if (
      ctx.editorInteraction === undefined &&
      tokenLimitReached &&
      needsFollowUpForCompact &&
      !toolWorkPending
    ) {
      let midTurnCompacted = false;
      try {
        midTurnCompacted = await runAutoCompact(
          session,
          ctx,
          "before_last_user_message",
          "context_limit",
          "in_turn",
          state,
          {
            querySource: turnQuerySource,
            durableMessageCount: compactionDurableCount(),
            onDurableHistoryReplaced: onCompactionReplacedHistory,
          },
        );
      } catch (error) {
        // agenc runtime returns None on mid-turn compact failure. End
        // the turn with a warning plus compact_failed so rollout
        // reducers see a closed boundary without killing the run.
        await drainInFlight(state, ctx, session);
        const underlying = compactFailureError(error);
        emitTurnWarning(
          session,
          MID_TURN_COMPACT_FAILED_CAUSE,
          underlying.message,
        );
        await syncSessionState();
        emitTurnComplete(lastContent);
        const terminal: Terminal = { reason: "completed", error: underlying };
        yield compactFailedTurnComplete(lastContent, usage, underlying);
        return terminal;
      }

      if (!midTurnCompacted) {
        // agenc runtime's `is_err()` arm fires only on dispatcher failure. If
        // the dispatcher ran but reported `wasCompacted=false` (circuit
        // breaker tripped, feature disabled, or threshold logic inside
        // the compact module disagreed with our outer check), we do NOT
        // loop — that would spin forever with unchanged state. Surface
        // the token-limit condition as a per-turn compact_failed matching
        // the semantics of agenc runtime's `return None`.
        await drainInFlight(state, ctx, session);
        const reasonText = `mid_turn_compact_skipped: lastSamplePromptTokens=${totalUsageTokens} limit=${autoCompactLimit}`;
        emitTurnWarning(
          session,
          MID_TURN_COMPACT_FAILED_CAUSE,
          reasonText,
        );
        await syncSessionState();
        emitTurnComplete(lastContent);
        const underlying = new Error(reasonText);
        const terminal: Terminal = { reason: "completed", error: underlying };
        yield compactFailedTurnComplete(lastContent, usage, underlying);
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
      const hasValidatedEditorProposal = state.completedToolResults.some(
        (result) =>
          result.toolName === EDITOR_PROPOSAL_TOOL_NAME &&
          result.isError !== true &&
          typeof result.metadata?.editorProposal === "object" &&
          result.metadata.editorProposal !== null,
      );
      if (
        ctx.editorInteraction?.policy === "proposal_only" &&
        !hasValidatedEditorProposal
      ) {
        const cause = EDITOR_PROPOSAL_MISSING_CAUSE;
        lastContent =
          "Editor edit request incomplete: the model did not return a valid " +
          "EditorProposal. No buffer changes were made.";
        const error = new Error(`${cause}: ${lastContent}`);
        emitTurnWarning(session, cause, lastContent);
        await syncSessionState();
        emitTurnComplete(lastContent);
        const terminal: Terminal = { reason: "completed", error };
        yield editorRequestFailedTurnComplete(lastContent, usage, error);
        return terminal;
      }
      // Reasoning providers can occasionally complete a response after
      // emitting only a reasoning-summary block and no assistant output. A
      // successful empty turn is indistinguishable from a hung terminal to a
      // user. Retry once under normal admission/cost accounting with an
      // ephemeral nudge; keep the bound at one so a broken provider cannot
      // create an unbounded sampling loop.
      if (
        ctx.editorInteraction === undefined &&
        assistantText.length === 0 &&
        emptyResponseRetryCount === 0
      ) {
        emptyResponseRetryCount += 1;
        injectEmptyResponseRetryMessage(state);
        state.modelSampleResumePrompt = "empty_response";
        continue;
      }
      await commit(state, ctx, session, signal, {
        querySource: turnQuerySource,
      });
      await syncSessionState();
      // commit may set a stop-hook transition (I-17). If so, re-enter.
      if (state.transition !== undefined) {
        state.transition = undefined;
        continue;
      }
      const stopReason =
        assistantText.length === 0 ? "empty_response" : "completed";
      launchTerminalPostSampling(state, session, ctx, turnQuerySource, signal);
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
      return terminal;
    }

    // GOAL #4b Stage 1 — CB-PostAssistant durable checkpoint. The assistant
    // message (with pending tool_use blocks) is consistent and nothing has
    // dispatched yet. Persisting the assistant message here + fsyncing the
    // checkpoint means a crash DURING tool dispatch resumes from a prefix
    // where the pending tool_use blocks are DANGLING — at which point the
    // safe-by-default side-effect policy halts on any side-effecting tool
    // (never silently re-firing it) and re-runs only read-only ones. This is
    // the boundary that makes the no-double-side-effect invariant
    // load-bearing. It does NOT advance `iterationIndex` (the iteration
    // hasn't completed); on resume the loop re-issues a fresh request after
    // resolving the dangling blocks.
    if (
      lastAssistant &&
      state.toolUseBlocks.length > 0 &&
      durableTurnsCfg.checkpointEnabled
    ) {
      persistNewResponseItems();
      emitTurnCheckpoint("postAssistant");
    }

    // Phase 5 — execute tools. Emit tool_call / tool_result events
    // around the dispatch.
    if (lastAssistant && lastAssistant.toolCalls.length > 0) {
      for (const toolCall of lastAssistant.toolCalls) {
        const event: PhaseEvent = { type: "tool_call", toolCall };
        yield event;
      }
    }
    const sleepRan = state.toolUseBlocks.some(
      (block) => block.name === SLEEP_TOOL_NAME,
    );
    await executeTools(state, ctx, session, signal);
    const cancelledAfterTools = await finishCancelledIfAborted();
    if (cancelledAfterTools !== null) {
      yield cancelledAfterTools.event;
      return cancelledAfterTools.terminal;
    }
    if (lastAssistant) {
      const completedByCallId = new Map(
        state.completedToolResults.map((record) => [record.callId, record]),
      );
      // Behavioral backstop (goal #3): record this real model-action step
      // where the action and its result are co-resident. This site is
      // PAST every recovery/compaction `continue` arm above, so recovery
      // re-entries and compaction iterations are never recorded — a
      // structural false-positive guard for free. Synchronous mutation
      // of TurnState fields; no await, no I/O.
      if (ctx.editorInteraction === undefined) {
        recordBehavioralStep(
          state,
          lastAssistant,
          completedByCallId,
          behavioralCfg,
        );
      }
      // Index user records by their tool-call id rather than by position:
      // results return in completion order (not toolCalls order), attachment
      // records (no toolCallId) are appended onto `toolResults` after the tool
      // results, and synthetic-recovery skips can make `toolResults` shorter
      // than `toolCalls`. Positional lookup therefore mis-pairs calls and
      // drops the tail, even though the content lives in `completedByCallId`.
      const userRecByCallId = new Map(
        state.toolResults
          .filter(
            (record): record is typeof record & { toolCallId: string } =>
              "toolCallId" in record && typeof record.toolCallId === "string",
          )
          .map((record) => [record.toolCallId, record] as const),
      );
      for (let i = 0; i < lastAssistant.toolCalls.length; i += 1) {
        const call = lastAssistant.toolCalls[i];
        if (!call) continue;
        const completed = completedByCallId.get(call.id);
        const userRec = userRecByCallId.get(call.id);
        if (!completed && !userRec) continue;
        yield {
          type: "tool_result",
          toolCall: call,
          result: {
            content:
              completed?.content ??
              (typeof userRec?.content === "string" ? userRec.content : ""),
            isError: completed?.isError ?? false,
            ...(completed?.metadata !== undefined
              ? { metadata: completed.metadata }
              : {}),
          },
        };
      }
    }
    if (
      ctx.editorInteraction !== undefined &&
      state.editorToolCallLimitExceeded
    ) {
      const limited = await finishEditorInteractionLimit(
        "tool_calls",
        EDITOR_INTERACTION_MAX_TOOL_CALLS,
        state.editorToolCallsAdmitted + state.editorToolCallLimitDeniedIds.size,
      );
      yield limited.event;
      return limited.terminal;
    }
    if (state.preventContinuation) {
      state.toolUseBlocks = [];
      await commit(state, ctx, session, signal, {
        querySource: turnQuerySource,
      });
      // A tool-phase guard that found the turn going nowhere (one call
      // failing the same way over and over) ends it as the behavioral
      // backstop would: the explanation goes into the transcript and the
      // terminal is the bounded `no_progress`, so hooks and subagents do
      // not mistake the halt for a completed turn.
      const noProgressStop =
        state.transition === undefined ? state.noProgressStop : undefined;
      if (noProgressStop !== undefined) {
        state.messages.push({
          role: "assistant",
          content: noProgressStop.explanation,
        });
        lastContent = noProgressStop.explanation;
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "no_progress_detected",
              message: noProgressStop.explanation,
            },
          },
        });
      }
      await syncSessionState();
      if (state.transition !== undefined) {
        state.transition = undefined;
        continue;
      }
      launchTerminalPostSampling(state, session, ctx, turnQuerySource, signal);
      emitTurnComplete(lastContent);
      const stopReason = noProgressStop !== undefined ? "no_progress" : "completed";
      const terminal: Terminal = { reason: stopReason };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason,
      };
      return terminal;
    }
    const drainedQueuedCommandEvents = drainQueuedCommandsAfterTools({
      state,
      session,
      ctx,
      querySource: turnQuerySource,
      sleepRan,
    });
    for (const event of drainedQueuedCommandEvents) {
      yield event;
    }

    const postToolAutoCompactLimit =
      getPreSamplingAutoCompactTokenLimit(ctx) ?? Number.POSITIVE_INFINITY;
    // Same correctness fix as the mid-turn check above: anchor on the
    // last sample's `promptTokens` (per-sample) rather than the cumulative
    // session counter, so post-tool-loop compaction triggers on the
    // projected next-sample prompt size, not on summed throughput — and on
    // admission's own scale, so the net sits ahead of the trap.
    const postToolTokenLimitReached =
      Math.max(
        state.lastResponseUsage?.promptTokens ?? 0,
        getActiveContextTokenUsage(session, ctx, state),
      ) >= postToolAutoCompactLimit;
    if (
      ctx.editorInteraction === undefined &&
      postToolTokenLimitReached &&
      (state.needsFollowUp || state.toolResults.length > 0)
    ) {
      // The results that just came back are the newest context and the
      // reason the history is over the limit. Make them canonical first so
      // the transaction can summarize them along with everything else,
      // instead of finding them unmapped and refusing to compact.
      persistNewResponseItems();
      const midTurnCompacted = await runAutoCompact(
        session,
        ctx,
        "before_last_user_message",
        "context_limit",
        "in_turn",
        state,
        {
          querySource: turnQuerySource,
          durableMessageCount: compactionDurableCount(),
          onDurableHistoryReplaced: onCompactionReplacedHistory,
        },
      );
      if (midTurnCompacted) {
        session.bindProviderConversation();
        continue;
      }
      // Same rule as the mid-turn gate: a dispatcher that ran and declined
      // leaves the state unchanged, so sampling again would only walk into
      // the admission denial the compaction was meant to prevent. Close the
      // turn on a compact_failed boundary with the reason already in the
      // rollout (`auto_compact_failed`, emitted by runAutoCompact).
      await drainInFlight(state, ctx, session);
      const postToolUsageTokens = Math.max(
        state.lastResponseUsage?.promptTokens ?? 0,
        getActiveContextTokenUsage(session, ctx, state),
      );
      const reasonText = `mid_turn_compact_skipped: lastSamplePromptTokens=${postToolUsageTokens} limit=${postToolAutoCompactLimit}`;
      emitTurnWarning(session, MID_TURN_COMPACT_FAILED_CAUSE, reasonText);
      await syncSessionState();
      emitTurnComplete(lastContent);
      const underlying = new Error(reasonText);
      const terminal: Terminal = { reason: "completed", error: underlying };
      yield compactFailedTurnComplete(lastContent, usage, underlying);
      return terminal;
    }

    // Phase 6 — commit iteration. Stop-hook may request re-entry.
    await commit(state, ctx, session, signal, { querySource: turnQuerySource });
    await syncSessionState();

    // GOAL #4b Stage 1 — CB-Iteration durable checkpoint. The strongest
    // already-reached, already-consistent boundary: assistant + all its
    // tool results are appended and message threading is valid. Emitting
    // here fsyncs the whole iteration's batch so a crash before the next
    // sampling request resumes-CONTINUES from this iteration instead of
    // discarding it.
    iterationIndex += 1;
    emitTurnCheckpoint("iteration");

    if (ctx.editorInteraction !== undefined) {
      // A token-target continuation is an Agent workflow loop. The Editor
      // request remains bounded even when the shared session owns a tracker.
      state.pendingBudgetDecision = undefined;
    } else if (state.pendingBudgetDecision?.kind === "stop") {
      await applyPendingBudgetContinuation(state, ctx, session, signal);
      if (state.transition !== undefined) {
        state.transition = undefined;
        continue;
      }
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
        initialHistoryPersistence?: RunTurnOptions["initialHistoryPersistence"];
        seedUserMessageRuntimeOnly?: LLMMessage["runtimeOnly"];
        signal?: AbortSignal;
        assistantOutputSink?: AssistantOutputStreamSink;
        querySource?: string;
        skipCacheWrite?: boolean;
        displayUserMessage?: string | null;
        rootHumanTurnText?: string;
        instructionPolicy?: LiveInstructionPolicy;
        systemPromptTrust?: "trusted_internal" | "workspace_role";
        systemPromptReplacesBase?: boolean;
        resume?: TurnResumeOptions;
      },
    ) => AsyncGenerator<PhaseEvent, Terminal>;
  };
  if (typeof sessionOwner.runTurn === "function") {
    return sessionOwner.runTurn(userMessage, {
      ctx,
      systemPrompt: opts.systemPrompt,
      history: opts.history,
      initialHistoryPersistence: opts.initialHistoryPersistence,
      seedUserMessageRuntimeOnly: opts.seedUserMessageRuntimeOnly,
      signal: opts.signal,
      assistantOutputSink: opts.assistantOutputSink,
      querySource: opts.querySource,
      skipCacheWrite: opts.skipCacheWrite,
      displayUserMessage: opts.displayUserMessage,
      rootHumanTurnText: opts.rootHumanTurnText,
      instructionPolicy: opts.instructionPolicy,
      systemPromptTrust: opts.systemPromptTrust,
      systemPromptReplacesBase: opts.systemPromptReplacesBase,
      resume: opts.resume,
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
