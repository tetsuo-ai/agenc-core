import { DEFAULT_TASK_TOKEN_BUDGET } from "../config/task-budget.js";
import type { LLMProviderExecutionProfile } from "../llm/types.js";
import type { ConfigProvenanceEntry } from "../config/repository.js";

/** Candidate only. Activation requires durable root storage and matched measurement. */
export const AUTOMATIC_TASK_CALL_ALLOWANCE = 16;

export interface TaskBudgetCapability {
  readonly provider: string;
  readonly model: string;
  readonly supportsMaxOutputTokens: boolean;
  readonly usageReporting: LLMProviderExecutionProfile["usageReporting"];
}

/** Host-owned root policy. Never infer this identity from restored numeric settings. */
export interface TaskBudgetPolicy {
  readonly version: 1;
  readonly rootRunId: string;
  readonly origin: "builtin" | "explicit" | "legacy";
  readonly mode: "disabled" | "strict" | "observed";
  readonly tokenLimit: number;
  /** Zero is an explicit opt-out; it must not become an automatic allowance. */
  readonly maxCalls: number;
  readonly callOrigin: "automatic" | "configured" | "off";
  readonly tokenSemantics: "disabled" | "reservation_ceiling" | "observed_target";
  readonly capabilities: readonly TaskBudgetCapability[];
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function freezeCapabilities(input: readonly TaskBudgetCapability[]): readonly TaskBudgetCapability[] {
  const seen = new Set<string>();
  const result = input.map(capability => {
    if (!capability.provider.trim() || !capability.model.trim() ||
        typeof capability.supportsMaxOutputTokens !== "boolean" ||
        !["authoritative", "unavailable"].includes(capability.usageReporting)) {
      throw new TypeError("A task budget requires a concrete provider capability");
    }
    const identity = JSON.stringify([capability.provider, capability.model]);
    if (seen.has(identity)) throw new TypeError("Duplicate task budget provider capability");
    seen.add(identity);
    return Object.freeze({ ...capability });
  });
  return Object.freeze(result.sort((a, b) =>
    JSON.stringify([a.provider, a.model]).localeCompare(JSON.stringify([b.provider, b.model]))));
}

/** Creation-only decision. A restored root must load its original record instead. */
export function selectTaskBudgetPolicy(input: {
  readonly rootRunId: string;
  readonly tokenLimit?: number;
  readonly maxCalls?: number;
  readonly tokenProvenance?: ConfigProvenanceEntry;
  readonly capabilities: readonly TaskBudgetCapability[];
  /** Existing roots without a policy cannot prove their original default origin. */
  readonly existingRoot?: boolean;
}): TaskBudgetPolicy {
  if (!input.rootRunId.trim()) throw new TypeError("A task budget requires a root run identity");
  const tokenLimit = limit(input.tokenLimit ?? DEFAULT_TASK_TOKEN_BUDGET, "task token limit");
  const configuredCalls = input.maxCalls === undefined ? undefined : limit(input.maxCalls, "task call limit");
  const capabilities = freezeCapabilities(input.capabilities);
  const origin = input.existingRoot === true || input.tokenProvenance === undefined
    ? "legacy" : input.tokenProvenance.scope === "default" ? "builtin" : "explicit";
  // Missing capability metadata is not evidence that an automatic fallback is safe.
  const needsFallback = capabilities.length > 0 && capabilities.some(capability =>
    !capability.supportsMaxOutputTokens || capability.usageReporting !== "authoritative");
  const mode = tokenLimit === 0 ? "disabled"
    : origin === "builtin" && needsFallback ? "observed" : "strict";
  const automaticCalls = mode === "observed" && configuredCalls === undefined;
  return Object.freeze({
    version: 1,
    rootRunId: input.rootRunId,
    origin,
    mode,
    tokenLimit,
    maxCalls: configuredCalls ?? (automaticCalls ? AUTOMATIC_TASK_CALL_ALLOWANCE : 0),
    callOrigin: configuredCalls !== undefined ? "configured" : automaticCalls ? "automatic" : "off",
    tokenSemantics: mode === "disabled" ? "disabled" : mode === "strict" ? "reservation_ceiling" : "observed_target",
    capabilities,
  });
}

/** Only the observed fallback needs a frozen routing set. Independent caps still apply. */
export function taskBudgetPolicyAllowsCapability(policy: TaskBudgetPolicy, candidate: TaskBudgetCapability): boolean {
  if (policy.mode !== "observed") return true;
  return policy.capabilities.some(allowed => allowed.provider === candidate.provider &&
    allowed.model === candidate.model && allowed.supportsMaxOutputTokens === candidate.supportsMaxOutputTokens &&
    allowed.usageReporting === candidate.usageReporting);
}
