/**
 * Phase 6 — Commit.
 *
 * Mirrors agenc `query.ts:1192-1465` (iteration tail) + 1643-1836
 * (terminal commit). Responsibilities per Follow-up.MD T5-B line 974:
 *
 *   1. **Append history** — ensure all iteration outputs (assistant
 *      message, tool results, attachments) are in `state.messages`.
 *      Await any pending tool-use summary promise so the UI sees the
 *      final text before the next iteration, without re-inserting
 *      renderer-only summaries into model-visible history.
 *
 *   2. **Compaction boundary** — if this iteration ran auto-compact
 *      successfully (tracking.compacted && turnCounter === 0), emit a
 *      `context_compacted` event so the rollout sidecar (T6) can stamp
 *      the boundary marker.
 *
 *   3. **Stop gate** — when the turn is about to terminate naturally
 *      (no tool calls, no transition), invoke stop hooks. Blocking
 *      hooks set `transition: stop_hook_blocking`; the counter was
 *      already bumped inside `evaluateStopHooks()` (I-17:
 *      MAX_STOP_HOOK_BLOCKS=3). Non-blocking hooks fall through to
 *      terminal.
 *
 *   4. Bump `turnCount`; clear per-iteration fields that survive into
 *      the next iteration via continue-site re-entry.
 *
 * The full stop-hook implementation lives behind `evaluateStopHooks`
 * in `stop-hooks.ts` (T8 replaces the stub with the real hook runner).
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  AssistantMessage,
  CompletedToolResultRecord,
  TurnState,
} from "../session/turn-state.js";
import {
  buildAgenCToolUseContext,
  type AgenCToolUseContext,
} from "../session/agenc-tool-use-context.js";
import type { LLMContentPart, LLMMessage, LLMUsage } from "../llm/types.js";
import {
  cloneLlmMessageSnapshot as cloneMessage,
} from "../llm/content-conversion.js";
import {
  ensureExtractMemoriesInitialized,
  executeExtractMemories,
} from "../services/extractMemories/extractMemories.js";
import { executePromptSuggestion } from "../services/PromptSuggestion/promptSuggestion.js";
import { executeAutoDream } from "../services/autoDream/autoDream.js";
import type { ToolUseContext } from "../tools/Tool.js";
import type { Message } from "../types/message.js";
import { getGlobalConfig } from "../utils/config.js";
import { isBareMode, isEnvDefinedFalsy } from "../utils/envUtils.js";
import {
  createCacheSafeParams,
  saveCacheSafeParams,
} from "../utils/forkedAgent.js";
import type { REPLHookContext } from "../utils/hooks/postSamplingHooks.js";
import { asSystemPrompt } from "../utils/systemPromptType.js";
import { renderHookAdditionalContextSection } from "../prompts/hook-context-framing.js";
import { evaluateStopHooks } from "./stop-hooks.js";

/**
 * I-17: hard cap on how many consecutive stop-hook blocking cycles
 * we tolerate before force-terminating with error. Matches AgenC
 * `MAX_STOP_HOOK_BLOCKS = 3` (query.ts:163).
 */
const MAX_STOP_HOOK_BLOCKS = 3;

function toolUseSummaryText(summary: unknown): string | null {
  if (
    summary === null ||
    summary === undefined ||
    typeof summary !== "object"
  ) {
    return null;
  }
  const record = summary as Record<string, unknown>;
  const text =
    typeof record.summary === "string"
      ? record.summary.trim()
      : typeof record.content === "string"
        ? record.content.trim()
        : "";
  if (text.length === 0) return null;
  return text;
}

function cloneCompletedToolResult(
  record: CompletedToolResultRecord,
): CompletedToolResultRecord {
  return {
    ...record,
    ...(record.metadata !== undefined
      ? { metadata: { ...record.metadata } }
      : {}),
  };
}

function emitSavedMemoryMessage(
  session: Session,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  const message =
    paths.length === 1
      ? `Saved memory: ${paths[0]}`
      : `Saved memories: ${paths.join(", ")}`;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "agent_message",
      payload: { message },
    },
  });
}

interface CommitOptions {
  readonly querySource?: string;
}

function querySourceForCommit(
  session: Session,
  options: CommitOptions,
): string {
  const raw =
    options.querySource ??
    (typeof session.services.querySource === "string"
      ? session.services.querySource
      : undefined);
  return raw && raw.length > 0 ? raw : "repl_main_thread";
}

function isCacheSharingQuerySource(querySource: string): boolean {
  return querySource === "repl_main_thread" || querySource === "sdk";
}

function isMainThreadQuerySource(querySource: string): boolean {
  return querySource === "repl_main_thread";
}

function lastAssistantIsApiError(state: TurnState): boolean {
  const lastAssistant = state.assistantMessages.at(-1);
  return Boolean(
    lastAssistant?.apiError ||
    lastAssistant?.text?.startsWith("Prompt is too long"),
  );
}

function contentText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function legacyContent(
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

function buildToolResultErrorLookup(
  state: TurnState,
): ReadonlyMap<string, boolean> {
  return new Map(
    (state.completedToolResults ?? []).map((result) => [
      result.callId,
      result.isError,
    ]),
  );
}

function legacyUsage(
  usage: LLMUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.promptTokens,
    output_tokens: usage.completionTokens,
    cache_read_input_tokens: usage.cachedInputTokens ?? 0,
    cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
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

function legacyMessageFromLlm(
  message: LLMMessage,
  index: number,
  toolResultErrors: ReadonlyMap<string, boolean>,
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
            content: legacyContent(message.content),
            is_error:
              message.toolCallId !== undefined
                ? toolResultErrors.get(message.toolCallId) === true
                : false,
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
      content: legacyContent(message.content),
    },
  };
}

function legacyMessageFromAssistant(
  assistant: AssistantMessage,
  index: number,
  usage: LLMUsage | undefined,
): Message {
  const usageRecord = legacyUsage(usage);
  return {
    type: "assistant",
    uuid: assistant.uuid || createHookMessageUuid("assistant", index),
    timestamp: new Date().toISOString(),
    ...(assistant.apiError ? { isApiErrorMessage: true } : {}),
    message: {
      role: "assistant",
      content: assistantContentBlocks(assistant),
      ...(usageRecord ? { usage: usageRecord } : {}),
    },
  };
}

function splitLeadingSystemPrompt(messages: readonly LLMMessage[]): {
  readonly systemPrompt: readonly string[];
  readonly rest: readonly LLMMessage[];
} {
  const systemPrompt: string[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role !== "system" && message.role !== "developer") break;
    const text = contentText(message.content).trim();
    if (text.length > 0) systemPrompt.push(text);
    index += 1;
  }
  return { systemPrompt, rest: messages.slice(index) };
}

function buildTerminalHookContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  querySource: string,
): REPLHookContext {
  const promptMessages =
    state.messagesForQuery.length > 0 ? state.messagesForQuery : state.messages;
  const { systemPrompt, rest } = splitLeadingSystemPrompt(promptMessages);
  const toolResultErrors = buildToolResultErrorLookup(state);
  const history = rest.map((message, index) =>
    legacyMessageFromLlm(message, index, toolResultErrors),
  );
  const assistantMessages = state.assistantMessages.map((assistant, index) =>
    legacyMessageFromAssistant(
      assistant,
      index,
      index === state.assistantMessages.length - 1
        ? state.lastResponseUsage
        : undefined,
    ),
  );
  const toolUseContext = buildAgenCToolUseContext(session, ctx, {
    querySource,
  }) as unknown as ToolUseContext;

  return {
    messages: [...history, ...assistantMessages],
    systemPrompt: asSystemPrompt(systemPrompt),
    userContext: {},
    systemContext: {},
    toolUseContext,
    querySource,
  };
}

function launchTerminalBackgroundHooks(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  querySource: string,
): void {
  if (lastAssistantIsApiError(state)) return;

  const hookContext = buildTerminalHookContext(
    state,
    ctx,
    session,
    querySource,
  );
  if (isCacheSharingQuerySource(querySource)) {
    saveCacheSafeParams(createCacheSafeParams(hookContext));
  }

  if (isBareMode()) return;

  if (
    isMainThreadQuerySource(querySource) &&
    !isEnvDefinedFalsy(process.env.AGENC_ENABLE_PROMPT_SUGGESTION)
  ) {
    void executePromptSuggestion(
      hookContext as unknown as Parameters<typeof executePromptSuggestion>[0],
      {
        cwd: ctx.cwd,
        speculationEnabled: getGlobalConfig().speculationEnabled,
      },
    ).catch(() => {});
  }

  const typedToolUseContext =
    hookContext.toolUseContext as unknown as AgenCToolUseContext;
  if (
    isCacheSharingQuerySource(querySource) &&
    typedToolUseContext.agentId === undefined
  ) {
    void executeAutoDream(
      hookContext,
      typedToolUseContext.appendSystemMessage,
    ).catch(() => {});
  }
}

export async function commit(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
  options: CommitOptions = {},
): Promise<TurnState> {
  // ── 1. Append history — await any pending tool-use summary promise
  //      so the UI sees the final summary before the next iteration.
  if (state.pendingToolUseSummary) {
    try {
      const summary = await state.pendingToolUseSummary;
      const summaryText = toolUseSummaryText(summary);
      if (summaryText) {
        // Tool-use summaries are UI affordances only. Re-inserting them
        // into `state.messages` makes the next model turn treat renderer
        // commentary as conversation history, which diverges from the
        // retained compact/replay contract.
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "agent_message",
            payload: {
              message: summaryText,
            },
          },
        });
      }
    } catch {
      /* summary failures non-fatal; executor emits stream_error */
    } finally {
      state.pendingToolUseSummary = undefined;
    }
  }

  // Drop the streaming tool executor reference so the next iteration
  // constructs a fresh one (matches AgenC query.ts:572).
  state.streamingToolExecutor = null;

  // ── 2. Compaction boundary — if this iteration's tracking state
  //      records a successful compact (compacted=true, turnCounter=0
  //      was reset by the AgenC compact adapter), emit a typed boundary
  //      marker so the rollout sidecar (T6) can stamp it.
  const tracking = state.autoCompactTracking;
  if (tracking && tracking.compacted && tracking.turnCounter === 0) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "context_compacted",
        payload: {
          summary: `auto-compact boundary (turnId=${tracking.turnId})`,
        },
      },
    });
    // T6 I-24b: re-append session metadata so --resume readers that
    // scan the last 16KB of the rollout still find the session
    // header even after many compacts have pushed it out of range.
    // Port of agenc sessionStorage.ts::reAppendSessionMetadata.
    session.rolloutStore?.store.reAppendSessionMetadata();
    // Mark the boundary as consumed so subsequent iterations don't
    // re-emit until the next successful compact mutates the turnId.
    state.autoCompactTracking = {
      ...tracking,
      // advance turnCounter so the marker only fires once per boundary
      turnCounter: 1,
    };
  }

  // ── 3. Stop gate — only evaluate when the turn is about to
  //      terminate naturally (no tool calls pending, no recovery
  //      transition already set). Recovery transitions (reactive
  //      compact, max-tokens recovery, etc.) route around the stop
  //      gate; stop hooks only matter at the terminal boundary.
  const turnIsTerminating =
    state.toolUseBlocks.length === 0 &&
    state.transition === undefined &&
    !state.needsFollowUp;

  if (turnIsTerminating) {
    launchTerminalBackgroundHooks(
      state,
      ctx,
      session,
      querySourceForCommit(session, options),
    );
    const result = await evaluateStopHooks(state, ctx, session, signal);
    if (result.blocking) {
      if (state.stopHookBlockingCount >= MAX_STOP_HOOK_BLOCKS) {
        // I-17: stop-hook recursion cap tripped. Surface as an error
        // event + force-terminate with the blocking reason.
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "error",
            payload: {
              cause: "stop_hook_loop",
              message: `stop hooks blocked ${state.stopHookBlockingCount} times in a row — forcing terminal (${result.reason ?? "no_reason"})`,
            },
          },
        });
        state.stopHookActive = false;
        // Do NOT set transition: the cap being hit means we exit, not
        // re-enter. run-turn sees no transition + no tool calls →
        // terminal.
      } else {
        // Inject the hook's suggested message (if any) and set the
        // transition so run-turn re-enters PrepareContext.
        if (result.injectedMessage) {
          const modelFacingHookOutput =
            renderHookAdditionalContextSection([
              {
                hookName: "configured-stop-hooks",
                hookEvent: "Stop",
                content: result.injectedMessage,
              },
            ]) ?? result.injectedMessage;
          state.messages.push({
            role: "user",
            content: modelFacingHookOutput,
          });
        }
        state.transition = { reason: "stop_hook_blocking" };
        state.stopHookActive = true;
      }
    } else {
      state.stopHookActive = false;
      state.stopHookBlockingCount = 0;
      const messages = state.messages.map(cloneMessage);
      const completedToolResults = state.completedToolResults.map(
        cloneCompletedToolResult,
      );
      ensureExtractMemoriesInitialized();
      void executeExtractMemories(
        {
          messages,
          completedToolResults,
          ctx,
          session,
          signal,
        },
        (paths) => emitSavedMemoryMessage(session, paths),
      ).catch(() => {});
    }
  }

  // ── 4. Bump turnCount + clear one-shot overrides. recoveryReentry
  //      and stop-hook-blocking counters are preserved here — they
  //      only reset on a successful non-recovering iteration.
  state.turnCount += 1;
  state.maxOutputTokensOverride = undefined;
  return state;
}
