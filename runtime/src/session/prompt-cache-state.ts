/** Optional prompt projection state. Canonical conversation history stays separate. */
import type { LLMProvider } from "../llm/types.js";
import { getAttachmentTrackingState, type AttachmentTrackingState } from "./attachment-state.js";
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
}

export function capturePromptCacheState(sessionKey: object, provider: LLMProvider): PromptCacheState {
  const state = getAttachmentTrackingState(sessionKey);
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
    functionCallItemIds: provider.exportFunctionCallItemIds?.() };
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

export function restorePromptCacheState(sessionKey: object, provider: LLMProvider, items: readonly RolloutItem[]): void {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.type !== "session_state" || !Object.hasOwn(item.payload, "promptCache")) continue;
    const cache = item.payload.promptCache;
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
        entry.every(part => typeof part === "string")))) && validAttachments(cache.attachments);
}
