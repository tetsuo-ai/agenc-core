/**
 * Planner request-analysis — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 977-LOC planner decision pipeline (structured
 * bullet counting, verification cue detection, complexity scoring,
 * planner routing heuristics, imperative tool extraction, artifact
 * target inference). The planner subsystem has been deleted; every
 * planner decision is now a no-op `shouldPlan: false`. The only
 * helper that survives is `safeStepStringArray` — still used by the
 * gateway subagent stack when parsing untrusted LLM output.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type { PlannerDecision } from "./chat-executor-types.js";

export function safeStepStringArray(
  value: unknown,
): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  }
  return [];
}

interface PlannerRequestSignals {
  readonly normalized: string;
  readonly hasMultiStepCue: boolean;
  readonly hasToolDiversityCue: boolean;
  readonly hasDelegationCue: boolean;
  readonly hasImplementationScopeCue: boolean;
  readonly hasVerificationCue: boolean;
  readonly hasDocumentationCue: boolean;
  readonly longTask: boolean;
  readonly structuredBulletCount: number;
  readonly priorToolMessages: number;
  readonly hasPriorNoProgressSignal: boolean;
}

export function collectPlannerRequestSignals(
  messageText: string,
  _history: readonly LLMMessage[],
): PlannerRequestSignals {
  return {
    normalized: messageText.toLowerCase(),
    hasMultiStepCue: false,
    hasToolDiversityCue: false,
    hasDelegationCue: false,
    hasImplementationScopeCue: false,
    hasVerificationCue: false,
    hasDocumentationCue: false,
    longTask: false,
    structuredBulletCount: 0,
    priorToolMessages: 0,
    hasPriorNoProgressSignal: false,
  };
}

export function assessPlannerDecision(
  _plannerEnabled: boolean,
  _messageText: string,
  _history: readonly LLMMessage[],
  _metadata?: unknown,
): PlannerDecision {
  return {
    score: 0,
    shouldPlan: false,
    reason: "planner_disabled",
  };
}

export function isDialogueOnlyDirectTurnMessage(_messageText: string): boolean {
  return false;
}

export function requestRequiresToolGroundedExecution(
  _messageText: string,
): boolean {
  return false;
}

export function requestExplicitlyRequestsDelegation(
  _messageText: string,
): boolean {
  return false;
}

export type { PlannerPlanArtifactIntent } from "./chat-executor-types.js";

export function extractExplicitSubagentOrchestrationRequirements(
  _messageText: string,
): undefined {
  return undefined;
}

export interface ExplicitDeterministicToolRequirements {
  readonly forcePlanner?: boolean;
  readonly toolNames?: readonly string[];
}

export function extractExplicitDeterministicToolRequirements(
  _messageText: string,
  _explicitRequirementToolNames: readonly string[],
  _metadata?: unknown,
): ExplicitDeterministicToolRequirements | undefined {
  return undefined;
}

export function extractPlannerArtifactTargets(
  _messageText: string,
): readonly string[] {
  return [];
}

export function extractPlannerSourceArtifactTargets(
  _messageText: string,
): readonly string[] {
  return [];
}

export function sanitizePlannerStepName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

export function isPipelineStopReasonHint(
  _value: unknown,
): _value is LLMPipelineStopReason {
  return false;
}
