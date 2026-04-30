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
export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() };
}

/**
 * Clone state for a cache-sharing fork. Mutating the clone does not
 * affect the source. Mirrors agenc `cloneContentReplacementState`.
 */
export function cloneContentReplacementState(
  source: ContentReplacementState,
): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  };
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
export function reconstructContentReplacementState(
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
