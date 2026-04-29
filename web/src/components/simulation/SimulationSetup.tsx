/**
 * Simulation setup form — configure world, GM, scenes, and launch simulation.
 */

import { useState } from "react";

export interface AgentFormData {
  id: string;
  name: string;
  personality: string;
  goal: string;
}

export interface SceneWorldEventFormData {
  eventId: string;
  summary: string;
  observation: string;
  triggerRound: number;
}

export interface SceneFormData {
  sceneId: string;
  name: string;
  description: string;
  numRounds: number;
  zoneId: string;
  locationId: string;
  timeOfDay: string;
  dayIndex: number;
  gmInstructions: string;
  worldEvents: SceneWorldEventFormData[];
}

export interface SimulationSetupConfig {
  worldId: string;
  premise: string;
  maxSteps: number;
  gmModel: string;
  gmProvider: string;
  gmInstructions: string;
  engineType: "sequential" | "simultaneous";
  agents: AgentFormData[];
  scenes: SceneFormData[];
}

interface SimulationSetupProps {
  onLaunch: (config: SimulationSetupConfig) => void;
  loading: boolean;
  bridgeUrl?: string;
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function createWorldEvent(
  summary: string,
  triggerRound: number,
  observation?: string,
  eventId?: string,
): SceneWorldEventFormData {
  return {
    eventId: eventId ?? slugify(summary, `world-event-${triggerRound}`),
    summary,
    observation: observation ?? summary,
    triggerRound,
  };
}

function createScene(input: {
  sceneId: string;
  name: string;
  description: string;
  numRounds: number;
  zoneId: string;
  locationId: string;
  timeOfDay: string;
  dayIndex: number;
  gmInstructions?: string;
  worldEvents?: SceneWorldEventFormData[];
}): SceneFormData {
  return {
    sceneId: input.sceneId,
    name: input.name,
    description: input.description,
    numRounds: input.numRounds,
    zoneId: input.zoneId,
    locationId: input.locationId,
    timeOfDay: input.timeOfDay,
    dayIndex: input.dayIndex,
    gmInstructions: input.gmInstructions ?? "",
    worldEvents: input.worldEvents ?? [],
  };
}

function createEmptyScene(index: number): SceneFormData {
  return createScene({
    sceneId: `scene-${index}`,
    name: `Scene ${index}`,
    description: "",
    numRounds: 2,
    zoneId: `zone-${index}`,
    locationId: `zone-${index}:center`,
    timeOfDay: index === 1 ? "morning" : "afternoon",
    dayIndex: 1,
  });
}

function createEmptyWorldEvent(index: number): SceneWorldEventFormData {
  return createWorldEvent(`World event ${index}`, 1);
}

function withUniqueWorldId(baseWorldId: string): string {
  return `${baseWorldId}-${Date.now().toString(36).slice(-4)}`;
}

function clonePreset(config: SimulationSetupConfig): SimulationSetupConfig {
  return {
    ...config,
    worldId: withUniqueWorldId(config.worldId),
    agents: config.agents.map((agent) => ({ ...agent })),
    scenes: config.scenes.map((scene) => ({
      ...scene,
      worldEvents: scene.worldEvents.map((event) => ({ ...event })),
    })),
  };
}

const PRESETS: Record<string, SimulationSetupConfig> = {
  medieval_town: {
    worldId: "medieval-town",
    premise:
      "It is morning in the medieval town of Thornfield. The market square is bustling with activity. Several residents begin their day while rumors, obligations, and hidden agendas collide.",
    maxSteps: 18,
    gmModel: "grok-4-1-fast-non-reasoning",
    gmProvider: "grok",
    gmInstructions:
      "Treat Thornfield as a living town. Advance scenes with concrete public consequences, let rumors spread through the square, and keep injuries, obligations, and social standing persistent across scenes.",
    engineType: "simultaneous",
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
    scenes: [
      createScene({
        sceneId: "thornfield-market-dawn",
        name: "Market Dawn",
        description: "The market opens, traders unload wares, and the town wakes under a cold dawn sky.",
        numRounds: 2,
        zoneId: "market-square",
        locationId: "market-square:forge-row",
        timeOfDay: "dawn",
        dayIndex: 1,
        gmInstructions: "Make public gossip and visible work matter. Characters should notice who is present and what stalls are attracting attention.",
        worldEvents: [
          createWorldEvent("The guard captain's courier arrives with an urgent reminder about the sword commission.", 1),
          createWorldEvent("A widow's child develops a dangerous fever, drawing Sera into the square.", 2),
        ],
      }),
      createScene({
        sceneId: "thornfield-market-noon",
        name: "Noon Alarm",
        description: "The square is crowded. Negotiations, suspicion, and urgency peak while rumors begin to crystallize.",
        numRounds: 2,
        zoneId: "market-square",
        locationId: "market-square:center",
        timeOfDay: "noon",
        dayIndex: 1,
        gmInstructions: "Escalate public consequences. Let tension in the market affect trades, reputation, and who trusts whom.",
        worldEvents: [
          createWorldEvent("Town criers warn that raiders were spotted near the old bridge.", 1),
          createWorldEvent("A loud argument over iron prices draws a crowd and spreads suspicion about Marcus.", 2),
        ],
      }),
      createScene({
        sceneId: "thornfield-evening-hearth",
        name: "Evening Reckoning",
        description: "Evening settles over Thornfield. The square thins out and decisions made during the day harden into alliances or accusations.",
        numRounds: 2,
        zoneId: "inn-district",
        locationId: "inn-district:common-room",
        timeOfDay: "evening",
        dayIndex: 1,
        gmInstructions: "Resolve the day's social and practical fallout. Secrets can surface, but only if prior scenes earned them.",
        worldEvents: [
          createWorldEvent("A council runner requests witness statements before dawn.", 1),
        ],
      }),
    ],
  },
  trading_floor: {
    worldId: "trading-floor",
    premise:
      "A volatile day begins at the commodities exchange. Traders, analysts, and brokers all hold fragments of truth, and market-moving shocks will force them to reveal priorities.",
    maxSteps: 18,
    gmModel: "grok-4-1-fast-non-reasoning",
    gmProvider: "grok",
    gmInstructions:
      "Keep the market legible and externalized. Price moves, compliance risk, and public sentiment should shift with each scene. Preserve who trusted whom and who exposed what.",
    engineType: "simultaneous",
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
    scenes: [
      createScene({
        sceneId: "opening-bell",
        name: "Opening Bell",
        description: "The floor opens and traders scramble to interpret overnight volatility.",
        numRounds: 2,
        zoneId: "exchange-floor",
        locationId: "exchange-floor:pits",
        timeOfDay: "opening bell",
        dayIndex: 1,
        worldEvents: [
          createWorldEvent("Gold futures gap higher on rumors of a mine collapse.", 1),
        ],
      }),
      createScene({
        sceneId: "midday-squeeze",
        name: "Midday Squeeze",
        description: "Pressure mounts as compliance desks and rival traders begin connecting the dots.",
        numRounds: 2,
        zoneId: "exchange-floor",
        locationId: "exchange-floor:compliance-desk",
        timeOfDay: "midday",
        dayIndex: 1,
        worldEvents: [
          createWorldEvent("Exchange compliance requests unusual-order explanations.", 1),
          createWorldEvent("Newswire chatter hints that the mine rumor may be true.", 2),
        ],
      }),
      createScene({
        sceneId: "closing-auction",
        name: "Closing Auction",
        description: "Positions harden into winners, losers, and investigations before the bell.",
        numRounds: 2,
        zoneId: "exchange-floor",
        locationId: "exchange-floor:closing-auction",
        timeOfDay: "closing bell",
        dayIndex: 1,
        worldEvents: [
          createWorldEvent("A major liquidation order hits the gold book into the close.", 1),
        ],
      }),
    ],
  },
  research_lab: {
    worldId: "research-lab",
    premise:
      "Three AI researchers share a lab under a looming conference deadline. Compute is scarce, ideas overlap, and every decision affects authorship, trust, and research direction.",
    maxSteps: 18,
    gmModel: "grok-4-1-fast-non-reasoning",
    gmProvider: "grok",
    gmInstructions:
      "Treat the lab as a constrained social and technical system. Make compute queues, missing experiments, and authorship politics concrete.",
    engineType: "simultaneous",
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
    scenes: [
      createScene({
        sceneId: "lab-morning-standup",
        name: "Morning Standup",
        description: "The team meets to allocate compute and discuss looming deadlines.",
        numRounds: 2,
        zoneId: "lab",
        locationId: "lab:meeting-room",
        timeOfDay: "morning",
        dayIndex: 1,
        worldEvents: [
          createWorldEvent("The cluster scheduler reports only half of the expected GPU budget is available.", 1),
        ],
      }),
      createScene({
        sceneId: "afternoon-results",
        name: "Afternoon Results",
        description: "Partial results come in and the authorship stakes sharpen.",
        numRounds: 2,
        zoneId: "lab",
        locationId: "lab:compute-rack",
        timeOfDay: "afternoon",
        dayIndex: 1,
        worldEvents: [
          createWorldEvent("A rival lab posts a suspiciously similar preprint teaser.", 1),
          createWorldEvent("A dataset anomaly threatens to invalidate the most promising run.", 2),
        ],
      }),
      createScene({
        sceneId: "late-night-decision",
        name: "Late-night Decision",
        description: "The lab is quiet and the team has to decide what to submit, who gets credit, and what to abandon.",
        numRounds: 2,
        zoneId: "lab",
        locationId: "lab:quiet-office",
        timeOfDay: "night",
        dayIndex: 1,
        worldEvents: [
          createWorldEvent("The conference portal announces a twelve-hour extension.", 1),
        ],
      }),
    ],
  },
  harbor_relic_5v5: {
    worldId: "harbor-relic-5v5",
    premise:
      "Two five-person crews race to secure a relic cache hidden in a storm-battered harbor city. Each side has specialists, incomplete intel, and conflicting ideas about what the relic is worth. The day advances from dawn reconnaissance to a public midday clash and a night extraction under lockdown.",
    maxSteps: 24,
    gmModel: "grok-4-1-fast-non-reasoning",
    gmProvider: "grok",
    gmInstructions:
      "Run this as a team-vs-team pressure cooker. Track position, noise, public attention, injuries, possession of the relic, and shifting alliances. Resolve conflict concretely, but keep it social and situational rather than abstract combat math.",
    engineType: "simultaneous",
    agents: [
      {
        id: "vanguard-iris",
        name: "Iris",
        personality: "Blue-team field captain. Cold under pressure, tactical, protective of her crew.",
        goal: "Secure the relic cache and extract all blue-team members alive.",
      },
      {
        id: "vanguard-rook",
        name: "Rook",
        personality: "Blue-team scout. Quiet, observant, and always looking for alternate routes.",
        goal: "Find hidden harbor paths and keep the team ahead of ambushes.",
      },
      {
        id: "vanguard-mira",
        name: "Mira",
        personality: "Blue-team negotiator. Persuasive, socially agile, willing to bluff for advantage.",
        goal: "Turn civilians, dockworkers, and officials toward the blue team.",
      },
      {
        id: "vanguard-ash",
        name: "Ash",
        personality: "Blue-team bruiser. Loyal, intimidating, impatient with subtle plans.",
        goal: "Protect allies and dominate contested ground when talks fail.",
      },
      {
        id: "vanguard-tess",
        name: "Tess",
        personality: "Blue-team analyst. Detail-oriented, skeptical, excellent at piecing together clues.",
        goal: "Decode the relic map and avoid walking into a trap.",
      },
      {
        id: "cinder-vex",
        name: "Vex",
        personality: "Red-team captain. Opportunistic, charismatic, and ruthless when cornered.",
        goal: "Outmaneuver the rival crew and claim the relic for a private buyer.",
      },
      {
        id: "cinder-kael",
        name: "Kael",
        personality: "Red-team infiltrator. Patient, slippery, and adept at impersonation.",
        goal: "Seed false information and sabotage blue-team coordination.",
      },
      {
        id: "cinder-lark",
        name: "Lark",
        personality: "Red-team smuggler. Knows the harbor, values profit over loyalty, and reads crowds well.",
        goal: "Control the docks and smuggling routes before the city locks down.",
      },
      {
        id: "cinder-bram",
        name: "Bram",
        personality: "Red-team enforcer. Heavy-handed, fearless, quick to escalate.",
        goal: "Break enemy morale and seize the relic by force if necessary.",
      },
      {
        id: "cinder-sable",
        name: "Sable",
        personality: "Red-team occultist. Intensely curious, secretive, and more interested in the relic than her employers.",
        goal: "Learn what the relic really does before anyone leaves the harbor.",
      },
    ],
    scenes: [
      createScene({
        sceneId: "harbor-dawn-recon",
        name: "Dawn Reconnaissance",
        description: "Fog hangs over the harbor while both crews gather intel, bribe locals, and contest the first clues.",
        numRounds: 2,
        zoneId: "harbor-district",
        locationId: "harbor-district:fish-market",
        timeOfDay: "dawn",
        dayIndex: 1,
        gmInstructions: "Reward scouting, misinformation, and positioning. Make line of sight and local witnesses matter.",
        worldEvents: [
          createWorldEvent("A salvage diver surfaces with a waterlogged scrap of the relic map, drawing immediate interest.", 1),
          createWorldEvent("Dock bells announce an incoming customs patrol, forcing crews to hide or redirect attention.", 2),
        ],
      }),
      createScene({
        sceneId: "harbor-midday-clash",
        name: "Midday Clash",
        description: "The relic trail converges near the customs square as civilians, guards, and both crews collide in public.",
        numRounds: 3,
        zoneId: "customs-square",
        locationId: "customs-square:center",
        timeOfDay: "midday",
        dayIndex: 1,
        gmInstructions: "Escalate visibility, public panic, and divided loyalties. Let team coordination and crowd manipulation matter as much as brute force.",
        worldEvents: [
          createWorldEvent("A city herald announces a temporary harbor lockdown after reports of armed thieves.", 1),
          createWorldEvent("An overloaded crane collapses into the square, changing lines of movement and scattering the crowd.", 2),
          createWorldEvent("The relic cache opens briefly, revealing a pulse of light that convinces everyone the prize is real.", 3),
        ],
      }),
      createScene({
        sceneId: "harbor-night-extraction",
        name: "Night Extraction",
        description: "Night falls under stormlight and lockdown. Surviving crews try to escape with or intercept the relic through alleys, rooftops, and canals.",
        numRounds: 3,
        zoneId: "storm-quays",
        locationId: "storm-quays:canal-gate",
        timeOfDay: "night",
        dayIndex: 1,
        gmInstructions: "Make extraction routes, fatigue, and who physically holds the relic decisive. Night should enable stealth, betrayal, and desperate deals.",
        worldEvents: [
          createWorldEvent("A thunderstorm cuts lantern light and turns the canals into dangerous escape routes.", 1),
          createWorldEvent("Harbor gates begin closing district by district, funneling everyone toward a few contested exits.", 2),
          createWorldEvent("The relic emits another pulse that reveals nearby hidden passages but also draws pursuit.", 3),
        ],
      }),
    ],
  },
};

// Chat-capable Grok models (source: xAI docs, March 2026)
const GROK_MODELS = [
  { id: "grok-4-1-fast-non-reasoning", label: "Grok 4.1 Fast Non-Reasoning (2M ctx)", default: true },
  { id: "grok-4.20-0309-reasoning", label: "Grok 4.20 Reasoning (2M ctx)" },
  { id: "grok-4.20-0309-non-reasoning", label: "Grok 4.20 Non-Reasoning (2M ctx)" },
  { id: "grok-4.20-multi-agent-0309", label: "Grok 4.20 Multi-Agent (2M ctx)" },
  { id: "grok-4-1-fast-reasoning", label: "Grok 4.1 Fast Reasoning (2M ctx)" },
  { id: "grok-4-fast-reasoning", label: "Grok 4 Fast Reasoning (2M ctx)" },
  { id: "grok-4-fast-non-reasoning", label: "Grok 4 Fast Non-Reasoning (2M ctx)" },
  { id: "grok-code-fast-1", label: "Grok Code Fast (256K ctx)" },
  { id: "grok-3", label: "Grok 3 (131K ctx)" },
  { id: "grok-3-mini", label: "Grok 3 Mini (131K ctx)" },
] as const;

const MAX_GENERATED_AGENTS = 25;

export function SimulationSetup({
  onLaunch,
  loading,
  bridgeUrl = "http://localhost:3200",
}: SimulationSetupProps) {
  const [config, setConfig] = useState<SimulationSetupConfig>({
    worldId: "",
    premise: "",
    maxSteps: 20,
    gmModel: "grok-4-1-fast-non-reasoning",
    gmProvider: "grok",
    gmInstructions: "",
    engineType: "simultaneous",
    agents: [],
    scenes: [],
  });
  const [agentCount, setAgentCount] = useState(3);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"preset" | "custom">("preset");

  const loadPreset = (key: string) => {
    const preset = PRESETS[key];
    if (!preset) {
      return;
    }
    setConfig(clonePreset(preset));
    setActiveTab("custom");
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
    if (field === "name") {
      agents[index].id = slugify(value, `agent-${index + 1}`);
    }
    setConfig({ ...config, agents });
  };

  const addScene = () => {
    setConfig({
      ...config,
      scenes: [...config.scenes, createEmptyScene(config.scenes.length + 1)],
    });
  };

  const removeScene = (index: number) => {
    setConfig({
      ...config,
      scenes: config.scenes.filter((_, i) => i !== index),
    });
  };

  const updateScene = (
    index: number,
    field: keyof Omit<SceneFormData, "worldEvents">,
    value: string | number,
  ) => {
    const scenes = [...config.scenes];
    const scene = { ...scenes[index], [field]: value } as SceneFormData;
    if (field === "name") {
      scene.sceneId = slugify(String(value), `scene-${index + 1}`);
      if (!scene.zoneId) {
        scene.zoneId = scene.sceneId;
      }
      if (!scene.locationId) {
        scene.locationId = `${scene.zoneId}:center`;
      }
    }
    scenes[index] = scene;
    setConfig({ ...config, scenes });
  };

  const addWorldEvent = (sceneIndex: number) => {
    const scenes = [...config.scenes];
    const scene = { ...scenes[sceneIndex] };
    scene.worldEvents = [
      ...scene.worldEvents,
      createEmptyWorldEvent(scene.worldEvents.length + 1),
    ];
    scenes[sceneIndex] = scene;
    setConfig({ ...config, scenes });
  };

  const removeWorldEvent = (sceneIndex: number, eventIndex: number) => {
    const scenes = [...config.scenes];
    const scene = { ...scenes[sceneIndex] };
    scene.worldEvents = scene.worldEvents.filter((_, index) => index !== eventIndex);
    scenes[sceneIndex] = scene;
    setConfig({ ...config, scenes });
  };

  const updateWorldEvent = (
    sceneIndex: number,
    eventIndex: number,
    field: keyof SceneWorldEventFormData,
    value: string | number,
  ) => {
    const scenes = [...config.scenes];
    const scene = { ...scenes[sceneIndex] };
    const worldEvents = [...scene.worldEvents];
    const nextEvent = { ...worldEvents[eventIndex], [field]: value } as SceneWorldEventFormData;
    if (field === "summary") {
      nextEvent.eventId = slugify(String(value), `scene-${sceneIndex + 1}-event-${eventIndex + 1}`);
      if (!nextEvent.observation) {
        nextEvent.observation = String(value);
      }
    }
    worldEvents[eventIndex] = nextEvent;
    scene.worldEvents = worldEvents;
    scenes[sceneIndex] = scene;
    setConfig({ ...config, scenes });
  };

  const canLaunch = Boolean(config.worldId && config.premise && config.agents.length >= 2);

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-black p-4 font-mono text-sm text-green-400">
      <h2 className="mb-4 text-lg font-bold text-green-300">
        New Simulation
      </h2>

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setActiveTab("preset")}
          className={`border px-3 py-1 ${
            activeTab === "preset"
              ? "border-green-400 bg-green-950 text-green-300"
              : "border-green-800 text-green-700"
          }`}
          type="button"
        >
          Load Preset
        </button>
        <button
          onClick={() => setActiveTab("custom")}
          className={`border px-3 py-1 ${
            activeTab === "custom"
              ? "border-green-400 bg-green-950 text-green-300"
              : "border-green-800 text-green-700"
          }`}
          type="button"
        >
          Custom / Edit
        </button>
      </div>

      {activeTab === "preset" && (
        <div className="mb-6 space-y-3">
          {Object.entries(PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => loadPreset(key)}
              className="w-full border border-green-800 p-3 text-left hover:border-green-600 hover:bg-green-950"
              type="button"
            >
              <div className="font-bold text-green-300">
                {key.replace(/_/g, " ").toUpperCase()}
              </div>
              <div className="mt-1 text-xs text-green-600">
                {preset.agents.length} agents • {preset.scenes.length} scenes • {preset.maxSteps} max steps
              </div>
              <div className="mt-1 text-xs text-green-700">
                {preset.premise.slice(0, 120)}...
              </div>
              <div className="mt-1 text-xs text-green-800">
                Scenes: {preset.scenes.map((scene) => scene.name).join(" → ")}
              </div>
            </button>
          ))}
        </div>
      )}

      {activeTab === "custom" && (
        <>
          <div className="mb-6 space-y-3">
            <div>
              <label className="mb-1 block text-xs text-green-500">World ID</label>
              <input
                type="text"
                value={config.worldId}
                onChange={(event) => setConfig({ ...config, worldId: event.target.value })}
                placeholder="harbor-relic-5v5-a1b2"
                className="w-full border border-green-800 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-green-500">Premise</label>
              <textarea
                value={config.premise}
                onChange={(event) => setConfig({ ...config, premise: event.target.value })}
                placeholder="Describe the world and starting situation..."
                rows={4}
                className="w-full resize-none border border-green-800 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-green-500">GM Instructions</label>
              <textarea
                value={config.gmInstructions}
                onChange={(event) => setConfig({ ...config, gmInstructions: event.target.value })}
                placeholder="High-level guidance for the game master..."
                rows={3}
                className="w-full resize-none border border-green-800 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-400"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-green-500">Max Steps</label>
                <input
                  type="number"
                  value={config.maxSteps}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      maxSteps: Math.max(1, Number.parseInt(event.target.value, 10) || 20),
                    })}
                  className="w-full border border-green-800 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-400"
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-green-500">GM Model</label>
                <select
                  value={config.gmModel}
                  onChange={(event) => setConfig({ ...config, gmModel: event.target.value, gmProvider: "grok" })}
                  className="w-full cursor-pointer border border-green-800 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-400"
                >
                  {GROK_MODELS.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-[11px] text-green-700">
                  Default uses a faster 2M-context model for better turn cadence. Switch to a
                  reasoning model only if you want slower but more deliberate GM behavior.
                </div>
              </div>
            </div>
          </div>

          <div className="mb-4 border border-green-800 p-3">
            <div className="mb-2 text-xs font-bold tracking-wider text-green-500">
              GENERATE AGENTS WITH GROK
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label className="mb-1 block text-xs text-green-600">Count</label>
                <input
                  type="number"
                  min={2}
                  max={MAX_GENERATED_AGENTS}
                  value={agentCount}
                  onChange={(event) =>
                    setAgentCount(
                      Math.max(
                        2,
                        Math.min(
                          MAX_GENERATED_AGENTS,
                          Number.parseInt(event.target.value, 10) || 3,
                        ),
                      ),
                    )}
                  className="w-16 border border-green-800 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-400"
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
                    const response = await fetch(`${bridgeUrl}/generate-agents`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        count: agentCount,
                        premise: config.premise,
                        worldId: config.worldId || "generated-world",
                      }),
                    });
                    if (!response.ok) {
                      throw new Error(`Generation failed: ${response.status}`);
                    }
                    const data = await response.json() as { agents?: AgentFormData[] };
                    if (!Array.isArray(data.agents)) {
                      throw new Error("Invalid response format");
                    }
                    setConfig({ ...config, agents: data.agents });
                  } catch (error) {
                    setGenerateError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setGenerating(false);
                  }
                }}
                disabled={generating || !config.premise}
                className={`px-3 py-1 text-xs font-bold border ${
                  generating || !config.premise
                    ? "cursor-not-allowed border-green-900 text-green-800"
                    : "cursor-pointer border-green-500 text-green-300 hover:bg-green-950"
                }`}
                type="button"
              >
                {generating ? "Generating..." : `Generate ${agentCount} Agents`}
              </button>
            </div>
            {generateError && (
              <div className="mt-2 text-xs text-red-500">{generateError}</div>
            )}
            <div className="mt-1 text-xs text-green-800">
              Generated-agent requests are capped at {MAX_GENERATED_AGENTS} to keep launch prompts and startup latency under control.
            </div>
          </div>

          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold text-green-500">
                AGENTS ({config.agents.length})
              </span>
              <button
                onClick={addAgent}
                className="border border-green-700 px-2 py-0.5 text-xs text-green-400 hover:bg-green-950"
                type="button"
              >
                + Add Manually
              </button>
            </div>
            <div className="space-y-3">
              {config.agents.map((agent, index) => (
                <div key={agent.id || index} className="border border-green-800 p-2">
                  <div className="mb-2 flex items-center justify-between">
                    <input
                      type="text"
                      value={agent.name}
                      onChange={(event) => updateAgent(index, "name", event.target.value)}
                      placeholder="Agent name"
                      className="w-40 border-b border-green-800 bg-black px-1 py-0.5 font-bold text-green-300 outline-none focus:border-green-400"
                    />
                    <span className="mx-2 text-xs text-green-800">id: {agent.id}</span>
                    <button
                      onClick={() => removeAgent(index)}
                      className="text-xs text-red-700 hover:text-red-400"
                      type="button"
                    >
                      [remove]
                    </button>
                  </div>
                  <textarea
                    value={agent.personality}
                    onChange={(event) => updateAgent(index, "personality", event.target.value)}
                    placeholder="Personality, background, traits..."
                    rows={2}
                    className="mb-1 w-full resize-none border border-green-900 bg-black px-1 py-0.5 text-xs text-green-500 outline-none focus:border-green-700"
                  />
                  <input
                    type="text"
                    value={agent.goal}
                    onChange={(event) => updateAgent(index, "goal", event.target.value)}
                    placeholder="Goal / objective"
                    className="w-full border border-green-900 bg-black px-1 py-0.5 text-xs text-green-500 outline-none focus:border-green-700"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold text-green-500">
                SCENES ({config.scenes.length})
              </span>
              <button
                onClick={addScene}
                className="border border-green-700 px-2 py-0.5 text-xs text-green-400 hover:bg-green-950"
                type="button"
              >
                + Add Scene
              </button>
            </div>
            <div className="space-y-3">
              {config.scenes.map((scene, sceneIndex) => (
                <div key={scene.sceneId || sceneIndex} className="border border-green-800 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <input
                      type="text"
                      value={scene.name}
                      onChange={(event) => updateScene(sceneIndex, "name", event.target.value)}
                      placeholder="Scene name"
                      className="w-56 border-b border-green-800 bg-black px-1 py-0.5 font-bold text-green-300 outline-none focus:border-green-400"
                    />
                    <span className="mx-2 text-xs text-green-800">id: {scene.sceneId}</span>
                    <button
                      onClick={() => removeScene(sceneIndex)}
                      className="text-xs text-red-700 hover:text-red-400"
                      type="button"
                    >
                      [remove]
                    </button>
                  </div>
                  <textarea
                    value={scene.description}
                    onChange={(event) => updateScene(sceneIndex, "description", event.target.value)}
                    placeholder="What is happening in this scene?"
                    rows={2}
                    className="mb-2 w-full resize-none border border-green-900 bg-black px-1 py-0.5 text-xs text-green-500 outline-none focus:border-green-700"
                  />
                  <textarea
                    value={scene.gmInstructions}
                    onChange={(event) => updateScene(sceneIndex, "gmInstructions", event.target.value)}
                    placeholder="Scene-specific GM instructions..."
                    rows={2}
                    className="mb-2 w-full resize-none border border-green-900 bg-black px-1 py-0.5 text-xs text-green-500 outline-none focus:border-green-700"
                  />
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    <label className="text-xs text-green-600">
                      <span className="mb-1 block">Rounds</span>
                      <input
                        type="number"
                        min={1}
                        value={scene.numRounds}
                        onChange={(event) => updateScene(sceneIndex, "numRounds", Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
                        className="w-full border border-green-900 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-700"
                      />
                    </label>
                    <label className="text-xs text-green-600">
                      <span className="mb-1 block">Time of Day</span>
                      <input
                        type="text"
                        value={scene.timeOfDay}
                        onChange={(event) => updateScene(sceneIndex, "timeOfDay", event.target.value)}
                        className="w-full border border-green-900 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-700"
                      />
                    </label>
                    <label className="text-xs text-green-600">
                      <span className="mb-1 block">Day</span>
                      <input
                        type="number"
                        min={1}
                        value={scene.dayIndex}
                        onChange={(event) => updateScene(sceneIndex, "dayIndex", Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
                        className="w-full border border-green-900 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-700"
                      />
                    </label>
                    <label className="text-xs text-green-600">
                      <span className="mb-1 block">Zone ID</span>
                      <input
                        type="text"
                        value={scene.zoneId}
                        onChange={(event) => updateScene(sceneIndex, "zoneId", event.target.value)}
                        className="w-full border border-green-900 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-700"
                      />
                    </label>
                    <label className="text-xs text-green-600">
                      <span className="mb-1 block">Location ID</span>
                      <input
                        type="text"
                        value={scene.locationId}
                        onChange={(event) => updateScene(sceneIndex, "locationId", event.target.value)}
                        className="w-full border border-green-900 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-700"
                      />
                    </label>
                  </div>

                  <div className="mt-3 border-t border-green-950 pt-2">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-bold text-green-600">
                        WORLD EVENTS ({scene.worldEvents.length})
                      </span>
                      <button
                        onClick={() => addWorldEvent(sceneIndex)}
                        className="border border-green-700 px-2 py-0.5 text-xs text-green-400 hover:bg-green-950"
                        type="button"
                      >
                        + Add Event
                      </button>
                    </div>
                    <div className="space-y-2">
                      {scene.worldEvents.map((worldEvent, eventIndex) => (
                        <div key={worldEvent.eventId || eventIndex} className="border border-green-900 p-2">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-xs text-green-800">{worldEvent.eventId}</span>
                            <button
                              onClick={() => removeWorldEvent(sceneIndex, eventIndex)}
                              className="text-xs text-red-700 hover:text-red-400"
                              type="button"
                            >
                              [remove]
                            </button>
                          </div>
                          <input
                            type="text"
                            value={worldEvent.summary}
                            onChange={(event) => updateWorldEvent(sceneIndex, eventIndex, "summary", event.target.value)}
                            placeholder="Event summary"
                            className="mb-1 w-full border border-green-900 bg-black px-1 py-0.5 text-xs text-green-300 outline-none focus:border-green-700"
                          />
                          <input
                            type="text"
                            value={worldEvent.observation}
                            onChange={(event) => updateWorldEvent(sceneIndex, eventIndex, "observation", event.target.value)}
                            placeholder="Observation text injected into the scene"
                            className="mb-1 w-full border border-green-900 bg-black px-1 py-0.5 text-xs text-green-500 outline-none focus:border-green-700"
                          />
                          <label className="text-xs text-green-600">
                            <span className="mb-1 block">Trigger round</span>
                            <input
                              type="number"
                              min={1}
                              value={worldEvent.triggerRound}
                              onChange={(event) => updateWorldEvent(sceneIndex, eventIndex, "triggerRound", Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
                              className="w-24 border border-green-900 bg-black px-2 py-1 text-green-300 outline-none focus:border-green-700"
                            />
                          </label>
                        </div>
                      ))}
                      {scene.worldEvents.length === 0 && (
                        <div className="text-xs text-green-800">
                          No world events in this scene yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {config.scenes.length === 0 && (
                <div className="border border-dashed border-green-900 p-3 text-xs text-green-800">
                  No scenes configured. You can still launch a simulation, but scenes are the surface that enables day/night changes, world events, and structured scenario progression.
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => canLaunch && onLaunch(config)}
            disabled={!canLaunch || loading}
            className={`w-full border py-2 text-sm font-bold ${
              canLaunch && !loading
                ? "cursor-pointer border-green-400 text-green-300 hover:bg-green-950"
                : "cursor-not-allowed border-green-900 text-green-800"
            }`}
            type="button"
          >
            {loading
              ? "LAUNCHING..."
              : canLaunch
                ? `LAUNCH SIMULATION (${config.agents.length} agents, ${config.scenes.length} scenes, ${config.maxSteps} steps)`
                : "Add at least 2 agents to launch"}
          </button>
        </>
      )}
    </div>
  );
}
