/** Optional prompt projection state. Canonical conversation history stays separate. */
import type { LLMProvider } from "../llm/types.js";
import { getAttachmentTrackingState, type AttachmentTrackingState } from "./attachment-state.js";
import { restoreShownContextImageDigests, shownContextImageDigests } from "./query-image-budget.js";
import type { RolloutItem } from "./rollout-item.js";

const setFields = ["nestedMemoryAttachmentTriggers", "dynamicSkillDirTriggers", "loadedNestedMemoryPaths",
  "surfacedRelevantMemoryPaths", "listedSkillNames", "lastDeferredToolsSet"] as const;
const mapFields = ["lastAgentListingSet", "lastMcpInstructionsMap"] as const;
type SetField = typeof setFields[number];
type MapField = typeof mapFields[number];
export type PersistedAttachmentTrackingState = Omit<AttachmentTrackingState, SetField | MapField> & {
  [K in SetField]?: string[];
} & { [K in MapField]?: [string, string][] };

export interface PromptCacheState {
  readonly version: 1;
  readonly attachments: PersistedAttachmentTrackingState;
  readonly provider: string;
  readonly providerScope?: string;
  readonly functionCallItemIds?: readonly (readonly [string, string])[];
  /**
   * Native DeepSeek Light's compact core catalog had switched to the full core
   * schemas (tool-registry.ts isCoreCatalogExpanded). A resumed, restarted or
   * forked conversation presents the full schemas again, the tool list it last
   * sent, instead of switching a second time. The switch also has its own
   * session_state line (coreCatalogSwitchItem); this field keeps rollouts that
   * an older runtime reads, or wrote, working the same way.
   */
  readonly coreCatalog?: "expanded";
  /**
   * SHA-256 digests of the images a dispatched request carried itself
   * (query-image-budget.ts shownContextImageDigests). A resumed, restarted or
   * forked conversation gives an evicted image the same note as before.
   */
  readonly shownImageDigests?: readonly string[];
}

const IMAGE_DIGEST_RE = /^[0-9a-f]{64}$/u;
function validImageDigests(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string" && IMAGE_DIGEST_RE.test(entry));
}

/** The registry surface that records and restores the core catalog switch. */
export interface CoreCatalogSwitch {
  isCoreCatalogExpanded?(): boolean;
  expandCoreCatalog?(): void;
}

// Sessions and conversations whose rollout already holds their switch:
// written by this process, or restored from the conversation.
const savedCoreCatalogSwitches = new WeakSet<object>();

/**
 * The conversation a session object writes to: its rollout store. Objects
 * derived from a session, such as the admission session of each compaction
 * attempt (services/compact/transaction.ts), share it, so the conversation
 * gets the line once and not once per object.
 */
function conversationKey(sessionKey: object): object {
  const store = (sessionKey as { readonly rolloutStore?: unknown }).rolloutStore;
  return typeof store === "object" && store !== null ? store : sessionKey;
}

/**
 * The switch to the full core schemas as its own small session_state line,
 * once per conversation, at the first event after it happens. The prompt cache
 * state carries it too, but that is written only at turn end and dropped
 * whole when it reaches the recovery line limit, so a process that died in
 * the switching turn, or a large state, lost the switch, and the resumed
 * session sent the compact catalog again (Fcat30-7, Fcat30-8). The line goes
 * out with the next flush of the rollout, together with the tool result that
 * caused the switch.
 */
export function coreCatalogSwitchItem(sessionKey: object, registry?: CoreCatalogSwitch): RolloutItem | undefined {
  const conversation = conversationKey(sessionKey);
  if (savedCoreCatalogSwitches.has(sessionKey)) savedCoreCatalogSwitches.add(conversation);
  if (savedCoreCatalogSwitches.has(conversation) || registry?.isCoreCatalogExpanded?.() !== true) return undefined;
  savedCoreCatalogSwitches.add(sessionKey).add(conversation);
  return { type: "session_state", payload: { coreCatalog: "expanded" } };
}

/**
 * Whether the conversation switched: its own line, or the field of any saved
 * prompt cache state, since the switch happens once and never goes back. A
 * later state saved without it (a turn end whose state was too large) does
 * not undo it.
 */
function savedCoreCatalogSwitch(items: readonly RolloutItem[]): boolean {
  return items.some(item => item?.type === "session_state" &&
    (item.payload.coreCatalog === "expanded" || item.payload.promptCache?.coreCatalog === "expanded"));
}

export function capturePromptCacheState(sessionKey: object, provider: LLMProvider, registry?: CoreCatalogSwitch): PromptCacheState {
  const state = getAttachmentTrackingState(sessionKey);
  const shownImageDigests = shownContextImageDigests(sessionKey);
  const attachments: PersistedAttachmentTrackingState = {
    ...state,
    nestedMemoryAttachmentTriggers: [...state.nestedMemoryAttachmentTriggers],
    dynamicSkillDirTriggers: [...state.dynamicSkillDirTriggers],
    loadedNestedMemoryPaths: [...state.loadedNestedMemoryPaths],
    surfacedRelevantMemoryPaths: [...state.surfacedRelevantMemoryPaths],
    listedSkillNames: [...state.listedSkillNames],
    lastDeferredToolsSet: state.lastDeferredToolsSet && [...state.lastDeferredToolsSet],
    lastAgentListingSet: state.lastAgentListingSet && [...state.lastAgentListingSet],
    lastMcpInstructionsMap: state.lastMcpInstructionsMap && [...state.lastMcpInstructionsMap],
  };
  return { version: 1, attachments, provider: provider.name,
    providerScope: provider.functionCallItemIdsScope,
    functionCallItemIds: provider.exportFunctionCallItemIds?.(),
    ...(registry?.isCoreCatalogExpanded?.() === true ? { coreCatalog: "expanded" as const } : {}),
    ...(shownImageDigests !== undefined ? { shownImageDigests } : {}) };
}

/** Validate optional cache metadata before restoring its mutable containers. */
function validAttachments(value: unknown): value is PersistedAttachmentTrackingState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  for (const key of setFields) {
    const entries = state[key];
    if (entries === undefined && key === "lastDeferredToolsSet") continue;
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) return false;
  }
  for (const key of mapFields) {
    const entries = state[key];
    if (entries !== undefined && (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry) ||
      entry.length !== 2 || entry.some(part => typeof part !== "string")))) return false;
  }
  for (const key of ["needsPlanModeExitAttachment", "needsAutoModeExitAttachment", "hasExitedPlanModeInSession",
    "hasExitedAutoModeInSession", "sessionStartMemoryRecallChecked"]) {
    if (typeof state[key] !== "boolean") return false;
  }
  for (const key of ["swarmRoutingDecisionCount", "surfacedRelevantMemoryBytes"]) {
    if (typeof state[key] !== "number" || !Number.isFinite(state[key]) || state[key] < 0) return false;
  }
  for (const key of ["lastSwarmRoutingTurnId", "lastEmittedDate", "lastDeferredToolsHash", "lastAgentListingHash",
    "lastMcpInstructionsHash", "lastMcpResourceMentionTurnId", "pendingCriticalReminder", "lastSkillListingRootTurnId",
    "instructionHeadScope"]) {
    if (state[key] !== undefined && typeof state[key] !== "string") return false;
  }
  for (const key of ["instructionHead", "instructionAnnounced", "pendingInstructionUpdate"]) {
    const head = state[key];
    if (head !== undefined && (!head || typeof head !== "object" || Array.isArray(head) ||
      Object.entries(head).some(([name, text]) => !["workspaceText", "memoryText"].includes(name) || typeof text !== "string"))) return false;
  }
  if (!["enabled", "disabled", "polluted"].includes(String(state.memoryMode))) return false;
  if (!Array.isArray(state.memoryCitations)) return false;
  const ledger = state.retainedAttachments as AttachmentTrackingState["retainedAttachments"] | undefined;
  return Array.isArray(ledger?.blocks) && ledger.blocks.every(block => block &&
    typeof block.anchorKey === "string" && Number.isSafeInteger(block.anchorIndexHint) && block.anchorIndexHint >= 0 &&
    ["before", "after"].includes(block.placement) && Array.isArray(block.messages) && block.messages.every(message =>
      message?.role === "user" && message.runtimeOnly?.mergeBoundary === "user_context" &&
      (typeof message.content === "string" || Array.isArray(message.content))));
}

export function restorePromptCacheState(
  sessionKey: object,
  provider: LLMProvider,
  items: readonly RolloutItem[],
  registry?: CoreCatalogSwitch,
): void {
  if (savedCoreCatalogSwitch(items)) {
    registry?.expandCoreCatalog?.();
    savedCoreCatalogSwitches.add(sessionKey).add(conversationKey(sessionKey));
  }
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.type !== "session_state" || !Object.hasOwn(item.payload, "promptCache")) continue;
    const cache = item.payload.promptCache;
    if (cache?.version === 1 && validImageDigests(cache.shownImageDigests)) {
      restoreShownContextImageDigests(sessionKey, cache.shownImageDigests);
    }
    if (cache?.version !== 1 || !validAttachments(cache.attachments)) return;
    const state = getAttachmentTrackingState(sessionKey);
    // Fresh copies are essential: a fork/resume must not mutate its source.
    const saved = structuredClone(cache.attachments);
    Object.assign(state, saved);
    for (const key of setFields) {
      const entries = saved[key];
      if (key === "lastDeferredToolsSet") state[key] = entries === undefined ? undefined : new Set(entries);
      else state[key] = new Set(entries);
    }
    for (const key of mapFields) {
      const entries = saved[key];
      state[key] = entries === undefined ? undefined : new Map(entries);
    }
    if (cache.provider === provider.name && cache.providerScope === provider.functionCallItemIdsScope) {
      provider.restoreFunctionCallItemIds?.(cache.functionCallItemIds);
    }
    return;
  }
}


export function isPromptCacheState(value: unknown): value is PromptCacheState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cache = value as Record<string, unknown>;
  return cache.version === 1 && typeof cache.provider === "string" &&
    (cache.providerScope === undefined || typeof cache.providerScope === "string") &&
    (cache.functionCallItemIds === undefined || (Array.isArray(cache.functionCallItemIds) &&
      cache.functionCallItemIds.every(entry => Array.isArray(entry) && entry.length === 2 &&
        entry.every(part => typeof part === "string")))) &&
    (cache.coreCatalog === undefined || cache.coreCatalog === "expanded") &&
    (cache.shownImageDigests === undefined || validImageDigests(cache.shownImageDigests)) && validAttachments(cache.attachments);
}
