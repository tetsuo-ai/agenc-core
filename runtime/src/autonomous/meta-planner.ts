/**
 * Meta-planner — durable strategic goal generation.
 *
 * Reads a structured strategic-memory snapshot instead of raw recent chat
 * slices, then proposes bounded goals that are written into the shared goal
 * store.
 *
 * @module
 */

import type {
  HeartbeatAction,
  HeartbeatContext,
  HeartbeatResult,
} from "../gateway/heartbeat.js";
import type { LLMProvider } from "../llm/types.js";
import { createProviderTraceEventLogger } from "../llm/provider-trace-logger.js";
import type { MemoryBackend } from "../memory/types.js";
import { StrategicMemory } from "./strategic-memory.js";

export interface MetaPlannerConfig {
  readonly llm: LLMProvider;
  readonly memory: MemoryBackend;
  readonly strategicMemory?: StrategicMemory;
  readonly agentMission?: string;
  readonly maxGoals?: number;
  readonly keyPrefix?: string;
  readonly traceProviderPayloads?: boolean;
}

export interface GeneratedGoal {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  rationale: string;
  suggestedActions: string[];
  estimatedComplexity: "simple" | "moderate" | "complex";
  createdAt: number;
  status: "proposed" | "approved" | "in-progress" | "completed" | "rejected";
}

const DEFAULT_MAX_GOALS = 3;
const DEFAULT_KEY_PREFIX = "goal:";

const META_PLANNING_PROMPT = `You are an autonomous AI agent's strategic planning module.

Your mission: {MISSION}

You are given a structured strategic-memory snapshot. Use it instead of raw
chat history. Prefer goals that:
- build on durable recent outcomes
- resolve repeated failures or stale work
- avoid duplicating active or recently completed goals

Rules:
- Goals should be specific, measurable, and actionable
- Include a concise rationale explaining why the goal matters now
- Suggested actions should be short, concrete next moves

Return a JSON array of goals:
[
  {
    "title": "Short goal title",
    "description": "Detailed description of what to achieve",
    "priority": "critical" | "high" | "medium" | "low",
    "rationale": "Why this goal matters now",
    "suggestedActions": ["action1", "action2"],
    "estimatedComplexity": "simple" | "moderate" | "complex"
  }
]

Return ONLY valid JSON. No markdown code blocks.`;

export function createMetaPlannerAction(
  config: MetaPlannerConfig,
): HeartbeatAction {
  const { llm, memory } = config;
  const agentMission =
    config.agentMission ??
    "Coordinate tasks, assist users, and continuously improve capabilities";
  const maxGoals = config.maxGoals ?? DEFAULT_MAX_GOALS;
  const keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const strategicMemory =
    config.strategicMemory ?? StrategicMemory.fromMemoryBackend(memory);

  return {
    name: "meta-planner",
    enabled: true,
    async execute(context: HeartbeatContext): Promise<HeartbeatResult> {
      try {
        const now = Date.now();
        const planningSnapshot = await strategicMemory.buildPlanningSnapshot();
        const prompt = META_PLANNING_PROMPT.replace("{MISSION}", agentMission);
        const response = await llm.chat(
          [
            { role: "system", content: prompt },
            {
              role: "user",
              content:
                `Current state:\n` +
                `- strategic snapshot generated at ${new Date(now).toISOString()}\n\n` +
                `${planningSnapshot.digest || "No durable strategic context recorded yet."}\n\n` +
                `Generate up to ${maxGoals} new strategic goals.`,
            },
          ],
          {
            toolChoice: "none",
            toolRouting: { allowedToolNames: [] },
            parallelToolCalls: false,
            ...(config.traceProviderPayloads === true
              ? {
                  trace: {
                    includeProviderPayloads: true,
                    onProviderTraceEvent: createProviderTraceEventLogger({
                      logger: context.logger,
                      traceLabel: "meta_planner.provider",
                      traceId: `meta-planner:${Date.now()}`,
                      staticFields: {
                        phase: "planning",
                        activeGoalCount: planningSnapshot.activeGoals.length,
                        recentOutcomeCount: planningSnapshot.recentOutcomes.length,
                      },
                    }),
                  },
                }
              : {}),
          },
        );

        if (!response.content) {
          return { hasOutput: false, quiet: true };
        }

        let rawGoals: Array<{
          title: string;
          description: string;
          priority: string;
          rationale: string;
          suggestedActions: string[];
          estimatedComplexity: string;
        }>;
        try {
          rawGoals = JSON.parse(response.content) as typeof rawGoals;
          if (!Array.isArray(rawGoals)) {
            return { hasOutput: false, quiet: true };
          }
        } catch {
          context.logger.warn("MetaPlanner: failed to parse LLM goals");
          return { hasOutput: false, quiet: true };
        }

        const goals: GeneratedGoal[] = rawGoals
          .slice(0, maxGoals)
          .map((raw, index) => ({
            id: `${now}-${index}`,
            title: raw.title ?? "Untitled",
            description: raw.description ?? "",
            priority: (["critical", "high", "medium", "low"].includes(raw.priority)
              ? raw.priority
              : "medium") as GeneratedGoal["priority"],
            rationale: raw.rationale ?? "",
            suggestedActions: raw.suggestedActions ?? [],
            estimatedComplexity: (
              ["simple", "moderate", "complex"].includes(raw.estimatedComplexity)
                ? raw.estimatedComplexity
                : "moderate"
            ) as GeneratedGoal["estimatedComplexity"],
            createdAt: now,
            status: "proposed",
          }));

        if (goals.length === 0) {
          return { hasOutput: false, quiet: true };
        }

        await memory.set(`${keyPrefix}batch:${now}`, goals);

        const acceptedGoals: GeneratedGoal[] = [];
        for (const goal of goals) {
          const mutation = await strategicMemory.addGoal({
            title: goal.title,
            description: goal.description,
            priority: goal.priority,
            source: "meta-planner",
            maxAttempts: 2,
            rationale: goal.rationale,
            suggestedActions: goal.suggestedActions,
            estimatedComplexity: goal.estimatedComplexity,
            status: "pending",
          });
          if (mutation.accepted || mutation.created) {
            acceptedGoals.push(goal);
          }
        }

        if (acceptedGoals.length === 0) {
          return { hasOutput: false, quiet: true };
        }

        await strategicMemory.syncLegacyMirrors();

        await memory.addEntry({
          sessionId: "meta-planner:goals",
          role: "assistant",
          content:
            `[META-PLANNER] Generated ${acceptedGoals.length} goal(s):\n` +
            acceptedGoals
              .map(
                (goal) =>
                  `- [${goal.priority}] ${goal.title}: ${goal.description}\n  Rationale: ${goal.rationale}`,
              )
              .join("\n"),
          metadata: {
            type: "meta-planner",
            goalCount: acceptedGoals.length,
            timestamp: now,
          },
        });

        const summary = acceptedGoals
          .map((goal) => `[${goal.priority}] ${goal.title}`)
          .join(", ");
        return {
          hasOutput: true,
          output: `MetaPlanner: generated ${acceptedGoals.length} goal(s): ${summary}`,
          quiet: false,
        };
      } catch (err) {
        context.logger.error("MetaPlanner action failed:", err);
        return { hasOutput: false, quiet: true };
      }
    },
  };
}
