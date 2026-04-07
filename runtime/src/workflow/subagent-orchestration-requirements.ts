/**
 * Required subagent orchestration parsing — collapsed stub (Cut 1.1).
 *
 * Replaces the previous 382-LOC heuristic that parsed user message
 * text for explicit "use N sub-agents" directives. The planner
 * subsystem that consumed this output has been deleted; the runtime
 * never extracts orchestration requirements anymore.
 *
 * @module
 */

export interface RequiredSubagentOrchestrationStep {
  readonly name: string;
  readonly description: string;
}

export interface RequiredSubagentOrchestrationRequirements {
  readonly mode: "exact_steps" | "minimum_steps";
  readonly steps: readonly RequiredSubagentOrchestrationStep[];
  readonly stepNames: readonly string[];
  readonly requiredStepCount: number;
  readonly roleHints: readonly string[];
  readonly requiresSynthesis: boolean;
}

export interface RequiredSubagentVerificationCandidate {
  readonly name: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly executionContext?: {
    readonly stepKind?: unknown;
    readonly effectClass?: unknown;
    readonly verificationMode?: unknown;
    readonly targetArtifacts?: readonly string[];
  };
}

export function extractRequiredSubagentOrchestrationRequirements(
  _messageText: string,
): RequiredSubagentOrchestrationRequirements | undefined {
  return undefined;
}

export function allowsUserMandatedSubagentCardinalityOverride(
  _requirements: RequiredSubagentOrchestrationRequirements | undefined,
): boolean {
  return false;
}

export function orchestrationRoleHintRegex(_roleHint: string): RegExp | undefined {
  return undefined;
}

export function resolveRequiredSubagentVerificationStepNames(_params: {
  readonly requirements?: RequiredSubagentOrchestrationRequirements;
  readonly candidates?: readonly RequiredSubagentVerificationCandidate[];
}): readonly string[] {
  return [];
}
