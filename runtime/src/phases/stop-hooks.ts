/**
 * Phase 3b — Stop hooks.
 *
 * Port of agenc runtime `hooks/src/events/stop.rs` (547 LOC, AgenC subset
 * ~250 LOC) + agenc `query.ts:1313-1341` stop-hook ladder.
 *
 * Stop hooks fire at turn-end and can:
 *   - declare that the stop is legitimate (no-op; turn completes)
 *   - block the stop and inject continuation prompts so the model
 *     continues on the next iteration (e.g. a linter finding issues)
 *   - declare a stop reason that propagates into event-log telemetry
 *
 * Invariants wired here:
 *   I-17 (stop-hook recursion cap, MAX_STOP_HOOK_BLOCKS=3):
 *        `state.stopHookBlockingCount` increments per inject; force-
 *        terminate at cap with `error:'stop_hook_loop'`.
 *   I-39 (stop-hook throw guard): every hook invocation runs under
 *        try/catch; throws emit `error:'stop_hook_threw'` with hook
 *        name + stack, ladder continues.
 *   I-8  (every error site emits typed event): the API-error stop
 *        guard + stop-hook-loop + throw-guard all funnel through
 *        `emitError`.
 *
 * Critical subtlety (AgenC 1297-1299): `executeStopFailureHooks`
 * fires ONLY when `lastMessage?.isApiErrorMessage` — without this
 * gate tokens spiral, because a stop-failure hook on a non-API-error
 * assistant turn can inject text the model refines indefinitely.
 *
 * @module
 */

import { emitError, emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import type {
  AssistantMessage,
  TurnState,
} from "../session/turn-state.js";
import type { Message } from "../types/message.js";
import { asRecord } from "../utils/record.js";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** I-17 recursion cap is AgenC's additional guard over both sources.
 *  agenc runtime has no cap — its stop-hook loop relies on timeouts +
 *  cancellation (see `agenc-rs/hooks/src/events/stop.rs` and
 *  `agenc-rs/core/src/session/turn.rs`, neither defines a
 *  `MAX_STOP_HOOK_RECURSION_DEPTH` constant). AgenC caps at
 *  `MAX_STOP_HOOK_BLOCKS` in `query.ts`; we mirror that name + value
 *  here. */
export const MAX_STOP_HOOK_BLOCKS = 3;

// ─────────────────────────────────────────────────────────────────────
// Stop-hook types (port of agenc runtime StopOutcome subset)
// ─────────────────────────────────────────────────────────────────────

export interface StopRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly transcriptPath?: string;
  readonly model: string;
  readonly permissionMode: string;
  readonly stopHookActive: boolean;
  readonly lastAssistantMessage?: string;
  /** Whether the last assistant message was itself an API error —
   *  agenc `isApiErrorMessage` flag (query.ts:1297-1299). */
  readonly lastIsApiErrorMessage: boolean;
  readonly hookMessages?: readonly Message[];
}

export interface StopHookOutcome {
  readonly shouldStop: boolean;
  readonly stopReason?: string;
  readonly shouldBlock: boolean;
  readonly blockReason?: string;
  /** Prompt fragments to inject when the hook blocks the stop. */
  readonly continuationFragments: ReadonlyArray<string>;
}

/** A single configured stop hook (runnable). */
export interface StopHookHandler {
  readonly name: string;
  run(request: StopRequest): Promise<StopHookOutcome> | StopHookOutcome;
}

// ─────────────────────────────────────────────────────────────────────
// Aggregate outcome
// ─────────────────────────────────────────────────────────────────────

export interface StopResult {
  /** True when the turn is allowed to terminate. */
  readonly allowStop: boolean;
  /** True when the hook injected blocking continuation. */
  readonly blocking: boolean;
  /** Continuation prompt injected into state.messages (if blocking). */
  readonly injectedMessage?: string;
  /** Telemetry reason. */
  readonly reason?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Core evaluator (replaces the T5 stub)
// ─────────────────────────────────────────────────────────────────────

/**
 * Run every configured stop-hook, aggregate outcomes. Wraps each
 * invocation in a try/catch (I-39) — a throw emits a typed error
 * + skips the offending hook + continues the ladder. Injects the
 * blocking message + bumps `state.stopHookBlockingCount` on block.
 *
 * When the counter hits `MAX_STOP_HOOK_BLOCKS` (I-17), emits
 * `error:'stop_hook_loop'` + returns a non-blocking allow so the
 * turn terminates.
 */
export async function evaluateStopHooks(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  _signal?: AbortSignal,
): Promise<StopResult> {
  // Build a consistent request for every registered hook.
  const lastAssistant = state.assistantMessages.at(-1);
  const hookMessages = buildHookMessages(state);
  const request: StopRequest = {
    sessionId: session.conversationId,
    turnId: ctx.subId,
    cwd: ctx.cwd,
    ...(session.rolloutStore?.rolloutPath !== undefined
      ? { transcriptPath: session.rolloutStore.rolloutPath }
      : {}),
    model: ctx.modelInfo.slug,
    permissionMode: currentPermissionMode(ctx, session),
    stopHookActive: state.stopHookActive === true,
    ...(lastAssistant?.text !== undefined
      ? { lastAssistantMessage: lastAssistant.text }
      : {}),
    lastIsApiErrorMessage: isApiErrorAssistantMessage(lastAssistant),
    ...(hookMessages.length > 0 ? { hookMessages } : {}),
  };

  // I-17: cap check runs BEFORE invoking hooks so a misbehaving
  // hook that always blocks can't burn another cycle.
  if (state.stopHookBlockingCount >= MAX_STOP_HOOK_BLOCKS) {
    emitError(session.eventLog, session.nextInternalSubId(), {
      cause: "stop_hook_loop",
      message: `stop-hook blocked ${state.stopHookBlockingCount} times in a row — forcing terminal (I-17)`,
    });
    return {
      allowStop: true,
      blocking: false,
      reason: "stop_hook_loop_capped",
    };
  }

  const hooks = listConfiguredStopHooks(session);
  const aggregate: StopHookOutcome = {
    shouldStop: true,
    shouldBlock: false,
    continuationFragments: [],
  };

  let injectedFragments: string[] = [];
  let anyBlocked = false;
  let anyShouldStop = false;

  for (const hook of hooks) {
    let outcome: StopHookOutcome;
    try {
      outcome = await hook.run(request);
    } catch (err) {
      // I-39: throw guard.
      emitError(session.eventLog, session.nextInternalSubId(), {
        cause: "stop_hook_threw",
        message: `${hook.name} threw: ${err instanceof Error ? err.message : String(err)}`,
        ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
      });
      continue;
    }

    if (outcome.shouldStop) {
      anyShouldStop = true;
      if (outcome.stopReason) {
        (aggregate as { stopReason?: string }).stopReason = outcome.stopReason;
      }
    }

    if (outcome.shouldBlock) {
      // agenc runtime `stop.rs:185-193` rejects `decision:block` without a
      // non-empty reason. Mirror that: blank/whitespace-only
      // blockReason is a typed hook failure; we skip this hook's
      // block contribution entirely.
      const trimmedReason = outcome.blockReason?.trim();
      if (!trimmedReason) {
        emitError(session.eventLog, session.nextInternalSubId(), {
          cause: "stop_hook_threw",
          message: `${hook.name}: stop_hook_blank_reason — shouldBlock without a non-empty blockReason`,
          stack: "stop_hook_blank_reason",
        });
      } else {
        anyBlocked = true;
        if (outcome.continuationFragments.length > 0) {
          injectedFragments.push(...outcome.continuationFragments);
        }
        emitWarning(
          session.eventLog,
          session.nextInternalSubId(),
          "stop_hook_blocked",
          `${hook.name}: ${trimmedReason}`,
        );
      }
    }
    if (!outcome.shouldStop && outcome.stopReason) {
      // Hook declared a forced-stop reason; carry through.
      (aggregate as { stopReason?: string }).stopReason = outcome.stopReason;
    }
  }
  void aggregate;

  // agenc runtime `stop.rs:271` precedence: `should_block = !should_stop &&
  // any(should_block)`. A hook that returned `shouldStop: true` wins
  // over any concurrent `shouldBlock: true`, even across hooks.
  // Asserted by agenc runtime test `continue_false_overrides_block_decision`
  // (stop.rs:378-400).
  if (anyShouldStop) {
    return {
      allowStop: true,
      blocking: false,
      reason: aggregate.stopReason ?? "stop_hook_shouldstop_wins",
    };
  }

  if (!anyBlocked) {
    return { allowStop: true, blocking: false };
  }

  // AgenC critical subtlety (1297-1299): when the LAST assistant
  // message is an API error, DO NOT fire executeStopFailureHooks —
  // tokens spiral. A blocking hook on an API-error turn skips the
  // inject and allows stop.
  if (request.lastIsApiErrorMessage) {
    emitWarning(
      session.eventLog,
      session.nextInternalSubId(),
      "stop_hook_skipped_on_api_error",
      "stop-hook block skipped because last assistant message is an API error (I-8 guard)",
    );
    return {
      allowStop: true,
      blocking: false,
      reason: "api_error_stop_guard",
    };
  }

  // Normal blocking path — inject the first fragment + bump counter.
  const injectedMessage =
    injectedFragments.length > 0
      ? injectedFragments.join("\n\n")
      : "Stop-hook requested continuation.";

  state.stopHookBlockingCount += 1;
  state.stopHookActive = true;

  return {
    allowStop: false,
    blocking: true,
    injectedMessage,
    reason: "stop_hook_blocked",
  };
}

function buildHookMessages(state: TurnState): Message[] {
  const completedToolResults = buildCompletedToolResultLookup(state);
  const messages = state.messages.map((message, index) =>
    hookMessageFromLlm(message, index, completedToolResults),
  );
  const lastAssistant = state.assistantMessages.at(-1);
  if (!lastAssistant) return messages;
  if (lastLlmAssistantMatches(state.messages.at(-1), lastAssistant)) {
    return messages;
  }
  return [
    ...messages,
    hookMessageFromAssistant(lastAssistant, messages.length),
  ];
}

function buildCompletedToolResultLookup(
  state: TurnState,
): ReadonlyMap<string, { readonly content: string; readonly isError: boolean }> {
  return new Map(
    (state.completedToolResults ?? []).map((result) => [
      result.callId,
      { content: result.content, isError: result.isError },
    ]),
  );
}

function lastLlmAssistantMatches(
  message: LLMMessage | undefined,
  assistant: AssistantMessage,
): boolean {
  if (message?.role !== "assistant") return false;
  const text = contentText(message.content);
  const toolCalls = message.toolCalls ?? [];
  return (
    text === (assistant.text ?? "") &&
    toolCalls.length === assistant.toolCalls.length &&
    toolCalls.every(
      (call, index) => call.id === assistant.toolCalls[index]?.id,
    )
  );
}

function hookMessageFromLlm(
  message: LLMMessage,
  index: number,
  completedToolResults: ReadonlyMap<
    string,
    { readonly content: string; readonly isError: boolean }
  >,
): Message {
  const uuid = createHookMessageUuid("history", index);
  const timestamp = new Date().toISOString();

  if (message.role === "assistant") {
    const content: Array<Record<string, unknown>> = [];
    const text = contentText(message.content);
    if (text.length > 0) content.push({ type: "text", text });
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseToolInput(call.arguments),
      });
    }
    return {
      type: "assistant",
      uuid,
      timestamp,
      message: {
        role: "assistant",
        content,
      },
    };
  }

  if (message.role === "tool") {
    const completed = message.toolCallId !== undefined
      ? completedToolResults.get(message.toolCallId)
      : undefined;
    return {
      type: "user",
      uuid,
      timestamp,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            // Configured hooks consume the legacy transcript API rather than
            // model history. Preserve exact tool data for deterministic
            // linters/parsers while the LLM-facing copy remains framed; any
            // hook continuation is separately framed before model re-entry.
            content: completed?.content ?? hookContent(message.content),
            is_error: completed?.isError === true,
          },
        ],
      },
    };
  }

  return {
    type: message.role === "user" ? "user" : "system",
    uuid,
    timestamp,
    message: {
      role: message.role,
      content: hookContent(message.content),
    },
  };
}

function hookMessageFromAssistant(
  assistant: AssistantMessage,
  index: number,
): Message {
  return {
    type: "assistant",
    uuid: assistant.uuid || createHookMessageUuid("assistant", index),
    timestamp: new Date().toISOString(),
    ...(assistant.apiError ? { isApiErrorMessage: true } : {}),
    message: {
      role: "assistant",
      content: assistantContentBlocks(assistant),
    },
  };
}

function assistantContentBlocks(
  assistant: AssistantMessage,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (assistant.text && assistant.text.length > 0) {
    blocks.push({ type: "text", text: assistant.text });
  }
  for (const call of assistant.toolCalls) {
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parseToolInput(call.arguments),
    });
  }
  return blocks;
}

function contentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function hookContent(
  content: LLMMessage["content"],
): string | LLMContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => ({ ...part }));
}

function createHookMessageUuid(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Stop-failure hooks — port of AgenC executeStopFailureHooks
// ─────────────────────────────────────────────────────────────────────

/**
 * Run stop-failure hooks ONLY when the last assistant message is an
 * API error (AgenC query.ts:1297-1299 guard). Without this
 * guard the hooks fire on every terminal turn, even successful
 * ones, which spirals tokens on stop-hook-inject loops.
 */
export async function executeStopFailureHooks(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
): Promise<void> {
  const lastAssistant = state.assistantMessages.at(-1);
  if (!isApiErrorAssistantMessage(lastAssistant)) {
    return;
  }
  const hooks = listConfiguredStopFailureHooks(session);
  for (const hook of hooks) {
    try {
      await hook.run({
        sessionId: session.conversationId,
        turnId: ctx.subId,
        cwd: ctx.cwd,
        ...(session.rolloutStore?.rolloutPath !== undefined
          ? { transcriptPath: session.rolloutStore.rolloutPath }
          : {}),
        model: ctx.modelInfo.slug,
        permissionMode: currentPermissionMode(ctx, session),
        stopHookActive: state.stopHookActive === true,
        ...(lastAssistant?.text !== undefined
          ? { lastAssistantMessage: lastAssistant.text }
          : {}),
        lastIsApiErrorMessage: true,
      });
    } catch (err) {
      emitError(session.eventLog, session.nextInternalSubId(), {
        cause: "stop_failure_hook_threw",
        message: `${hook.name} threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Hook registry bridge (T10 wires real hook config)
// ─────────────────────────────────────────────────────────────────────

function listConfiguredStopHooks(session: Session): ReadonlyArray<StopHookHandler> {
  const hooks = session.services.hooks as unknown as {
    readonly stopHooks?: ReadonlyArray<StopHookHandler>;
  };
  return hooks?.stopHooks ?? [];
}

function listConfiguredStopFailureHooks(
  session: Session,
): ReadonlyArray<StopHookHandler> {
  const hooks = session.services.hooks as unknown as {
    readonly stopFailureHooks?: ReadonlyArray<StopHookHandler>;
  };
  return hooks?.stopFailureHooks ?? [];
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function isApiErrorAssistantMessage(
  msg: AssistantMessage | undefined,
): boolean {
  if (!msg) return false;
  if (msg.apiError && msg.apiError.length > 0) return true;
  // Fallback check: starts with sentinel PTL phrase.
  const text = msg.text ?? "";
  return text.startsWith("Prompt is too long");
}

function currentPermissionMode(ctx: TurnContext, session: Session): string {
  const sessionSurface = session as {
    readonly permissionModeRegistry?: {
      current?: () => { readonly mode?: unknown };
    };
    readonly services?: {
      readonly permissionModeRegistry?: {
        current?: () => { readonly mode?: unknown };
      };
    };
  };
  const directMode = asRecord(
    sessionSurface.permissionModeRegistry?.current?.(),
  )?.mode;
  const serviceMode = asRecord(
    sessionSurface.services?.permissionModeRegistry?.current?.(),
  )?.mode;
  return (
    stringValue(directMode) ??
    stringValue(serviceMode) ??
    stringValue(ctx.permissionMode) ??
    "default"
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
