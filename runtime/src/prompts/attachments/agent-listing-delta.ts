/**
 * Agent-listing delta attachment producer.
 *
 * Hand-port of reference `getAgentListingDeltaAttachment`
 * (`src/utils/attachments.ts:1491-1557`). Fires when the set of available
 * agent types has changed since the last announcement, OR on first
 * emission (with `isInitial: true`).
 *
 * Main-thread-only: subagents do not see the agent listing because
 * subagent depth > 0 cannot itself spawn deeper agents in the AgenC
 * model AgenC mirrors here.
 *
 * AgenC divergence from AgenC: the prior-announced set is tracked
 * directly on `AttachmentTrackingState.lastAgentListingSet` (a Map of
 * agent type → rendered description line) instead of being reconstructed
 * by scanning the message history.
 *
 * STATUS — agent definition surface gap:
 *
 * AgenC's runtime exposes `session.agentDefinitions.activeAgents` as
 * `unknown[]` on the reference adapter boundary.
 * No typed `AgentDefinition` shape with `{agentType, whenToUse, tools}`
 * is published for the model-facing listing yet — `AgentControl.listAgents()`
 * returns *running* agent metadata, not the *available agent type catalog*
 * that this attachment announces.
 *
 * Until AgenC ships an authored agent-type catalog wired through the
 * session services, this producer reads `session.agentDefinitions.activeAgents`
 * defensively and only emits when entries have a recognizable shape
 * (`{agentType: string, whenToUse?: string}`). On bootstraps where the
 * surface is empty/typeless, the producer no-ops cleanly.
 *
 * @module
 */

import type { AttachmentProducer } from "./orchestrator.js";
import {
  formatAgentListingDetails,
  formatAgentListingType,
} from "../../tools/AgentTool/agentListingMetadata.js";

interface SessionLikeForAgentListing {
  readonly agentDefinitions?: {
    readonly activeAgents?: readonly unknown[];
  };
}

interface AgentDefinitionLike {
  readonly agentType: string;
  readonly whenToUse?: unknown;
  readonly tools?: unknown;
  readonly source?: unknown;
}

function isAgentDefinitionLike(value: unknown): value is AgentDefinitionLike {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { agentType?: unknown };
  return typeof candidate.agentType === "string" && candidate.agentType.length > 0;
}

function readActiveAgents(sessionKey: object): readonly AgentDefinitionLike[] {
  const session = sessionKey as SessionLikeForAgentListing;
  const raw = session.agentDefinitions?.activeAgents;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAgentDefinitionLike);
}

function formatAgentLine(agent: AgentDefinitionLike): string {
  const tools = Array.isArray(agent.tools)
    ? agent.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const details = formatAgentListingDetails({
    description: typeof agent.whenToUse === "string" ? agent.whenToUse : "",
    source: agent.source,
    ...(tools.length > 0 ? { toolsDescription: tools.join(", ") } : {}),
  });
  const type = formatAgentListingType(agent.agentType);
  return details.length > 0 ? `${type}: ${details}` : `${type}:`;
}

export const agentListingDeltaProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  // Subagents never see the agent listing — they cannot spawn agents.
  if (opts.subagentDepth > 0) return [];

  const agents = readActiveAgents(opts.sessionKey);
  // Build a deterministic Map of agentType → rendered line.
  const currentMap = new Map<string, string>();
  for (const agent of agents) {
    if (!currentMap.has(agent.agentType)) {
      currentMap.set(agent.agentType, formatAgentLine(agent));
    }
  }

  const prior = trackingState.lastAgentListingSet;
  const isInitial = prior === undefined;

  if (isInitial) {
    if (currentMap.size === 0) {
      // Seed an empty map so we still detect "first added" as the next
      // delta (with isInitial: false). Matches AgenC where an empty
      // initial scan still updates the announced set baseline.
      trackingState.lastAgentListingSet = new Map();
      return [];
    }
    const sortedTypes = [...currentMap.keys()].sort((a, b) => a.localeCompare(b));
    trackingState.lastAgentListingSet = currentMap;
    return [
      {
        kind: "agent_listing_delta",
        addedTypes: sortedTypes,
        addedLines: sortedTypes.map((t) => currentMap.get(t) ?? t),
        removedTypes: [],
        isInitial: true,
      },
    ];
  }

  const added: string[] = [];
  for (const type of currentMap.keys()) {
    if (!prior.has(type)) added.push(type);
  }
  const removed: string[] = [];
  for (const type of prior.keys()) {
    if (!currentMap.has(type)) removed.push(type);
  }

  if (added.length === 0 && removed.length === 0) return [];

  added.sort((a, b) => a.localeCompare(b));
  removed.sort((a, b) => a.localeCompare(b));

  trackingState.lastAgentListingSet = currentMap;

  return [
    {
      kind: "agent_listing_delta",
      addedTypes: added,
      addedLines: added.map((t) => currentMap.get(t) ?? t),
      removedTypes: removed,
      isInitial: false,
    },
  ];
};
