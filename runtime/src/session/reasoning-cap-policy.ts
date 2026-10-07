/** Bounded experimental policy. Recovery budgets are deliberately not owned here. */
import { randomUUID } from "node:crypto";
import { supportsThinkingOffRecovery } from "./session-reasoning-effort.js";
import type { TurnState } from "./turn-state.js";

export interface ReasoningCapSample {
  readonly id: string;
  readonly kind: "enabled" | "recovery" | "extra";
  readonly recovering?: string;
  readonly completed?: true;
}
export interface ReasoningCapPolicyState {
  readonly provider: string;
  readonly model: string;
  streak: 0 | 1;
  pendingCap?: string;
  extraPending?: true;
  sample?: ReasoningCapSample;
}
export interface ReasoningCapTarget {
  readonly policy: "off" | "streak2" | undefined;
  readonly provider: string;
  readonly model: string;
}

const identity = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));

/** Strict reader also clones: restored and emitted slices never share mutable state. */
export function readReasoningCapPolicy(value: unknown): ReasoningCapPolicyState | undefined {
  if (value === undefined) return undefined;
  const bad = (): never => { throw new Error("Invalid reasoningCapPolicy checkpoint state"); };
  if (!record(value) || !onlyKeys(value, ["provider", "model", "streak", "pendingCap", "extraPending", "sample"])) return bad();
  if (typeof value.provider !== "string" || typeof value.model !== "string" ||
      value.model.length > 256 || !supportsThinkingOffRecovery(value.provider, value.model) ||
      (value.streak !== 0 && value.streak !== 1) ||
      (value.pendingCap !== undefined && !identity(value.pendingCap)) ||
      (value.extraPending !== undefined && value.extraPending !== true)) return bad();
  let sample: ReasoningCapSample | undefined;
  if (value.sample !== undefined) {
    const s = value.sample;
    if (!record(s) || !onlyKeys(s, ["id", "kind", "recovering", "completed"]) || !identity(s.id) ||
        !["enabled", "recovery", "extra"].includes(s.kind as string) ||
        (s.completed !== undefined && s.completed !== true) ||
        (s.recovering !== undefined && (!identity(s.recovering) || s.kind !== "recovery" || s.recovering === s.id))) return bad();
    sample = { id: s.id, kind: s.kind as ReasoningCapSample["kind"],
      ...(s.recovering !== undefined ? { recovering: s.recovering as string } : {}),
      ...(s.completed === true ? { completed: true } : {}) };
  }
  if (value.extraPending && (value.streak !== 0 || value.pendingCap !== undefined ||
      sample?.kind !== "recovery" || !sample.completed || !sample.recovering)) return bad();
  if (value.pendingCap !== undefined && !(sample?.kind === "enabled" && sample.completed && sample.id === value.pendingCap) &&
      !(sample?.kind === "recovery" && !sample.completed && sample.recovering === value.pendingCap)) return bad();
  if (sample?.kind === "recovery" && !sample.completed && sample.recovering !== value.pendingCap) return bad();
  if (sample?.kind === "extra" && (value.streak !== 0 || value.pendingCap !== undefined || value.extraPending !== undefined)) return bad();
  return { provider: value.provider, model: value.model, streak: value.streak,
    ...(value.pendingCap !== undefined ? { pendingCap: value.pendingCap as string } : {}),
    ...(value.extraPending === true ? { extraPending: true } : {}), ...(sample ? { sample } : {}) };
}

export function reasoningCapPolicyEligible(target: ReasoningCapTarget): boolean {
  return target.policy === "streak2" && supportsThinkingOffRecovery(target.provider, target.model);
}

/** Called only at the real dispatch boundary, never by prompt/token inspection. */
export function admitReasoningCapSample(state: TurnState, target: ReasoningCapTarget): ReasoningCapSample | undefined {
  if (!reasoningCapPolicyEligible(target)) { state.reasoningCapPolicy = undefined; return undefined; }
  if (state.pendingAdmissionFallback || state.modelSampleResumePrompt || state.pendingBudgetDecision ||
      (state.transition && state.transition.reason !== "max_output_tokens_escalate" &&
        state.transition.reason !== "max_output_tokens_recovery")) state.reasoningCapPolicy = undefined;
  let policy = state.reasoningCapPolicy;
  if (!policy || policy.provider !== target.provider || policy.model !== target.model) {
    policy = state.reasoningCapPolicy = { provider: target.provider, model: target.model, streak: 0 };
  }
  // A resumed or reconnected logical request retains its admitted cause.
  if (policy.sample && !policy.sample.completed) return { ...policy.sample };
  let kind: ReasoningCapSample["kind"] = "enabled";
  let recovering: string | undefined;
  if (state.reasoningOnlyRecoveryPending) {
    kind = "recovery";
    recovering = policy.pendingCap;
    if (!recovering) { policy.streak = 0; policy.extraPending = undefined; }
  } else if (policy.extraPending) {
    kind = "extra";
    policy.extraPending = undefined;
  } else if (policy.pendingCap) {
    // No matching native recovery was admitted.
    policy.streak = 0;
    policy.pendingCap = undefined;
  }
  policy.sample = { id: randomUUID(), kind, ...(recovering ? { recovering } : {}) };
  return { ...policy.sample };
}

/** Called after canonical tool validation, before Phase 3 admits any cap recovery. */
export function completeReasoningCapSample(state: TurnState, sample: ReasoningCapSample | undefined,
  productive: boolean, capped: boolean): void {
  const policy = state.reasoningCapPolicy;
  if (!sample || !policy?.sample || policy.sample.id !== sample.id || policy.sample.completed) return;
  policy.sample = { ...policy.sample, completed: true };
  if (sample.kind === "recovery" && sample.recovering && sample.recovering === policy.pendingCap && productive) {
    policy.pendingCap = undefined;
    if (policy.streak === 1) { policy.streak = 0; policy.extraPending = true; }
    else policy.streak = 1;
  } else if (sample.kind === "enabled" && capped) {
    // Hold the preceding streak until the existing classifier/admission says yes.
  } else {
    policy.streak = 0;
    policy.pendingCap = undefined;
    policy.extraPending = undefined;
  }
}

/** Only the existing reasoning-only classifier and admitted native recovery may call this. */
export function qualifyReasoningCapRecovery(state: TurnState, qualifying: boolean): void {
  const policy = state.reasoningCapPolicy;
  if (!policy) return;
  if (qualifying && policy.sample?.kind === "enabled" && policy.sample.completed) {
    policy.pendingCap = policy.sample.id;
  } else {
    policy.streak = 0;
    policy.pendingCap = undefined;
    policy.extraPending = undefined;
  }
}
