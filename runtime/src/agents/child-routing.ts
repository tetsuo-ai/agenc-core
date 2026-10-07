import type { Session } from "../session/session.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../session/cost.js";
import { allowedChildPairs, childModelInfo, currentChildProvider, childProviderPolicy } from "./cross-provider.js";
import { classifyChildTask, selectChildProvider, type ChildProviderCandidate,
  type ChildRoutingSnapshot, type ChildSelectionResult, type ChildSelectionTask } from "./provider-selector.js";
import { childModelProfile } from "./provider-selector-profiles.js";
import { subagentLimit } from "./subagent-limits.js";
import { join } from "node:path";
import { ChildRoutingOutcomeStore } from "./provider-selector-outcomes.js";
import type { ChildExecutionPlan } from "./cross-provider.js";
import type { ChildTerminalOutcome } from "./child-terminal.js";

const stores = new Map<string, Promise<ChildRoutingOutcomeStore>>();
async function outcomeStore(session: Session): Promise<ChildRoutingOutcomeStore | undefined> {
  // Only the session's canonical home is authoritative. Never fall back to
  // process.env or the owner's ambient installation from a child/test session.
  const home = session.services.configStore?.homeContext?.path;
  if (home === undefined) return undefined;
  let pending = stores.get(home);
  if (pending === undefined) {
    pending = ChildRoutingOutcomeStore.open(join(home, "state", "child-routing-outcomes.json"));
    stores.set(home, pending);
  }
  try { return await pending; }
  catch { stores.delete(home); return undefined; }
}

/** Automatic child selection is on only when both settings are on. */
export function automaticChildSelectionEnabled(session: Session): boolean {
  const policy = childProviderPolicy(session);
  return policy.cross_provider_enabled === true && policy.cross_provider_auto === true;
}

/** Routing telemetry for one committed child receipt. Nothing is written while automatic selection is off. */
export async function recordChildRoutingOutcome(session: Session, plan: ChildExecutionPlan | undefined,
  outcome: { readonly receiptId: string; readonly terminal: ChildTerminalOutcome; readonly latencyMs: number }): Promise<void> {
  if (plan === undefined || !automaticChildSelectionEnabled(session)) return;
  // A successful explicit override can restore a provider after credits or
  // credentials are repaired. Only verified quality labels train accuracy.
  const classification = plan.routing ?? classifyChildTask(plan.task.text);
  try {
    const store = await outcomeStore(session);
    await store?.record({ receiptId: outcome.receiptId, provider: outcome.terminal.provider,
      model: outcome.terminal.model, taskKind: "taskKind" in classification ? classification.taskKind : classification.kind, complexity: classification.complexity,
      terminalReason: outcome.terminal.reason, success: outcome.terminal.reason === "completed",
      latencyMs: outcome.latencyMs, atMs: Date.now(),
      ...(outcome.terminal.costUsd !== undefined ? { costUsd: outcome.terminal.costUsd } : {}),
      ...(outcome.terminal.retryAfterMs !== undefined ? { retryAfterMs: outcome.terminal.retryAfterMs } : {}),
    });
  } catch { /* Routing telemetry cannot invalidate a durable child receipt. */ }
}

export interface ChildRoutingRequest {
  readonly prompt: string;
  readonly role?: string;
  readonly taskKind?: ChildSelectionTask["kind"];
  readonly complexity?: ChildSelectionTask["complexity"];
  readonly requiresVision?: boolean;
  readonly requiresTools?: boolean;
  readonly contextTokens?: number;
  readonly maxCostUsd?: number;
  readonly outcomes?: ChildRoutingSnapshot;
}

/** The ranking estimate never replaces atomic admission at the provider wire. */
export function childRoutingBudget(session: Session, requested?: number): number | undefined {
  const admission = session.services.executionAdmission;
  if (admission?.getRemainingCostUsd !== undefined) {
    const remaining = admission.getRemainingCostUsd();
    return requested === undefined ? remaining : remaining === undefined ? requested : Math.min(requested, remaining);
  }
  const cap = admission?.scope.maxCostUsd ?? session.config?.maxBudgetUsd;
  const usage = admission?.getUsageSummary?.();
  const remaining = cap === undefined ? undefined : Math.max(0, cap -
    (usage?.costUsd ?? 0) - (usage?.heldCostUsd ?? 0));
  return requested === undefined ? remaining : remaining === undefined ? requested : Math.min(requested, remaining);
}

/** No provider discovery, credential refresh or remote router call is performed. */
export async function routeChildTask(session: Session, request: ChildRoutingRequest): Promise<{
  readonly task: ChildSelectionTask;
  readonly result: ChildSelectionResult;
}> {
  const outcomes = request.outcomes ?? (await outcomeStore(session))?.snapshot();
  const inferred = classifyChildTask(request.prompt, request.role);
  const kind = request.taskKind ?? inferred.kind;
  const complexity = request.complexity ?? inferred.complexity;
  const maxCostUsd = childRoutingBudget(session, request.maxCostUsd);
  const task: ChildSelectionTask = {
    kind, complexity, requiresTools: request.requiresTools ?? true,
    ...(request.requiresVision ? { requiresVision: true } : {}),
    ...(kind === "reasoning" ? { requiresReasoning: true } : {}),
    // Include the runtime/tool catalog and room for early tool results. The
    // canonical request admission independently verifies actual token volume.
    inputTokens: Math.max(request.contextTokens ?? 0, Math.ceil(request.prompt.length / 3) + 16_384),
    outputTokens: complexity === "hard" ? 8_192 : 4_096,
    expectedModelCalls: complexity === "simple" ? 2 : complexity === "hard" ? 8 : 4,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
  };
  const active = currentChildProvider(session);
  const isParentModel = (pair: { readonly provider: string; readonly model: string }): boolean =>
    pair.provider === active.provider && pair.model === active.model;
  const candidates: ChildProviderCandidate[] = [];
  // Read authority once per provider, then revalidate the exact model and
  // credentials during ordinary plan preparation after consent.
  const connected = new Map<string, Promise<{ readonly connected: boolean; readonly billingSource?: string }>>();
  // The parent's own model is always a candidate. It needs no entry in
  // allowed_providers, because a child on it stays on the parent's provider.
  const allowedPairs = allowedChildPairs(session);
  const pairs = [...allowedPairs, ...(allowedPairs.some(isParentModel) ? [] : [{ provider: active.provider, model: active.model }])]
    .filter(pair => childModelProfile(pair.provider, pair.model) !== undefined);
  for (const pair of pairs) {
    if (!connected.has(pair.provider)) {
      connected.set(pair.provider, typeof session.providerService?.childProviderRoutingInfo === "function"
        ? session.providerService.childProviderRoutingInfo(pair)
        : pair.provider === active.provider ? Promise.resolve({ connected: true })
        : typeof session.providerService?.isChildProviderConnected === "function"
          ? session.providerService.isChildProviderConnected(pair).then(ready => ({ connected: ready }))
          : Promise.resolve({ connected: false }));
    }
  }
  for (const pair of pairs) {
    const reported = await connected.get(pair.provider);
    // The parent is running on its own model now. Keep only the billing
    // source when the cross-provider readiness check excludes its provider.
    const authority = isParentModel(pair)
      ? { connected: true, ...(reported?.connected === true && reported.billingSource !== undefined ? { billingSource: reported.billingSource } : {}) }
      : reported;
    if (!authority?.connected) continue;
    try {
      const info = await childModelInfo(session, pair, pair.provider !== active.provider);
      const entry = resolveRegisteredModelCatalogEntry(pair);
      const rates = resolveModelCostEntry(pair, DEFAULT_MODEL_COSTS);
      const limit = subagentLimit(childProviderPolicy(session), pair.provider);
      candidates.push({ ...pair, connected: true, allowed: true,
        ...(authority.billingSource !== undefined ? { billingSource: authority.billingSource as ChildProviderCandidate["billingSource"] } : {}),
        supportsToolUse: info.supportsToolUse !== false && entry?.supportsToolUse !== false &&
          (info.supportsToolUse === true || entry?.supportsToolUse === true),
        supportsVision: entry?.inputModalities.includes("image") === true,
        supportsReasoning: info.supportedReasoningLevels.some(level => level !== "none"),
        contextWindow: info.contextWindow,
        maxOutputTokens: info.maxOutputTokens,
        ...(rates !== null && authority.billingSource !== "sign_in" ? { cost: rates.entry } : {}),
        ...(limit.speed === "fast" ? { serviceTier: "priority" } : {}),
      });
    } catch {
      // A malformed or unsupported model must not make another eligible
      // connected provider unavailable. Dispatch still checks exact metadata.
    }
  }
  return { task, result: selectChildProvider({ task, candidates,
    ...(outcomes !== undefined ? { outcomes } : {}) }) };
}
