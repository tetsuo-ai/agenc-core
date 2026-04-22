import type { QuerySource } from "../../constants/querySource.js";
import type { Message } from "../../types/message.js";
import {
  applyCollapsesIfNeeded as applyCollapsesFromIndex,
  getContextCollapseState,
  getContextVisualizationData,
  getStats,
  isContextCollapseEnabled,
  maybeCollapseContext,
  recoverFromOverflow,
  resetContextCollapse,
  stageContextCollapseForSession,
  subscribe,
} from "./index.js";

export {
  getContextCollapseState,
  getStats,
  isContextCollapseEnabled,
  recoverFromOverflow,
  resetContextCollapse,
  stageContextCollapseForSession,
  subscribe,
};

export function projectView(
  messages: ReadonlyArray<Message>,
  ctx?: { readonly session?: { readonly conversationId?: string } | null },
): ReadonlyArray<Message> {
  return maybeCollapseContext(messages, ctx);
}

export async function applyCollapsesIfNeeded(
  messages: ReadonlyArray<Message>,
  ctx?: unknown,
  querySource?: QuerySource,
): Promise<{ readonly messages: ReadonlyArray<Message>; readonly committed: number }> {
  return applyCollapsesFromIndex(messages, ctx, querySource);
}

export async function getContextCollapseOperations() {
  const visualization = getContextVisualizationData();
  return [
    {
      type: "inspect",
      stats: getStats(),
      visualization,
    },
    {
      type: "reset",
      description: "Clear all in-memory context-collapse state",
    },
  ];
}

export async function executeContextCollapseOperation(
  operation?: { type?: string },
) {
  if (operation?.type === "reset") {
    resetContextCollapse();
    return { ok: true, type: "reset" };
  }

  return {
    ok: true,
    type: "inspect",
    stats: getStats(),
    visualization: getContextVisualizationData(),
  };
}
