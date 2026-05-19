/**
 * Deferred-tools delta attachment producer.
 *
 * Hand-port of reference `getDeferredToolsDeltaAttachment`
 * (`src/utils/attachments.ts:1456-1476`) and the underlying diff in
 * `getDeferredToolsDelta` (`src/utils/toolSearch.ts:646-706`).
 *
 * Fires when the set of deferred tools loaded into the visible catalog
 * via `system.searchTools` has changed since the last announcement. The
 * first turn seeds tracking state without emitting (announcing the
 * always-empty initial set would be noise).
 *
 * AgenC divergence from AgenC: instead of reconstructing the prior
 * announced set by scanning the message history for prior
 * `deferred_tools_delta` attachments, AgenC stores the prior set
 * directly on `AttachmentTrackingState.lastDeferredToolsSet`. Same
 * semantics, much simpler — and the trigger condition is identical
 * because the orchestrator emits + persists in the same call.
 *
 * @module
 */

import type { LLMTool } from "../../llm/types.js";
import type { AttachmentProducer } from "./orchestrator.js";

/**
 * Compute the current deferred-tools set from the visible catalog. A tool
 * is "deferred" if it has been discovered (loaded via ToolSearch) — that
 * is, it's present in `discoveredToolNames` AND in the visible catalog
 * for this turn. Tools in the static default-visible set are excluded
 * (they were always visible, never deferred).
 */
function computeDeferredToolsSet(
  loadedTools: readonly LLMTool[],
  discoveredToolNames: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const tool of loadedTools) {
    const name = tool.function.name;
    if (discoveredToolNames.has(name)) result.add(name);
  }
  return result;
}

function descriptionFor(
  name: string,
  loadedTools: readonly LLMTool[],
): string {
  for (const tool of loadedTools) {
    if (tool.function.name === name) return tool.function.description ?? "";
  }
  return "";
}

export const deferredToolsDeltaProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  const discovered = opts.discoveredToolNames ?? new Set<string>();
  const currentSet = computeDeferredToolsSet(opts.loadedTools, discovered);
  const prior = trackingState.lastDeferredToolsSet;

  if (prior === undefined) {
    // First turn — seed without emitting. The delta only marks a real
    // change in the catalog; the initial state is communicated through
    // the ToolSearch system-prompt section. Matches AgenC behavior:
    // the first scan finds no prior `deferred_tools_delta` attachments,
    // and announces only what's already deferred — for a fresh session
    // that's the empty set.
    trackingState.lastDeferredToolsSet = currentSet;
    return [];
  }

  const added = [...currentSet]
    .filter((name) => !prior.has(name))
    .sort((a, b) => a.localeCompare(b));
  const removed = [...prior]
    .filter((name) => !currentSet.has(name))
    .sort((a, b) => a.localeCompare(b));

  if (added.length === 0 && removed.length === 0) return [];

  trackingState.lastDeferredToolsSet = currentSet;

  return [
    {
      kind: "deferred_tools_delta",
      addedNames: added,
      addedLines: added.map((name) => {
        const desc = descriptionFor(name, opts.loadedTools);
        return desc.length > 0 ? `${name}: ${desc}` : name;
      }),
      removedNames: removed,
    },
  ];
};
