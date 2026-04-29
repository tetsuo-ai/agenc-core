/**
 * Config-read helpers extracted from `ChatExecutor` (Phase F
 * PR-2 of the plan in TODO.MD).
 *
 * These functions read from the class's immutable construction-
 * time config fields (`economicsPolicy`, `modelRoutingPolicy`,
 * `defaultRunClass`, `promptBudget`) and turn them into
 * phase-specific decisions. They are exposed as free functions
 * that take the relevant config as explicit arguments (the
 * state-as-argument pattern).
 *
 * The class keeps 1-line delegators that thread its private
 * fields through to these helpers until PR-8 eliminates the
 * delegators.
 *
 * @module
 */

import {
  resolveModelRoute,
  type ModelRoutingPolicy,
} from "./model-routing-policy.js";
import {
  getRuntimeBudgetPressure,
  mapPhaseToRunClass,
  type RuntimeEconomicsPolicy,
  type RuntimeRunClass,
} from "./run-budget.js";
import { isConcordiaSimulationTurnMessage } from "./chat-executor-turn-contracts.js";
import { MAX_CONTEXT_INJECTION_CHARS } from "./chat-executor-constants.js";
import type {
  ChatCallUsageRecord,
  ExecutionContext,
} from "./chat-executor-types.js";
import type { PromptBudgetConfig, PromptBudgetSection } from "./prompt-budget.js";

/**
 * Decide which run class a given phase should execute under.
 *
 * Concordia simulation turns ignore the configured default and
 * always run as `"child"` during the initial + tool_followup
 * phases; everything else honors (in order): the per-request
 * override on the ctx, the constructor's default, and finally
 * the phase-to-run-class table in `run-budget.ts`.
 *
 * Phase F extraction (PR-2). Previously
 * `ChatExecutor.resolveRunClassForPhase`.
 */
export function resolveRunClassForPhase(
  ctx: ExecutionContext,
  phase: ChatCallUsageRecord["phase"],
  defaultRunClass: RuntimeRunClass | undefined,
): RuntimeRunClass {
  if (
    isConcordiaSimulationTurnMessage(ctx.message) &&
    (phase === "initial" || phase === "tool_followup")
  ) {
    return "child";
  }
  return ctx.defaultRunClass ?? defaultRunClass ?? mapPhaseToRunClass(phase);
}

/**
 * Resolve the full routing decision for a provider call: the
 * run class, the budget pressure (derived from the economics
 * policy + current economics state + run class), and the
 * concrete model route (derived from the routing policy with
 * the degraded provider list accounted for).
 *
 * `degradedProviderNames` is threaded as an explicit argument
 * rather than computed here — the caller typically invokes
 * `buildDegradedProviderNames` from `chat-executor-state.ts`
 * first and passes the result in. This keeps all cooldown-Map
 * reads inside the state module.
 *
 * Phase F extraction (PR-2). Previously
 * `ChatExecutor.resolveRoutingDecision`.
 */
export function resolveRoutingDecision(
  ctx: ExecutionContext,
  phase: ChatCallUsageRecord["phase"],
  config: {
    readonly economicsPolicy: RuntimeEconomicsPolicy;
    readonly modelRoutingPolicy: ModelRoutingPolicy;
    readonly defaultRunClass: RuntimeRunClass | undefined;
  },
  degradedProviderNames: readonly string[],
  requirements?: {
    readonly statefulContinuationRequired?: boolean;
    readonly structuredOutputRequired?: boolean;
    readonly routedToolNames?: readonly string[];
  },
): {
  readonly runClass: RuntimeRunClass;
  readonly pressure: ReturnType<typeof getRuntimeBudgetPressure>;
  readonly route: ReturnType<typeof resolveModelRoute>;
} {
  const runClass = resolveRunClassForPhase(ctx, phase, config.defaultRunClass);
  const pressure = getRuntimeBudgetPressure(
    config.economicsPolicy,
    ctx.economicsState,
    runClass,
  );
  return {
    runClass,
    pressure,
    route: resolveModelRoute({
      policy: config.modelRoutingPolicy,
      runClass,
      pressure,
      degradedProviderNames,
      requirements,
    }),
  };
}

/**
 * Compute the per-section character cap for context injection
 * into the prompt. Memory sections honor the configured role
 * contract (working/episodic/semantic) with a floor of 256 and
 * a hard ceiling of `MAX_CONTEXT_INJECTION_CHARS`; all other
 * sections use `MAX_CONTEXT_INJECTION_CHARS` directly.
 *
 * Phase F extraction (PR-2). Previously
 * `ChatExecutor.getContextSectionMaxChars`.
 */
export function getContextSectionMaxChars(
  promptBudget: PromptBudgetConfig,
  section: PromptBudgetSection,
): number {
  const roleContracts = promptBudget.memoryRoleContracts;
  const byRole = (role: "working" | "episodic" | "semantic"): number => {
    const maxChars = roleContracts?.[role]?.maxChars;
    if (typeof maxChars !== "number" || !Number.isFinite(maxChars)) {
      return MAX_CONTEXT_INJECTION_CHARS;
    }
    return Math.max(256, Math.floor(maxChars));
  };

  switch (section) {
    case "memory_working":
      return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("working"));
    case "memory_episodic":
      return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("episodic"));
    case "memory_semantic":
      return Math.min(MAX_CONTEXT_INJECTION_CHARS, byRole("semantic"));
    default:
      return MAX_CONTEXT_INJECTION_CHARS;
  }
}
