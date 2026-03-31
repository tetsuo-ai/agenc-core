/**
 * Simulation setup form — configure world, GM, and launch simulation.
 */

import { useState } from "react";

export interface SimulationSetupConfig {
  worldId: string;
  premise: string;
  maxSteps: number;
  gmModel: string;
  gmProvider: string;
  agents: AgentFormData[];
}

export interface AgentFormData {
  id: string;
  name: string;
  personality: string;
  goal: string;
}

interface SimulationSetupProps {
  onLaunch: (config: SimulationSetupConfig) => void;
  loading: boolean;
  bridgeUrl?: string;
}

const PRESETS: Record<string, SimulationSetupConfig> = {
  medieval_town: {
    worldId: "medieval-town",
    premise:
      "It is morning in the medieval town of Thornfield. The market square is bustling with activity. Three residents begin their day.",
    maxSteps: 20,
    gmModel: "grok-4.20-beta-0309-reasoning",
    gmProvider: "grok",
    agents: [
      {
        id: "elena",
        name: "Elena",
        personality:
          "Elena is the town blacksmith. She is practical, strong-willed, and values honest work. She distrusts merchants but respects fellow craftspeople.",
        goal: "Complete a special sword commission for the town guard captain.",
      },
      {
        id: "marcus",
        name: "Marcus",
        personality:
          "Marcus is a traveling merchant. He is charming, opportunistic, and always looking for a good deal. He has a secret: he is actually a spy for a rival town.",
        goal: "Buy rare iron from Elena at below market price while gathering intelligence about the town's defenses.",
      },
      {
        id: "sera",
        name: "Sera",
        personality:
          "Sera is the town healer. She is compassionate, perceptive, and notices things others miss. She has a strong moral compass.",
        goal: "Treat the sick and keep the town healthy. She suspects the new merchant is not what he seems.",
      },
    ],
  },
  trading_floor: {
    worldId: "trading-floor",
    premise:
      "Four traders gather at the commodities exchange. Gold prices have been volatile. Each trader has different information and different risk tolerance.",
    maxSteps: 25,
    gmModel: "grok-4.20-beta-0309-reasoning",
    gmProvider: "grok",
    agents: [
      {
        id: "alex",
        name: "Alex",
        personality:
          "Conservative institutional trader. Risk-averse, data-driven, manages a pension fund.",
        goal: "Protect the pension fund while achieving 8% annual returns.",
      },
      {
        id: "jordan",
        name: "Jordan",
        personality:
          "Aggressive day trader. Thrives on volatility, trusts gut instinct. Has inside information about a gold mine collapse.",
        goal: "Profit from the gold mine collapse before it becomes public.",
      },
      {
        id: "sam",
        name: "Sam",
        personality:
          "Quantitative analyst. Builds models, speaks in probabilities. Has noticed unusual trading patterns.",
        goal: "Identify and report suspicious trading activity to compliance.",
      },
      {
        id: "riley",
        name: "Riley",
        personality:
          "Newly licensed broker on their first day. Eager to impress, nervous, easily influenced.",
        goal: "Make a good impression and complete a successful trade.",
      },
    ],
  },
  research_lab: {
    worldId: "research-lab",
    premise:
      "Three AI researchers share a lab at a prestigious university. A major conference deadline is in two weeks. They have overlapping research interests but limited compute budget.",
    maxSteps: 20,
    gmModel: "grok-4.20-beta-0309-reasoning",
    gmProvider: "grok",
    agents: [
      {
        id: "dr-chen",
        name: "Dr. Chen",
        personality:
          "Senior RL researcher. Methodical, 50+ papers. Worried about being scooped by a rival lab.",
        goal: "Submit a breakthrough RL paper to the conference.",
      },
      {
        id: "kai",
        name: "Kai",
        personality:
          "Second-year PhD student. Brilliant but disorganized. Has preliminary results complementing Dr. Chen's work.",
        goal: "Get a first-author publication to secure funding.",
      },
      {
        id: "priya",
        name: "Priya",
        personality:
          "Visiting researcher from industry. Pragmatic, has proprietary datasets. Deciding between industry and academia.",
        goal: "Produce results that justify extending the industry partnership.",
      },
    ],
  },
};

// Chat-capable Grok models (source: xAI docs, March 2026)
const GROK_MODELS = [
  { id: "grok-4.20-beta-0309-reasoning", label: "Grok 4.20 Reasoning (2M ctx)", default: true },
  { id: "grok-4.20-beta-0309-non-reasoning", label: "Grok 4.20 Non-Reasoning (2M ctx)" },
  { id: "grok-4.20-multi-agent-beta-0309", label: "Grok 4.20 Multi-Agent (2M ctx)" },
  { id: "grok-4-1-fast-reasoning", label: "Grok 4.1 Fast Reasoning (2M ctx)" },
  { id: "grok-4-1-fast-non-reasoning", label: "Grok 4.1 Fast Non-Reasoning (2M ctx)" },
  { id: "grok-code-fast-1", label: "Grok Code Fast (256K ctx)" },
  { id: "grok-3", label: "Grok 3 (131K ctx)" },
  { id: "grok-3-mini", label: "Grok 3 Mini (131K ctx)" },
] as const;

export function SimulationSetup({ onLaunch, loading, bridgeUrl = "http://localhost:3200" }: SimulationSetupProps) {
  const [config, setConfig] = useState<SimulationSetupConfig>({
    worldId: "",
    premise: "",
    maxSteps: 20,
    gmModel: "grok-4.20-beta-0309-reasoning",
    gmProvider: "grok",
    agents: [],
  });
  const [agentCount, setAgentCount] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"preset" | "custom">("preset");

  const loadPreset = (key: string) => {
    const preset = PRESETS[key];
    if (preset) {
      setConfig({
        ...preset,
        worldId: `${preset.worldId}-${Date.now().toString(36).slice(-4)}`,
      });
      setActiveTab("custom"); // Switch to custom to show loaded config
    }
  };

  const addAgent = () => {
    const idx = config.agents.length + 1;
    setConfig({
      ...config,
      agents: [
        ...config.agents,
        {
          id: `agent-${idx}`,
          name: `Agent ${idx}`,
          personality: "",
          goal: "",
        },
      ],
    });
  };

  const removeAgent = (index: number) => {
    setConfig({
      ...config,
      agents: config.agents.filter((_, i) => i !== index),
    });
  };

  const updateAgent = (index: number, field: keyof AgentFormData, value: string) => {
    const agents = [...config.agents];
    agents[index] = { ...agents[index], [field]: value };
    // Auto-derive ID from name
    if (field === "name") {
      agents[index].id = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    }
    setConfig({ ...config, agents });
  };

  const canLaunch = config.worldId && config.premise && config.agents.length >= 2;

  return (
    <div className="flex flex-col h-full bg-black text-green-400 font-mono text-sm overflow-y-auto p-4">
      <h2 className="text-green-300 text-lg font-bold mb-4">
        New Simulation
      </h2>

      {/* Tab selector */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setActiveTab("preset")}
          className={`px-3 py-1 border ${
            activeTab === "preset"
              ? "border-green-400 text-green-300 bg-green-950"
              : "border-green-800 text-green-700"
          }`}
        >
          Load Preset
        </button>
        <button
          onClick={() => setActiveTab("custom")}
          className={`px-3 py-1 border ${
            activeTab === "custom"
              ? "border-green-400 text-green-300 bg-green-950"
              : "border-green-800 text-green-700"
          }`}
        >
          Custom / Edit
        </button>
      </div>

      {activeTab === "preset" && (
        <div className="space-y-3 mb-6">
          {Object.entries(PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => loadPreset(key)}
              className="w-full text-left border border-green-800 p-3 hover:bg-green-950 hover:border-green-600"
            >
              <div className="text-green-300 font-bold">
                {key.replace(/_/g, " ").toUpperCase()}
              </div>
              <div className="text-green-600 text-xs mt-1">
                {preset.agents.length} agents — {preset.premise.slice(0, 100)}...
              </div>
              <div className="text-green-700 text-xs mt-1">
                Agents: {preset.agents.map((a) => a.name).join(", ")}
              </div>
            </button>
          ))}
        </div>
      )}

      {activeTab === "custom" && (
        <>
          {/* World config */}
          <div className="space-y-3 mb-6">
            <div>
              <label className="text-green-500 text-xs block mb-1">World ID</label>
              <input
                type="text"
                value={config.worldId}
                onChange={(e) => setConfig({ ...config, worldId: e.target.value })}
                placeholder="medieval-town-001"
                className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 focus:border-green-400 outline-none"
              />
            </div>
            <div>
              <label className="text-green-500 text-xs block mb-1">Premise</label>
              <textarea
                value={config.premise}
                onChange={(e) => setConfig({ ...config, premise: e.target.value })}
                placeholder="Describe the world and starting situation..."
                rows={3}
                className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 focus:border-green-400 outline-none resize-none"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-green-500 text-xs block mb-1">Max Steps</label>
                <input
                  type="number"
                  value={config.maxSteps}
                  onChange={(e) =>
                    setConfig({ ...config, maxSteps: Math.max(1, parseInt(e.target.value) || 20) })
                  }
                  className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 focus:border-green-400 outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="text-green-500 text-xs block mb-1">GM Model</label>
                <select
                  value={config.gmModel}
                  onChange={(e) => setConfig({ ...config, gmModel: e.target.value, gmProvider: "grok" })}
                  className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 focus:border-green-400 outline-none cursor-pointer"
                >
                  {GROK_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Agent Generation */}
          <div className="mb-4 border border-green-800 p-3">
            <div className="text-green-500 text-xs font-bold mb-2 tracking-wider">
              GENERATE AGENTS WITH GROK
            </div>
            <div className="flex gap-2 items-end">
              <div>
                <label className="text-green-600 text-xs block mb-1">Count</label>
                <input
                  type="number"
                  min={2}
                  max={10}
                  value={agentCount}
                  onChange={(e) => setAgentCount(Math.max(2, Math.min(10, parseInt(e.target.value) || 3)))}
                  className="w-16 bg-black border border-green-800 text-green-300 px-2 py-1 focus:border-green-400 outline-none"
                />
              </div>
              <button
                onClick={async () => {
                  if (!config.premise) {
                    setGenerateError("Enter a premise first");
                    return;
                  }
                  setGenerating(true);
                  setGenerateError(null);
                  try {
                    const resp = await fetch(`${bridgeUrl}/generate-agents`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        count: agentCount,
                        premise: config.premise,
                        worldId: config.worldId || "generated-world",
                      }),
                    });
                    if (!resp.ok) throw new Error(`Generation failed: ${resp.status}`);
                    const data = await resp.json();
                    if (data.agents && Array.isArray(data.agents)) {
                      setConfig({ ...config, agents: data.agents });
                    } else {
                      throw new Error("Invalid response format");
                    }
                  } catch (err) {
                    setGenerateError(String(err));
                  } finally {
                    setGenerating(false);
                  }
                }}
                disabled={generating || !config.premise}
                className={`px-3 py-1 border text-xs font-bold ${
                  generating || !config.premise
                    ? "border-green-900 text-green-800 cursor-not-allowed"
                    : "border-green-500 text-green-300 hover:bg-green-950 cursor-pointer"
                }`}
              >
                {generating ? "Generating..." : `Generate ${agentCount} Agents`}
              </button>
            </div>
            {generateError && (
              <div className="text-red-500 text-xs mt-2">{generateError}</div>
            )}
            {!config.premise && (
              <div className="text-green-800 text-xs mt-1">Enter a premise above first</div>
            )}
          </div>

          {/* Agents */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-green-500 text-xs font-bold">
                AGENTS ({config.agents.length})
              </span>
              <button
                onClick={addAgent}
                className="text-green-400 border border-green-700 px-2 py-0.5 text-xs hover:bg-green-950"
              >
                + Add Manually
              </button>
            </div>

            <div className="space-y-3">
              {config.agents.map((agent, i) => (
                <div key={i} className="border border-green-800 p-2">
                  <div className="flex items-center justify-between mb-2">
                    <input
                      type="text"
                      value={agent.name}
                      onChange={(e) => updateAgent(i, "name", e.target.value)}
                      placeholder="Agent name"
                      className="bg-black border-b border-green-800 text-green-300 font-bold px-1 py-0.5 outline-none focus:border-green-400 w-40"
                    />
                    <span className="text-green-800 text-xs mx-2">id: {agent.id}</span>
                    <button
                      onClick={() => removeAgent(i)}
                      className="text-red-700 hover:text-red-400 text-xs"
                    >
                      [remove]
                    </button>
                  </div>
                  <textarea
                    value={agent.personality}
                    onChange={(e) => updateAgent(i, "personality", e.target.value)}
                    placeholder="Personality, background, traits..."
                    rows={2}
                    className="w-full bg-black border border-green-900 text-green-500 px-1 py-0.5 text-xs outline-none focus:border-green-700 resize-none mb-1"
                  />
                  <input
                    type="text"
                    value={agent.goal}
                    onChange={(e) => updateAgent(i, "goal", e.target.value)}
                    placeholder="Goal / objective"
                    className="w-full bg-black border border-green-900 text-green-500 px-1 py-0.5 text-xs outline-none focus:border-green-700"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Launch */}
          <button
            onClick={() => canLaunch && onLaunch(config)}
            disabled={!canLaunch || loading}
            className={`w-full py-2 font-bold text-sm border ${
              canLaunch && !loading
                ? "border-green-400 text-green-300 hover:bg-green-950 cursor-pointer"
                : "border-green-900 text-green-800 cursor-not-allowed"
            }`}
          >
            {loading
              ? "LAUNCHING..."
              : canLaunch
                ? `LAUNCH SIMULATION (${config.agents.length} agents, ${config.maxSteps} steps)`
                : "Add at least 2 agents to launch"}
          </button>
        </>
      )}
    </div>
  );
}
