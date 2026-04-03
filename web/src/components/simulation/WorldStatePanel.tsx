/**
 * World state panel — facts, relationships, graph summary.
 * Phase 4 of CONCORDIA_TODO.MD.
 */

import type { AgentState } from "./useSimulation";

interface WorldStatePanelProps {
  agentStates: Record<string, AgentState>;
  worldId: string;
}

export function WorldStatePanel({ agentStates, worldId }: WorldStatePanelProps) {
  const agents = Object.entries(agentStates);
  if (agents.length === 0) return null;

  // Aggregate world facts from any agent (they see the same world facts)
  const firstAgent = agents[0]?.[1];
  const worldFacts = firstAgent?.worldFacts ?? [];

  // Aggregate relationships across all agents
  const allRelationships: Array<{
    from: string;
    to: string;
    sentiment: number;
    interactions: number;
  }> = [];
  for (const [agentId, state] of agents) {
    for (const rel of state.relationships) {
      allRelationships.push({
        from: agentId,
        to: rel.otherAgentId,
        sentiment: rel.sentiment,
        interactions: rel.interactionCount,
      });
    }
  }

  // Total memory count
  const totalMemories = agents.reduce((sum, [, s]) => sum + s.memoryCount, 0);

  return (
    <div className="shrink-0 border-t border-green-800 bg-black p-2 font-mono text-xs text-green-500">
      <div className="flex gap-4 flex-wrap">
        <span>
          World: <span className="text-green-300">{worldId}</span>
        </span>
        <span>
          Facts: <span className="text-green-300">{worldFacts.length}</span>
        </span>
        <span>
          Relationships:{" "}
          <span className="text-green-300">{allRelationships.length}</span>
        </span>
        <span>
          Total Memories:{" "}
          <span className="text-green-300">{totalMemories}</span>
        </span>
      </div>

      {worldFacts.length > 0 && (
        <div className="mt-1">
          {worldFacts.slice(0, 5).map((f, i) => (
            <div key={i} className="text-green-600 whitespace-pre-wrap break-words">
              [{f.observedBy}] {f.content}
              {f.confirmations > 0 && (
                <span className="text-green-800">
                  {" "}
                  ({f.confirmations} confirmations)
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {allRelationships.length > 0 && (
        <div className="mt-1 flex gap-2 flex-wrap">
          {allRelationships.map((r, i) => (
            <span key={i} className="text-green-700">
              {r.from}{"<->"}
              {r.to}({r.interactions})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
