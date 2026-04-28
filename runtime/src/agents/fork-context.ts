/**
 * Fork-context — build a child's initial message set from the
 * parent's history.
 *
 * Hand-port of AgenC `tools/AgentTool/forkSubagent.ts` +
 * `utils/forkedAgent.ts` (410 LOC combined). Four fork modes:
 *
 *   - `full_history` — child receives the full parent history.
 *   - `last_n_turns` — child receives the last N user-turn
 *     boundaries + their assistant replies.
 *   - `new` — child starts fresh with just the task directive.
 *   - `explicit` — caller supplies the exact LLMMessage[] prefix.
 *
 * Invariants wired:
 *   I-36 (parent rollout flush before fork) — `forkSubagent`
 *        awaits `parent.rolloutStore.flushDurable()` before reading
 *        the parent's history so a mid-compact state doesn't leak.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { ResponseItem, RolloutItem } from "../session/rollout-item.js";
import type { Session } from "../session/session.js";

// ─────────────────────────────────────────────────────────────────────
// Fork modes
// ─────────────────────────────────────────────────────────────────────

export type ForkMode =
  | { readonly kind: "full_history" }
  | { readonly kind: "last_n_turns"; readonly n: number }
  | { readonly kind: "new" }
  | { readonly kind: "explicit"; readonly messages: ReadonlyArray<LLMMessage> };

export interface ForkContextInput {
  readonly parent: Session;
  readonly parentMessages: ReadonlyArray<LLMMessage>;
  readonly mode: ForkMode;
  readonly taskPrompt: string;
  readonly worktreePath?: string;
}

export interface ForkContextResult {
  readonly messages: ReadonlyArray<LLMMessage>;
  readonly directivePrompt: string;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** Count user-role messages; used by last_n_turns slicing. */
function lastNUserTurns(
  messages: ReadonlyArray<LLMMessage>,
  n: number,
): LLMMessage[] {
  if (n <= 0) return [];
  // Walk backwards; each user message begins a turn.
  let userCount = 0;
  let sliceIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      userCount += 1;
      if (userCount === n) {
        sliceIndex = i;
        break;
      }
    }
  }
  return [...messages.slice(sliceIndex)];
}

/**
 * Build the directive message every subagent receives. Based on
 * AgenC's fork-subagent preamble: explicit task + worktree
 * notice + guardrails.
 */
function buildDirective(input: ForkContextInput): string {
  const lines: string[] = [
    "You are a subagent spawned to complete a specific task.",
    `Task: ${input.taskPrompt}`,
  ];
  if (input.worktreePath) {
    const parentCwd =
      input.parent.sessionConfiguration.cwd ?? input.parent.config.cwd;
    if (parentCwd && parentCwd !== input.worktreePath) {
      lines.push(
        `You've inherited conversation context from a parent working in ${parentCwd}. ` +
          `You are operating in an isolated git worktree at ${input.worktreePath}. ` +
          "Translate inherited paths to the worktree root and re-read files before editing if they may have changed.",
      );
    } else {
      lines.push(
        `Working directory: ${input.worktreePath} (isolated git worktree)`,
      );
    }
  }
  lines.push(
    "Your parent will see your final message and the tool results you produced.",
    "Do not spawn further subagents unless explicitly instructed.",
  );
  return lines.join("\n");
}

function responseItemToForkMessage(item: ResponseItem): LLMMessage | null {
  if (item.role === "tool") return null;
  if (item.role === "assistant") {
    if (item.phase === "commentary") return null;
    if (item.toolCallId || item.toolName) return null;
  }
  return {
    role: item.role,
    content: (typeof item.content === "string"
      ? item.content
      : item.content.map((part) => ({ ...part }))) as LLMMessage["content"],
    ...(item.phase === "commentary" || item.phase === "final_answer"
      ? { phase: item.phase }
      : {}),
  };
}

function responseItemsToForkMessages(
  items: ReadonlyArray<ResponseItem>,
): LLMMessage[] {
  return items.flatMap((item) => {
    const message = responseItemToForkMessage(item);
    return message ? [message] : [];
  });
}

function rolloutItemsToForkMessages(
  items: ReadonlyArray<RolloutItem>,
): LLMMessage[] {
  let messages: LLMMessage[] = [];
  for (const item of items) {
    if (item.type === "compacted" && item.payload.replacementHistory) {
      messages = responseItemsToForkMessages(item.payload.replacementHistory);
      continue;
    }
    if (item.type !== "response_item") continue;
    const message = responseItemToForkMessage(item.payload);
    if (message) messages.push(message);
  }
  return messages;
}

function rolloutBackedParentMessages(input: ForkContextInput): LLMMessage[] {
  const rolloutStore = input.parent.rolloutStore;
  if (!rolloutStore) return [...input.parentMessages];
  try {
    const rolloutMessages = rolloutItemsToForkMessages(rolloutStore.readAll());
    return rolloutMessages.length > 0
      ? rolloutMessages
      : [...input.parentMessages];
  } catch {
    return [...input.parentMessages];
  }
}

// ─────────────────────────────────────────────────────────────────────
// forkSubagent — the main entry
// ─────────────────────────────────────────────────────────────────────

/**
 * Produce the initial message array for a child agent.
 *
 * I-36: before reading the parent's messages, we force-flush the
 * parent rollout so any batched events (100ms window) land on disk
 * before the child picks up state. Without this, a mid-compact
 * parent may leak half-written messages into the child's fork.
 */
export async function forkSubagent(
  input: ForkContextInput,
): Promise<ForkContextResult> {
  // I-36: flush parent rollout.
  if (input.parent.rolloutStore) {
    try {
      input.parent.rolloutStore.flushDurable();
    } catch {
      /* best-effort — the caller (I-8 emitError) surfaces the rest */
    }
  }

  const directivePrompt = buildDirective(input);
  const directiveMessage: LLMMessage = {
    role: "user",
    content: directivePrompt,
  };
  const parentMessages = rolloutBackedParentMessages(input);

  switch (input.mode.kind) {
    case "new":
      return {
        messages: [directiveMessage],
        directivePrompt,
      };

    case "full_history":
      return {
        messages: [...parentMessages, directiveMessage],
        directivePrompt,
      };

    case "last_n_turns":
      return {
        messages: [
          ...lastNUserTurns(parentMessages, input.mode.n),
          directiveMessage,
        ],
        directivePrompt,
      };

    case "explicit":
      return {
        messages: [...input.mode.messages, directiveMessage],
        directivePrompt,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cache-safe fork params
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of AgenC `utils/forkedAgent.ts::buildCacheSafeParams`.
 * Ensures the child request shares the parent's prompt-cache prefix
 * when possible by preserving the ordered tuple (systemPrompt,
 * systemContext, toolCatalog hashes). Callers supply the parent's
 * catalog + prompt; we return a bag with the minimal delta applied.
 */
export interface CacheSafeParams {
  readonly systemPrompt: string;
  readonly toolCatalogIds: ReadonlyArray<string>;
  readonly userContextKeys: ReadonlyArray<string>;
}

export function buildCacheSafeParams(opts: {
  readonly parent: CacheSafeParams;
  readonly overrideSystemPrompt?: string;
  readonly overrideToolAllowlist?: ReadonlyArray<string>;
}): CacheSafeParams {
  const systemPrompt =
    opts.overrideSystemPrompt ?? opts.parent.systemPrompt;
  const toolCatalogIds = opts.overrideToolAllowlist
    ? opts.parent.toolCatalogIds.filter((id) =>
        opts.overrideToolAllowlist!.includes(id),
      )
    : opts.parent.toolCatalogIds;
  return {
    systemPrompt,
    toolCatalogIds,
    userContextKeys: opts.parent.userContextKeys,
  };
}
