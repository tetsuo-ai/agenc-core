/**
 * Content-replacement state — port of AgenC
 * `utils/toolResultStorage.ts::ContentReplacementState` adapted to gut's
 * flat `LLMMessage` shape.
 *
 * Implements I-88 in-memory invariants:
 *   - `seenIds`: every tool-call id whose tool-role message has passed
 *     through enforcement. Once seen, a result's fate is frozen for the
 *     rest of the session so prompt-cache prefix stays stable.
 *   - `replacements`: subset of `seenIds` whose content was replaced
 *     with a truncation/persisted marker. Re-application across turns
 *     is a Map lookup — zero I/O, byte-identical, cannot fail.
 *
 * Lifecycle:
 *   - `provisionContentReplacementState(priorMessages?)` creates a
 *     fresh state on cold start, or reconstructs `seenIds` from a
 *     resumed prior history so already-cached unreplaced results stay
 *     unreplaced (cache stability).
 *   - `applyToolResultBudget` (in `phases/_deps/tool-result-storage`)
 *     mutates the state in place each turn.
 *
 * @module
 */

import type { LLMMessage } from "../../llm/types.js";

/**
 * Per-conversation-thread state for the aggregate tool result budget.
 *
 * Mirrors agenc `ContentReplacementState` with the same prompt-
 * cache stability contract: once an id is in `seenIds` its decision
 * is frozen, and once an id is in `replacements` the cached marker is
 * re-applied byte-identical every turn.
 */
export interface ContentReplacementState {
  readonly seenIds: Set<string>;
  readonly replacements: Map<string, string>;
}

/** Allocate an empty replacement state. */
function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}

/**
 * Discriminated record persisted (best-effort) for resume rebuild.
 * Mirrors agenc `ContentReplacementRecord` with the same
 * `kind: 'tool-result'` discriminator so future replacement mechanisms
 * (offloaded images, etc.) can extend the same record type.
 */
export interface ContentReplacementRecord {
  readonly kind: "tool-result";
  readonly toolUseId: string;
  readonly replacement: string;
}

/**
 * Walk a prior message history to seed `seenIds`. Every tool-role
 * message id is treated as "the model already saw this", so subsequent
 * budget passes never replace it (replacing a previously-unreplaced
 * result mid-conversation would invalidate prompt cache). When records
 * are supplied (from prior on-disk persistence) the `replacements` Map
 * is also populated for byte-identical re-apply.
 *
 * Mirrors agenc `reconstructContentReplacementState`. Adapted to
 * gut's flat `LLMMessage` (tool messages are role="tool" with
 * `toolCallId`), not AgenC's `tool_result` blocks inside user
 * `Message.message.content`.
 */
function reconstructContentReplacementState(
  messages: ReadonlyArray<LLMMessage>,
  records: ReadonlyArray<ContentReplacementRecord>,
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState();
  const candidateIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const id = message.toolCallId;
    if (typeof id === "string" && id.length > 0) {
      candidateIds.add(id);
    }
  }
  for (const id of candidateIds) {
    state.seenIds.add(id);
  }
  for (const record of records) {
    if (record.kind === "tool-result" && candidateIds.has(record.toolUseId)) {
      state.replacements.set(record.toolUseId, record.replacement);
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement);
      }
    }
  }
  return state;
}

/**
 * Provision replacement state at turn-state-build time. Mirrors
 * agenc `provisionContentReplacementState` minus the GrowthBook
 * gate (gut runs the budget unconditionally — there is no
 * `tengu_hawthorn_steeple` flag in this runtime, so the feature is
 * always on for I-88 compliance).
 *
 *   - No priorMessages → fresh state.
 *   - priorMessages present → reconstruct so prior unreplaced results
 *     stay unreplaced (prompt-cache stability across resume).
 */
export function provisionContentReplacementState(
  priorMessages?: ReadonlyArray<LLMMessage>,
  initialContentReplacements?: ReadonlyArray<ContentReplacementRecord>,
): ContentReplacementState {
  if (priorMessages && priorMessages.length > 0) {
    return reconstructContentReplacementState(
      priorMessages,
      initialContentReplacements ?? [],
    );
  }
  return createContentReplacementState();
}

// ─────────────────────────────────────────────────────────────────────
// Enforcement — the aggregate per-message-group tool-result budget.
//
// This is the half the module doc above promises. It operates on the
// FLAT message shape used on the live turn path (tool results are their
// own messages carrying `toolCallId`; after runtime conversion the role
// is "user" with `originalRole: "tool"`), grouping consecutive tool
// results the way the provider wire folds them into one API message.
//
// Prompt-cache contract (identical to the block-shaped implementation
// in utils/toolResultStorage.ts):
//   - ids in `state.replacements` re-apply their cached preview string
//     byte-identically every turn (zero I/O);
//   - ids in `state.seenIds` but not `replacements` are FROZEN — never
//     replaced later (the model already saw the full content);
//   - only FRESH ids (never seen) are eligible, and only when their
//     group exceeds the budget.
// ─────────────────────────────────────────────────────────────────────

/** Structural shape the budget needs — satisfied by both LLMMessage and
 *  the runtime-converted message (which mirrors content into `.message`). */
export interface ToolResultBudgetMessage {
  readonly role?: string;
  readonly originalRole?: string;
  readonly toolCallId?: string;
  readonly content?: unknown;
  readonly message?: { readonly role?: string; readonly content?: unknown };
}

export interface ToolResultBudgetOptions {
  /** Per-message-group budget in characters. */
  readonly limitChars: number;
  /** Results smaller than this are never persisted (preview overhead
   *  would not pay for itself). Default 2_000. */
  readonly minReplaceChars?: number;
  /**
   * Persist an oversized result and return the replacement preview
   * string the model will see instead, or null when persistence failed
   * (the original content is then kept and frozen).
   */
  readonly persist: (
    content: string,
    toolUseId: string,
  ) => Promise<string | null>;
}

interface FlatCandidate {
  readonly index: number;
  readonly toolUseId: string;
  readonly content: string;
  readonly size: number;
}

/**
 * Extract the replaceable text of a tool-result message. The turn path
 * carries content in TWO shapes: a plain string (flat LLMMessage) or an
 * array of `{type:"text", text}` blocks (runtime-converted messages).
 * Mixed/non-text block arrays (images, documents) return null — those
 * results must never be persisted or shrunk.
 */
function extractToolResultText(
  message: ToolResultBudgetMessage,
): string | null {
  if (message.originalRole !== "tool" && message.role !== "tool") return null;
  if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
    return null;
  }
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length > 0) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "text" ||
        typeof (block as { text?: unknown }).text !== "string"
      ) {
        return null;
      }
      texts.push((block as { text: string }).text);
    }
    return texts.join("\n");
  }
  return null;
}


/** Group consecutive tool-result messages (one wire-level API message). */
function collectFlatCandidateGroups(
  messages: ReadonlyArray<ToolResultBudgetMessage>,
): FlatCandidate[][] {
  const groups: FlatCandidate[][] = [];
  let current: FlatCandidate[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const text = message !== undefined ? extractToolResultText(message) : null;
    if (message !== undefined && text !== null) {
      current.push({
        index,
        toolUseId: message.toolCallId as string,
        content: text,
        size: text.length,
      });
    } else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function selectFreshToReplace(
  fresh: ReadonlyArray<FlatCandidate>,
  frozenSize: number,
  limit: number,
  minReplaceChars: number,
): FlatCandidate[] {
  const sorted = [...fresh].sort((a, b) => b.size - a.size);
  const selected: FlatCandidate[] = [];
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0);
  for (const candidate of sorted) {
    if (remaining <= limit) break;
    if (candidate.size < minReplaceChars) break;
    selected.push(candidate);
    // Replacement previews are ~2K while anything selected here is much
    // larger — subtracting the full size is a close approximation.
    remaining -= candidate.size;
  }
  return selected;
}

function withReplacedContent<M extends ToolResultBudgetMessage>(
  message: M,
  replacement: string,
): M {
  // Preserve the content SHAPE the message arrived with: block arrays
  // stay block arrays (the runtime-converted path), strings stay strings.
  const shaped = Array.isArray(message.content)
    ? [{ type: "text", text: replacement }]
    : replacement;
  return {
    ...message,
    content: shaped,
    ...(message.message !== undefined
      ? {
          message: {
            ...message.message,
            content: Array.isArray(message.message.content)
              ? [{ type: "text", text: replacement }]
              : replacement,
          },
        }
      : {}),
  };
}

/**
 * Enforce the aggregate tool-result budget on a message list. Mutates
 * `state` in place (seenIds/replacements) — the caller holds the stable
 * per-thread reference. Returns the input array unchanged when nothing
 * needed replacing.
 */
export async function applyToolResultBudget<
  M extends ToolResultBudgetMessage,
>(
  messages: ReadonlyArray<M>,
  state: ContentReplacementState | undefined,
  opts: ToolResultBudgetOptions,
): Promise<{ messages: M[]; newlyReplaced: ContentReplacementRecord[] }> {
  if (state === undefined || opts.limitChars <= 0) {
    return { messages: [...messages], newlyReplaced: [] };
  }
  const minReplaceChars = opts.minReplaceChars ?? 2_000;
  const replacementByIndex = new Map<number, string>();
  const toPersist: FlatCandidate[] = [];

  for (const group of collectFlatCandidateGroups(messages)) {
    const mustReapply: FlatCandidate[] = [];
    const frozen: FlatCandidate[] = [];
    const fresh: FlatCandidate[] = [];
    for (const candidate of group) {
      if (state.replacements.has(candidate.toolUseId)) {
        mustReapply.push(candidate);
      } else if (state.seenIds.has(candidate.toolUseId)) {
        frozen.push(candidate);
      } else {
        fresh.push(candidate);
      }
    }

    for (const candidate of mustReapply) {
      const cached = state.replacements.get(candidate.toolUseId);
      if (cached !== undefined && cached !== candidate.content) {
        replacementByIndex.set(candidate.index, cached);
      }
    }

    if (fresh.length === 0) continue;

    const frozenSize = frozen.reduce((sum, c) => sum + c.size, 0);
    const freshSize = fresh.reduce((sum, c) => sum + c.size, 0);
    const selected =
      frozenSize + freshSize > opts.limitChars
        ? selectFreshToReplace(
            fresh,
            frozenSize,
            opts.limitChars,
            minReplaceChars,
          )
        : [];

    // Non-selected fresh ids freeze NOW so their fate is stable even if
    // a later group persists (mirrors the block-shaped implementation's
    // atomicity note).
    const selectedIds = new Set(selected.map((c) => c.toolUseId));
    for (const candidate of fresh) {
      if (!selectedIds.has(candidate.toolUseId)) {
        state.seenIds.add(candidate.toolUseId);
      }
    }
    toPersist.push(...selected);
  }

  const newlyReplaced: ContentReplacementRecord[] = [];
  for (const candidate of toPersist) {
    const replacement = await opts.persist(
      candidate.content,
      candidate.toolUseId,
    );
    // Seen either way: on persist failure the full content was (and
    // keeps being) sent, so freezing it is the cache-safe outcome.
    state.seenIds.add(candidate.toolUseId);
    if (replacement === null) continue;
    state.replacements.set(candidate.toolUseId, replacement);
    replacementByIndex.set(candidate.index, replacement);
    newlyReplaced.push({
      kind: "tool-result",
      toolUseId: candidate.toolUseId,
      replacement,
    });
  }

  if (replacementByIndex.size === 0) {
    return { messages: [...messages], newlyReplaced };
  }
  const next = messages.map((message, index) => {
    const replacement = replacementByIndex.get(index);
    return replacement === undefined
      ? message
      : withReplacedContent(message, replacement);
  });
  return { messages: next, newlyReplaced };
}

const SHRINK_MARKER_TEMPLATE =
  "\n\n[shrunk to fit the context window: original was {ORIG} chars, keeping the first {HEAD} and last {TAIL}]\n\n";

/**
 * Head+tail slice of an oversized tool-result string. Keeps the opening
 * (usually the most information-dense part) AND the closing (errors,
 * summaries, exit status often live at the end) with an explicit marker
 * between, so the model knows content was cut and can re-fetch.
 */
export function shrinkToolResultContent(
  content: string,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.max(0, maxChars - headChars);
  const marker = SHRINK_MARKER_TEMPLATE.replace(
    "{ORIG}",
    String(content.length),
  )
    .replace("{HEAD}", String(headChars))
    .replace("{TAIL}", String(tailChars));
  return content.slice(0, headChars) + marker + content.slice(
    content.length - tailChars,
  );
}

/**
 * Emergency truncate-to-fit: shrink every tool-result message whose
 * string content exceeds `maxCharsPerResult` to a head+tail slice.
 * Message COUNT and tool_use/tool_result pairing are never touched —
 * only result contents shrink, so the thread stays valid.
 *
 * Returns the same array instance when nothing was over the cap.
 */
export function shrinkOversizedToolResults<M extends ToolResultBudgetMessage>(
  messages: ReadonlyArray<M>,
  maxCharsPerResult: number,
): { messages: M[]; shrunkCount: number } {
  let shrunkCount = 0;
  const next = messages.map((message) => {
    const content = extractToolResultText(message);
    if (content === null || content.length <= maxCharsPerResult) {
      return message;
    }
    shrunkCount += 1;
    return withReplacedContent(
      message,
      shrinkToolResultContent(content, maxCharsPerResult),
    );
  });
  return shrunkCount > 0
    ? { messages: next, shrunkCount }
    : { messages: [...messages], shrunkCount: 0 };
}

/**
 * Resolve the per-message-group character budget: explicit env override
 * first (`AGENC_TOOL_RESULT_BUDGET_CHARS`; `0` disables enforcement),
 * else window-relative — half the context window in characters
 * (~4 chars/token), clamped to the fixed 200K ceiling shared with the
 * block-shaped implementation and a 50K floor so tiny windows still
 * hold a useful result.
 */
export function resolveToolResultBudgetChars(
  contextWindowTokens: number | undefined,
): number {
  const override = process.env.AGENC_TOOL_RESULT_BUDGET_CHARS;
  if (override !== undefined && override !== "") {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  const ceiling = 200_000;
  if (
    contextWindowTokens === undefined ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return ceiling;
  }
  const windowRelative = Math.floor(contextWindowTokens * 4 * 0.5);
  return Math.max(50_000, Math.min(windowRelative, ceiling));
}
