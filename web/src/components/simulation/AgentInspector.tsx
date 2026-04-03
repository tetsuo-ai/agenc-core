/**
 * Agent inspector — deep-dive into agent memory, beliefs, relationships.
 * Opens as an overlay when clicking on an agent card.
 */

import type { AgentState } from "./useSimulation";

interface AgentInspectorProps {
  agentId: string;
  agent: AgentState;
  onClose: () => void;
}

export function AgentInspector({ agentId, agent, onClose }: AgentInspectorProps) {
  const identity = agent.identity;
  const beliefs = identity?.beliefs ?? {};
  const beliefEntries = Object.entries(beliefs).sort(
    ([, a], [, b]) => b.confidence - a.confidence,
  );

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
      <div className="bg-black border border-green-600 w-full max-w-2xl max-h-[90vh] overflow-y-auto font-mono text-sm">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-green-800 p-3">
          <div>
            <h2 className="text-green-300 font-bold text-lg">
              {identity?.name ?? agentId}
            </h2>
            <span className="text-green-700 text-xs">ID: {agentId}</span>
          </div>
          <button
            onClick={onClose}
            className="text-green-600 hover:text-green-300 border border-green-800 px-2 py-1"
          >
            [X] Close
          </button>
        </div>

        <div className="p-3 space-y-4">
          {/* Stats bar */}
          <div className="flex gap-4 text-xs text-green-500 border-b border-green-900 pb-2">
            <span>Turn: {agent.turnCount}</span>
            <span>Memories: {agent.memoryCount}</span>
            <span>Beliefs: {beliefEntries.length}</span>
            <span>Relationships: {agent.relationships.length}</span>
          </div>

          {/* Personality */}
          {identity && (
            <Section title="PERSONALITY">
              <p className="text-green-500 whitespace-pre-wrap">
                {identity.personality}
              </p>
            </Section>
          )}

          {/* Last Action */}
          {agent.lastAction && (
            <Section title="LAST ACTION">
              <p className="text-yellow-400">"{agent.lastAction}"</p>
            </Section>
          )}

          {/* Learned Traits */}
          {identity?.learnedTraits && identity.learnedTraits.length > 0 && (
            <Section title="LEARNED TRAITS">
              <div className="flex flex-wrap gap-1">
                {identity.learnedTraits.map((trait, i) => (
                  <span
                    key={i}
                    className="border border-green-800 px-2 py-0.5 text-green-400 text-xs"
                  >
                    {trait}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Beliefs */}
          {beliefEntries.length > 0 && (
            <Section title="BELIEFS">
              <div className="space-y-1">
                {beliefEntries.map(([topic, b]) => (
                  <div key={topic} className="flex items-start gap-2">
                    <ConfidenceBar confidence={b.confidence} />
                    <div>
                      <span className="text-green-300 font-bold">{topic}:</span>{" "}
                      <span className="text-green-500">{b.belief}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Relationships */}
          {agent.relationships.length > 0 && (
            <Section title="RELATIONSHIPS">
              <div className="space-y-1">
                {agent.relationships.map((rel) => (
                  <div
                    key={rel.otherAgentId}
                    className="flex items-center gap-3 text-green-500"
                  >
                    <span className="text-green-300 w-24">{rel.otherAgentId}</span>
                    <SentimentBar sentiment={rel.sentiment} />
                    <span className="text-green-700 text-xs">
                      {rel.interactionCount} interactions
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Recent Memories */}
          {agent.recentMemories.length > 0 && (
            <Section title="RECENT MEMORIES">
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {agent.recentMemories.map((mem, i) => (
                  <div key={i} className="text-xs border-l-2 border-green-900 pl-2">
                    <span className="text-green-700">
                      [{mem.role}]{" "}
                      {new Date(mem.timestamp).toLocaleTimeString()}
                    </span>
                    <div className="text-green-500 whitespace-pre-wrap break-words">
                      {mem.content}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* World Facts */}
          {agent.worldFacts.length > 0 && (
            <Section title="KNOWN WORLD FACTS">
              <div className="space-y-1">
                {agent.worldFacts.map((fact, i) => (
                  <div key={i} className="text-xs whitespace-pre-wrap break-words text-green-500">
                    <span className="text-green-700">[{fact.observedBy}]</span>{" "}
                    {fact.content}
                    {fact.confirmations > 0 && (
                      <span className="text-green-800">
                        {" "}
                        ({fact.confirmations} confirmations)
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-green-600 text-xs font-bold mb-1 tracking-wider">
        {title}
      </h3>
      {children}
    </div>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const width = Math.max(4, Math.round(confidence * 40));
  return (
    <div className="flex items-center gap-1 shrink-0 w-16">
      <div className="h-1.5 w-10 bg-green-950 relative">
        <div
          className="h-full bg-green-500 absolute left-0 top-0"
          style={{ width: `${width}px` }}
        />
      </div>
      <span className="text-green-700 text-xs w-8">{pct}%</span>
    </div>
  );
}

function SentimentBar({ sentiment }: { sentiment: number }) {
  // sentiment is -1 to 1
  const normalized = (sentiment + 1) / 2; // 0 to 1
  const color =
    sentiment > 0.3
      ? "bg-green-500"
      : sentiment < -0.3
        ? "bg-red-500"
        : "bg-yellow-500";
  return (
    <div className="flex items-center gap-1 shrink-0">
      <div className="h-1.5 w-10 bg-green-950 relative">
        <div
          className={`h-full ${color} absolute left-0 top-0`}
          style={{ width: `${Math.round(normalized * 40)}px` }}
        />
      </div>
      <span className="text-green-700 text-xs">{sentiment.toFixed(2)}</span>
    </div>
  );
}
