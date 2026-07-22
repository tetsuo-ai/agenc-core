/**
 * Ports upstream `src/services/AgentSummary/agentSummary.ts` onto AgenC's
 * prompt-suggestion fork runtime.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC injects transcript lookup and progress updates so the service can
 *     be wired into the local task registry without importing coordinator UI.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None; this service keeps the upstream summary scheduling and fork shape.
 *
 * Periodic background summarization for coordinator-mode subagents.
 *
 * Forks a subagent transcript after each interval to produce a concise
 * progress label, then stores it through the caller-provided progress
 * update hook.
 *
 * @module
 */

import type {
  CacheSafeParams,
  ForkedAgentResult,
} from "../PromptSuggestion/runtime.js";
import type { CacheSafeParams as ForkedAgentCacheSafeParams } from "../../utils/forkedAgent.js";
import type { Message } from "../../types/message.js";
import {
  createUserMessage as defaultCreateUserMessage,
  runForkedAgent as defaultRunForkedAgent,
} from "../PromptSuggestion/runtime.js";

export const SUMMARY_INTERVAL_MS = 120_000;

/**
 * Adapter across the deliberate PromptSuggestion decoupling boundary. The fork
 * machinery hands callers a concrete `CacheSafeParams` (full `ToolUseContext` +
 * the canonical `SpeculationState`); this service intentionally types its
 * `cacheSafeParams` against `PromptSuggestion/runtime`, which defines its own
 * looser `ToolUseContext`/`SpeculationState` so the service never imports
 * tui/app-state types. The runtime object is the real, richer one and is valid
 * for the fork — the structural-subset relation just isn't statically provable
 * (a circular SpeculationState → REPLHookContext → ToolUseContext → AppState
 * chain). This is the single, documented boundary cast; call sites must not
 * re-cast inline.
 */
export function toSummaryCacheSafeParams(
  params: ForkedAgentCacheSafeParams,
): CacheSafeParams {
  return params as unknown as CacheSafeParams;
}

export interface AgentTranscript {
  readonly messages: readonly Message[];
}

export interface AgentSummaryHandle {
  stop(): void;
}

export type AgentSummaryToolDecision = {
  readonly behavior: "deny";
  readonly message: string;
  readonly decisionReason: { readonly type: "other"; readonly reason: string };
};

export type AgentSummaryCanUseTool = () =>
  | AgentSummaryToolDecision
  | Promise<AgentSummaryToolDecision>;

export interface AgentSummaryRunForkedAgentParams {
  readonly promptMessages: readonly Message[];
  readonly cacheSafeParams: CacheSafeParams;
  readonly canUseTool: AgentSummaryCanUseTool;
  readonly querySource: "agent_summary";
  readonly forkLabel: "agent_summary";
  readonly overrides: { readonly abortController: AbortController };
  readonly skipTranscript: true;
}

export interface StartAgentSummarizationOptions {
  readonly taskId: string;
  readonly agentId: string;
  readonly cacheSafeParams: CacheSafeParams;
  readonly getAgentTranscript: (
    agentId: string,
  ) => Promise<AgentTranscript | null | undefined>;
  readonly updateAgentSummary: (taskId: string, summary: string) => void;
  readonly intervalMs?: number;
  readonly runForkedAgent?: (
    params: AgentSummaryRunForkedAgentParams,
  ) => Promise<ForkedAgentResult>;
  readonly createUserMessage?: (input: { readonly content: string }) => Message;
  readonly logDebug?: (message: string) => void;
  readonly logError?: (error: unknown) => void;
}

export function buildSummaryPrompt(previousSummary: string | null): string {
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" - say something NEW.\n`
    : "";

  return `Describe your most recent action in 1-2 concise sentences using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts to trace the tool-call flow."
Good: "Fixing the null check in validate.ts before rerunning tests."
Good: "Running the auth module tests and checking failures."
Good: "Adding retry logic to fetchUser for transient errors."

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff, checking every service integration, and writing a long implementation report"
Bad (branch name): "Analyzed feature/background-summary branch diff"`;
}

function messageType(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const value = (message as { readonly type?: unknown }).type;
  return typeof value === "string" ? value : null;
}

function messageContent(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return undefined;
  const nested = (message as { readonly message?: { readonly content?: unknown } })
    .message;
  return nested?.content;
}

function toolResultId(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const type = (block as { readonly type?: unknown }).type;
  const id = (block as { readonly tool_use_id?: unknown }).tool_use_id;
  return type === "tool_result" && typeof id === "string" && id
    ? id
    : null;
}

function incompleteToolUseId(
  block: unknown,
  toolUseIdsWithResults: ReadonlySet<string>,
): string | null {
  if (typeof block !== "object" || block === null) return null;
  const type = (block as { readonly type?: unknown }).type;
  const id = (block as { readonly id?: unknown }).id;
  if (type !== "tool_use" || typeof id !== "string" || !id) return null;
  return toolUseIdsWithResults.has(id) ? null : id;
}

/**
 * Drop assistant messages containing unpaired tool_use blocks while
 * preserving completed tool calls, orphaned tool results, non-assistant
 * messages, and assistant messages with non-array content.
 */
export function filterIncompleteToolCalls(
  messages: readonly Message[],
): Message[] {
  const toolUseIdsWithResults = new Set<string>();
  for (const message of messages) {
    if (messageType(message) !== "user") continue;
    const content = messageContent(message);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const id = toolResultId(block);
      if (id) toolUseIdsWithResults.add(id);
    }
  }

  return messages.filter((message) => {
    if (messageType(message) !== "assistant") return true;
    const content = messageContent(message);
    if (!Array.isArray(content)) return true;
    return !content.some(
      (block) => incompleteToolUseId(block, toolUseIdsWithResults) !== null,
    );
  });
}

function extractTextFromBlock(block: unknown): string | null {
  if (typeof block !== "object" || block === null) return null;
  const type = (block as { readonly type?: unknown }).type;
  const text = (block as { readonly text?: unknown }).text;
  if (type !== "text" || typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export function extractAssistantSummaryText(result: unknown): string | null {
  const messages = (result as { readonly messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (messageType(message) !== "assistant") continue;
    if ((message as { readonly isApiErrorMessage?: unknown }).isApiErrorMessage) {
      continue;
    }
    const content = messageContent(message);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = extractTextFromBlock(block);
      if (text) return text;
    }
  }
  return null;
}

function denySummaryToolUse(): AgentSummaryToolDecision {
  return {
    behavior: "deny",
    message: "No tools needed for summary",
    decisionReason: { type: "other", reason: "summary only" },
  };
}

export function startAgentSummarization(
  options: StartAgentSummarizationOptions,
): AgentSummaryHandle {
  const {
    forkContextMessages: _dropForkContextMessages,
    ...baseParams
  } = options.cacheSafeParams;
  const intervalMs = options.intervalMs ?? SUMMARY_INTERVAL_MS;
  const runForkedAgent = options.runForkedAgent ?? defaultRunForkedAgent;
  const createUserMessage = options.createUserMessage ?? defaultCreateUserMessage;
  let summaryAbortController: AbortController | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let previousSummary: string | null = null;
  // Message count at the last successful summary. Lets the periodic sweep skip
  // a redundant LLM call when nothing new was produced since — the common case
  // for a keep-alive worker sitting idle between turns, where re-summarizing
  // the same transcript just burns tokens and an admission slot.
  let lastSummarizedMessageCount = 0;

  function scheduleNext(): void {
    if (stopped) return;
    timeoutId = setTimeout(() => {
      timeoutId = null;
      void runSummary();
    }, intervalMs);
  }

  async function runSummary(): Promise<void> {
    if (stopped) return;
    options.logDebug?.(`Agent summary timer fired for ${options.agentId}`);

    try {
      const transcript = await options.getAgentTranscript(options.agentId);
      if (stopped) return;
      if (!transcript || transcript.messages.length < 3) {
        options.logDebug?.(
          `Skipping agent summary for ${options.taskId}: not enough messages (${transcript?.messages.length ?? 0})`,
        );
        return;
      }
      // No new messages since the last summary — nothing to condense. This is
      // what stops an idle keep-alive worker from re-forking its whole
      // transcript into an LLM call every interval.
      if (transcript.messages.length <= lastSummarizedMessageCount) {
        options.logDebug?.(
          `Skipping agent summary for ${options.taskId}: no new messages since last summary`,
        );
        return;
      }

      const cleanMessages = filterIncompleteToolCalls(transcript.messages);
      const forkParams: CacheSafeParams = {
        ...baseParams,
        forkContextMessages: cleanMessages,
      };
      summaryAbortController = new AbortController();

      const result = await runForkedAgent({
        promptMessages: [
          createUserMessage({ content: buildSummaryPrompt(previousSummary) }),
        ],
        cacheSafeParams: forkParams,
        canUseTool: denySummaryToolUse,
        querySource: "agent_summary",
        forkLabel: "agent_summary",
        overrides: { abortController: summaryAbortController },
        skipTranscript: true,
      });

      if (stopped) return;
      const summaryText = extractAssistantSummaryText(result);
      if (!summaryText) return;
      previousSummary = summaryText;
      lastSummarizedMessageCount = transcript.messages.length;
      options.updateAgentSummary(options.taskId, summaryText);
    } catch (error) {
      if (!stopped) options.logError?.(error);
    } finally {
      summaryAbortController = null;
      if (!stopped) scheduleNext();
    }
  }

  scheduleNext();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (summaryAbortController) {
        summaryAbortController.abort();
        summaryAbortController = null;
      }
    },
  };
}
