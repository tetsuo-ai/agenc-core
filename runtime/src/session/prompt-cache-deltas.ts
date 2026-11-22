/**
 * Prompt cache state as it happens, between the turn-end snapshots.
 *
 * The prompt cache state (prompt-cache-state.ts: the retained attachment
 * ledger and the provider's issued function_call item ids) reaches the
 * rollout only at turn end. A process that died inside a turn (crash,
 * SIGKILL, OOM, restart) left that turn's history in the rollout but not the
 * reminders the turn placed or the item ids its calls were issued, so the
 * resumed request sent those calls without their ids and without the
 * reminders, and the provider's prompt cache read nothing after the start of
 * the interrupted turn. Two small append-only session_state lines close that
 * gap: the ledger blocks a request placed, written before the request goes
 * out, and the item ids of a response's calls, written before the response's
 * history item. A resume restores the last snapshot, then every delta after
 * it. A block whose anchor has left the history is dropped again by the next
 * projection (attachment-retention.ts), as in the live session.
 *
 * @module
 */

import type { LLMProvider } from "../llm/types.js";
import type { RetainedAttachmentBlock } from "./attachment-retention.js";
import { getAttachmentTrackingState } from "./attachment-state.js";
import type { RolloutItem } from "./rollout-item.js";

export interface PromptCacheDelta {
  readonly version: 1;
  /** Blocks the ledger recorded for one request, in order. */
  readonly retainedAttachments?: readonly RetainedAttachmentBlock[];
  /** Issuing provider of `functionCallItemIds` (its name and id scope). */
  readonly provider?: string;
  readonly providerScope?: string;
  /** [call id, issued item id] for the calls of one response. */
  readonly functionCallItemIds?: readonly (readonly [string, string])[];
}

/** A provider that can name the item ids it issued for some calls. */
export interface FunctionCallItemIdLookup {
  functionCallItemIdsFor?(callIds: readonly string[]): readonly (readonly [string, string])[];
}

/** The provider the prompt cache state belongs to, as the turn-end snapshot uses it. */
export function promptCacheProvider(session: {
  readonly provider?: LLMProvider;
  readonly services?: { readonly providerService?: { current(): { readonly instance: LLMProvider } } };
}): LLMProvider | undefined {
  return session.services?.providerService?.current().instance ?? session.provider;
}

/**
 * The line for the blocks one request placed. A block the rollout schema
 * would refuse (it would make the rollout unreadable) is not written; the
 * turn-end snapshot still carries the ledger as before.
 */
export function retainedAttachmentsDeltaItem(blocks: readonly RetainedAttachmentBlock[]): RolloutItem | undefined {
  const delta: PromptCacheDelta = { version: 1, retainedAttachments: blocks };
  if (blocks.length === 0 || !isPromptCacheDelta(JSON.parse(JSON.stringify(delta)))) return undefined;
  return { type: "session_state", payload: { promptCacheDelta: delta } };
}

export function functionCallItemIdsDeltaItem(
  provider: (LLMProvider & FunctionCallItemIdLookup) | undefined,
  callIds: readonly string[],
): RolloutItem | undefined {
  if (provider === undefined || callIds.length === 0) return undefined;
  const ids = provider.functionCallItemIdsFor?.(callIds) ?? [];
  if (ids.length === 0) return undefined;
  return { type: "session_state", payload: { promptCacheDelta: {
    version: 1,
    provider: provider.name,
    ...(provider.functionCallItemIdsScope !== undefined ? { providerScope: provider.functionCallItemIdsScope } : {}),
    functionCallItemIds: ids.map(([callId, itemId]) => [callId, itemId] as const),
  } } };
}

function validBlock(block: unknown): block is RetainedAttachmentBlock {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  const value = block as Partial<RetainedAttachmentBlock>;
  return typeof value.anchorKey === "string" && Number.isSafeInteger(value.anchorIndexHint) &&
    (value.anchorIndexHint ?? -1) >= 0 && (value.placement === "before" || value.placement === "after") &&
    Array.isArray(value.messages) && value.messages.length > 0 && value.messages.every((message) =>
      message?.role === "user" && message.runtimeOnly?.mergeBoundary === "user_context" &&
      (typeof message.content === "string" || Array.isArray(message.content)));
}

function validIds(value: unknown): value is readonly (readonly [string, string])[] {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2 &&
    entry.every((part) => typeof part === "string"));
}

/** The rollout schema's check (state/recovery-journal-schema.ts), and the reader's. */
export function isPromptCacheDelta(value: unknown): value is PromptCacheDelta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const delta = value as Record<string, unknown>;
  return delta.version === 1 &&
    (delta.retainedAttachments === undefined ||
      (Array.isArray(delta.retainedAttachments) && delta.retainedAttachments.every(validBlock))) &&
    (delta.provider === undefined || typeof delta.provider === "string") &&
    (delta.providerScope === undefined || typeof delta.providerScope === "string") &&
    (delta.functionCallItemIds === undefined || validIds(delta.functionCallItemIds));
}

function readDelta(item: RolloutItem | undefined): PromptCacheDelta | undefined {
  if (item?.type !== "session_state" || !Object.hasOwn(item.payload, "promptCacheDelta")) return undefined;
  const delta = item.payload.promptCacheDelta;
  return isPromptCacheDelta(delta) ? delta : undefined;
}

/**
 * Apply every delta written after the last turn-end snapshot (all of them
 * when the rollout has none) on top of what restorePromptCacheState put back.
 */
export function restorePromptCacheDeltas(
  sessionKey: object,
  provider: LLMProvider,
  items: readonly RolloutItem[],
): void {
  let start = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "session_state" && Object.hasOwn(item.payload, "promptCache")) {
      start = index + 1;
      break;
    }
  }
  const ledger = getAttachmentTrackingState(sessionKey).retainedAttachments;
  for (let index = start; index < items.length; index += 1) {
    const delta = readDelta(items[index]);
    if (delta === undefined) continue;
    const blocks = delta.retainedAttachments;
    if (blocks !== undefined) {
      // Fresh copies: a fork or resume must not share its source's objects.
      ledger.blocks.push(...structuredClone(blocks) as RetainedAttachmentBlock[]);
    }
    if (delta.functionCallItemIds !== undefined && delta.provider === provider.name &&
      delta.providerScope === provider.functionCallItemIdsScope) {
      provider.restoreFunctionCallItemIds?.(delta.functionCallItemIds);
    }
  }
}
