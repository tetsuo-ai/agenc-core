/**
 * Reflection pipeline — synthesizes higher-level insights from experiences.
 *
 * Per R16 (Generative Agents): observation → reflection → planning.
 * Per R17 (Hindsight): 4 memory networks including evolving beliefs.
 * Per skeptic: gate on session length (skip if < 10 messages),
 * batch (reflect every N sessions, not every one).
 *
 * @module
 */

import type { LLMProvider, LLMMessage } from "../llm/types.js";
import { buildModelOnlyChatOptions } from "../llm/model-only-options.js";
import type { AgentIdentityManager, AgentBelief } from "./agent-identity.js";
import type { Logger } from "../utils/logger.js";

const REFLECTION_SYSTEM_PROMPT = `You are reflecting on recent agent experiences. Analyze the conversation history and extract:

1. "learned_traits": New behavioral patterns or preferences observed (1-3 items max)
2. "beliefs": Updated opinions or beliefs formed from evidence (topic → belief + confidence 0-1)
3. "communication_style": Any observed communication preferences

Return JSON with these fields. Each belief MUST include "evidence" (list of specific observations that support it).
If nothing notable, return empty arrays/objects.`;

const MIN_MESSAGES_FOR_REFLECTION = 10;

interface ReflectionResult {
  readonly learnedTraits: readonly string[];
  readonly beliefs: ReadonlyArray<{
    readonly topic: string;
    readonly belief: string;
    readonly confidence: number;
    readonly evidence: readonly string[];
  }>;
  readonly communicationStyle: string;
}

/**
 * Run reflection on an agent's recent experiences.
 * Per skeptic: skips if session has < 10 messages.
 */
export async function runReflection(params: {
  readonly llmProvider: LLMProvider;
  readonly identityManager: AgentIdentityManager;
  readonly agentId: string;
  readonly workspaceId?: string;
  readonly recentHistory: readonly LLMMessage[];
  readonly logger?: Logger;
}): Promise<ReflectionResult | null> {
  const { llmProvider, identityManager, agentId, workspaceId, recentHistory, logger } = params;

  // Per skeptic: gate on session length
  if (recentHistory.length < MIN_MESSAGES_FOR_REFLECTION) {
    logger?.debug?.(`Reflection skipped: only ${recentHistory.length} messages (min: ${MIN_MESSAGES_FOR_REFLECTION})`);
    return null;
  }

  try {
    // Build reflection input from recent history
    const historyText = recentHistory
      .slice(-20) // Last 20 messages
      .map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 300) : ""}`)
      .join("\n");

    const response = await llmProvider.chat([
      { role: "system", content: REFLECTION_SYSTEM_PROMPT },
      { role: "user", content: historyText },
    ], buildModelOnlyChatOptions());

    const content = response.content.trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    let parsed: {
      learned_traits?: string[];
      beliefs?: Record<string, { belief: string; confidence: number; evidence: string[] }>;
      communication_style?: string;
    };
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }

    const learnedTraits = (parsed.learned_traits ?? []).filter(
      (t) => typeof t === "string" && t.trim().length > 0,
    );
    const communicationStyle = typeof parsed.communication_style === "string"
      ? parsed.communication_style.trim()
      : "";

    // Update agent identity with learned traits
    if (learnedTraits.length > 0) {
      await identityManager.addLearnedTraits(agentId, learnedTraits, workspaceId);
    }
    if (communicationStyle) {
      await identityManager.updateCommunicationStyle(agentId, communicationStyle, workspaceId);
    }

    // Update beliefs (per edge case X5: must have evidence)
    const beliefs: Array<ReflectionResult["beliefs"][number]> = [];
    if (parsed.beliefs && typeof parsed.beliefs === "object") {
      for (const [topic, belief] of Object.entries(parsed.beliefs)) {
        if (
          typeof belief?.belief === "string" &&
          typeof belief?.confidence === "number" &&
          Array.isArray(belief?.evidence) &&
          belief.evidence.length > 0
        ) {
          const agentBelief: AgentBelief = {
            belief: belief.belief,
            confidence: Math.min(1, Math.max(0, belief.confidence)),
            evidence: belief.evidence.filter((e: unknown) => typeof e === "string"),
            formedAt: Date.now(),
          };
          await identityManager.upsertBelief(agentId, topic, agentBelief, workspaceId);
          beliefs.push({ topic, ...agentBelief });
        }
      }
    }

    logger?.info?.(
      `Reflection complete for agent ${agentId}: ${learnedTraits.length} traits, ${beliefs.length} beliefs`,
    );

    return { learnedTraits, beliefs, communicationStyle };
  } catch (err) {
    logger?.warn?.("Reflection failed (non-blocking):", err);
    return null;
  }
}
