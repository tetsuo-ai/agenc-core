/**
 * Agent card — shows identity, beliefs, memory, last action.
 * Phase 4 of CONCORDIA_TODO.MD.
 */

import { useState } from "react";
import type { AgentState } from "./useSimulation";

interface AgentCardProps {
  agentId: string;
  agent: AgentState;
}

export function AgentCard({ agentId, agent }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const beliefs = agent.identity?.beliefs ?? {};
  const beliefCount = Object.keys(beliefs).length;
  const topBelief = Object.entries(beliefs).sort(
    ([, a], [, b]) => b.confidence - a.confidence,
  )[0];

  return (
    <div className="border border-green-800 bg-black p-2 mb-2 font-mono text-sm">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1 pr-2">
          <span className="text-green-300 font-bold">
            {agent.identity?.name ?? agentId}
          </span>
          {agent.lastAction && (
            <span className="mt-1 block break-words whitespace-pre-wrap text-green-600 text-xs">
              "{agent.lastAction}"
            </span>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-green-600 hover:text-green-400 text-xs"
        >
          [{expanded ? "-" : "+"}]
        </button>
      </div>

      <div className="flex gap-3 mt-1 text-xs text-green-600">
        <span>Beliefs: {beliefCount}</span>
        <span>Memory: {agent.memoryCount}</span>
        <span>Turn: {agent.turnCount}</span>
        <span>Relations: {agent.relationships.length}</span>
      </div>

      {topBelief && (
        <div className="mt-1 break-words whitespace-pre-wrap text-xs text-green-500">
          Top belief: {topBelief[0]} — {topBelief[1].belief} (
          {(topBelief[1].confidence * 100).toFixed(0)}%)
        </div>
      )}

      {expanded && (
        <div className="mt-2 border-t border-green-900 pt-2 text-xs">
          {agent.identity && (
            <div className="mb-2">
              <div className="text-green-400 font-bold">Personality:</div>
              <div className="break-words whitespace-pre-wrap text-green-600">
                {agent.identity.personality.slice(0, 300)}
              </div>
            </div>
          )}

          {agent.identity?.learnedTraits && agent.identity.learnedTraits.length > 0 && (
            <div className="mb-2">
              <div className="text-green-400 font-bold">Learned Traits:</div>
              {agent.identity.learnedTraits.map((t, i) => (
                <div
                  key={i}
                  className="break-words whitespace-pre-wrap text-green-600"
                >
                  - {t}
                </div>
              ))}
            </div>
          )}

          {beliefCount > 0 && (
            <div className="mb-2">
              <div className="text-green-400 font-bold">Beliefs:</div>
              {Object.entries(beliefs).map(([topic, b]) => (
                <div
                  key={topic}
                  className="break-words whitespace-pre-wrap text-green-600"
                >
                  - {topic}: {b.belief} ({(b.confidence * 100).toFixed(0)}%)
                </div>
              ))}
            </div>
          )}

          {agent.relationships.length > 0 && (
            <div className="mb-2">
              <div className="text-green-400 font-bold">Relationships:</div>
              {agent.relationships.map((r) => (
                <div
                  key={r.otherAgentId}
                  className="break-words whitespace-pre-wrap text-green-600"
                >
                  - {r.otherAgentId}: {r.interactionCount} interactions,
                  sentiment {r.sentiment.toFixed(2)}
                </div>
              ))}
            </div>
          )}

          {agent.recentMemories.length > 0 && (
            <div>
              <div className="text-green-400 font-bold">Recent Memories:</div>
              {agent.recentMemories.slice(0, 5).map((m, i) => (
                <div
                  key={i}
                  className="break-words whitespace-pre-wrap text-green-600"
                >
                  [{m.role}] {m.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
