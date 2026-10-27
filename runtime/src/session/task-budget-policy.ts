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
    return Object.freeze({ provider: capability.provider, model: capability.model,
      supportsMaxOutputTokens: capability.supportsMaxOutputTokens, usageReporting: capability.usageReporting });
  });
  return Object.freeze(result.sort((a, b) => {
    const left = JSON.stringify([a.provider, a.model]), right = JSON.stringify([b.provider, b.model]);
    return left < right ? -1 : left > right ? 1 : 0;
  }));
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

/** Decode only a host-owned durable record, never policy input supplied through RPC.
 * No current config or capability lookup participates in restoring the decision.
 */
export function restoreTaskBudgetPolicy(json: string, rootRunId: string): TaskBudgetPolicy {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid task budget policy record");
  const record = value as Record<string, unknown>;
  const keys = ["version", "rootRunId", "origin", "mode", "tokenLimit", "maxCalls", "callOrigin", "tokenSemantics", "capabilities"];
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key)) ||
      record.version !== 1 || !rootRunId.trim() || record.rootRunId !== rootRunId ||
      (typeof record.origin !== "string" || !["builtin", "explicit", "legacy"].includes(record.origin)) ||
      (typeof record.mode !== "string" || !["disabled", "strict", "observed"].includes(record.mode)) ||
      (typeof record.callOrigin !== "string" || !["automatic", "configured", "off"].includes(record.callOrigin)) ||
      typeof record.tokenLimit !== "number" || typeof record.maxCalls !== "number" ||
      !Array.isArray(record.capabilities)) throw new TypeError("Invalid task budget policy identity");
  const tokenLimit = limit(record.tokenLimit, "stored task token limit");
  const maxCalls = limit(record.maxCalls, "stored task call limit");
  for (const capability of record.capabilities) {
    if (!capability || typeof capability !== "object" || Array.isArray(capability) ||
        Object.keys(capability).length !== 4 ||
        !["provider", "model", "supportsMaxOutputTokens", "usageReporting"].every(key => Object.hasOwn(capability, key))) {
      throw new TypeError("Invalid stored task budget capability");
    }
  }
  const capabilities = freezeCapabilities(record.capabilities as TaskBudgetCapability[]);
  const mode = record.mode as TaskBudgetPolicy["mode"];
  const origin = record.origin as TaskBudgetPolicy["origin"];
  const callOrigin = record.callOrigin as TaskBudgetPolicy["callOrigin"];
  const tokenSemantics = mode === "disabled" ? "disabled" : mode === "strict" ? "reservation_ceiling" : "observed_target";
  if (record.tokenSemantics !== tokenSemantics || (tokenLimit === 0) !== (mode === "disabled") ||
      (callOrigin === "off" && maxCalls !== 0) ||
      (callOrigin === "automatic" && (mode !== "observed" || maxCalls === 0)) ||
      (mode === "observed" && (origin !== "builtin" || callOrigin === "off" || !capabilities.some(capability =>
        !capability.supportsMaxOutputTokens || capability.usageReporting !== "authoritative")))) {
    throw new TypeError("Inconsistent stored task budget policy");
  }
  return Object.freeze({ version: 1, rootRunId, origin, mode, tokenLimit, maxCalls, callOrigin, tokenSemantics, capabilities });
}

/** Canonical field and capability order; validates the record before storage. */
export function serializeTaskBudgetPolicy(policy: TaskBudgetPolicy): string {
  return JSON.stringify(restoreTaskBudgetPolicy(JSON.stringify(policy), policy.rootRunId));
}
