import { extractTaskFeatures, type TaskFeatures } from "./provider-selector-irt.js";
import { selectChildProviderV2, type V2Selection, type RoutingPreferences } from "./provider-selector-v2.js";
import type { TrustedChildVerification } from "./child-routing-verifier.js";
import type { Session } from "../session/session.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../session/cost.js";
import { allowedChildPairs, childModelInfo, currentChildProvider, childProviderPolicy } from "./cross-provider.js";
import { classifyChildTask, type ChildProviderCandidate,
  type ChildRoutingSnapshot, type ChildSelectionTask } from "./provider-selector.js";
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

// The provider answered the child's requests, whatever became of the task.
const PROVIDER_SERVED = new Set<ChildTerminalOutcome["reason"]>(["completed", "step_limit", "no_progress", "model_loop", "model_refused"]);

/**
 * Best-effort routing telemetry for one committed child receipt. Writes
 * nothing while automatic selection is off. Callers do not await it, so the
 * receipt never waits for this file.
 */
export async function recordChildRoutingOutcome(session: Session, plan: ChildExecutionPlan | undefined,
  outcome: { readonly receiptId: string; readonly terminal: ChildTerminalOutcome; readonly latencyMs: number }): Promise<void> {
  try {
    if (!automaticChildSelectionEnabled(session)) return;
    const store = await outcomeStore(session);
    if (store === undefined) return;
    if (plan !== undefined) {
      // Only verified quality labels train accuracy.
      const classification = plan.routing ?? classifyChildTask(plan.task.text);
      await store.record({ receiptId: outcome.receiptId, provider: outcome.terminal.provider,
        model: outcome.terminal.model, taskKind: "taskKind" in classification ? classification.taskKind : classification.kind, complexity: classification.complexity,
        terminalReason: outcome.terminal.reason, success: outcome.terminal.reason === "completed",
        retryable: outcome.terminal.retryable, latencyMs: outcome.latencyMs, atMs: Date.now(),
        ...(outcome.terminal.costUsd !== undefined ? { costUsd: outcome.terminal.costUsd } : {}),
        ...(outcome.terminal.retryAfterMs !== undefined ? { retryAfterMs: outcome.terminal.retryAfterMs } : {}),
      });
    }
    // Any child the provider served, explicit or inherited, shows that its
    // credits, credentials and availability work again.
    if (outcome.terminal.dispatch === "sent" && PROVIDER_SERVED.has(outcome.terminal.reason)) {
      await store.clearProviderFailure(outcome.terminal.provider);
    }
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
  readonly preferences?: RoutingPreferences;
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

/** A host verifier that has not prepared its check by then blocks the spawn. */
export const CHILD_VERIFIER_PREPARE_TIMEOUT_MS = 10_000;

/**
 * Ask the host's verifier for this task's check. Undefined means the host
 * does not check this task. A verifier that throws, does not answer in time
 * or returns no usable check stops the spawn: the caller reports that no
 * child started.
 */
async function prepareChildVerification(session: Session,
  request: { readonly prompt: string; readonly features: TaskFeatures }): Promise<TrustedChildVerification | undefined> {
  const verifier = session.services.childRoutingVerifier;
  if (verifier === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prepared: TrustedChildVerification | undefined;
  try {
    prepared = await Promise.race([
      Promise.resolve().then(() => verifier.prepare(request)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `The host task verifier did not prepare a check within ${CHILD_VERIFIER_PREPARE_TIMEOUT_MS / 1_000} seconds.`)),
        CHILD_VERIFIER_PREPARE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith("The host task verifier") ? message : `The host task verifier failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
  if (prepared === undefined) return undefined;
  const usable = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (prepared === null || typeof prepared !== "object" || prepared.available !== true || typeof prepared.check !== "function" ||
      typeof prepared.retrySafe !== "boolean" || !usable(prepared.costUsd) || !usable(prepared.latencyMs)) {
    throw new Error("The host task verifier returned no usable check.");
  }
  return prepared;
}

/** No provider discovery, credential refresh or remote router call is performed. */
export async function routeChildTask(session: Session, request: ChildRoutingRequest): Promise<{
  readonly task: ChildSelectionTask;
  readonly result: V2Selection;
  readonly features: TaskFeatures;
  readonly verification?: TrustedChildVerification;
}> {
  const store = request.outcomes === undefined ? await outcomeStore(session) : undefined;
  await store?.refresh();
  const outcomes = request.outcomes ?? store?.snapshot();
  const inferred = classifyChildTask(request.prompt, request.role);
  const features = extractTaskFeatures(request.prompt, request.requiresTools ?? true);
  const verification = await prepareChildVerification(session, { prompt: request.prompt, features });
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
  // allowed_providers, because a child on it stays on the parent's provider,
  // and no routing profile, because the selector keeps it as the default.
  const allowedPairs = allowedChildPairs(session);
  const pairs = [...allowedPairs, ...(allowedPairs.some(isParentModel) ? [] : [{ provider: active.provider, model: active.model }])]
    .filter(pair => isParentModel(pair) || childModelProfile(pair.provider, pair.model) !== undefined);
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
  return { task, features, ...(verification !== undefined ? { verification } : {}),
    result: selectChildProviderV2({ task, features, parent: active, candidates,
      ...(request.preferences !== undefined ? { preferences: request.preferences } : {}),
      ...(verification !== undefined ? { verification } : {}),
      ...(outcomes !== undefined ? { outcomes } : {}) }) };
}

/** Receipt-deduplicated quality update, separate from terminal execution telemetry. */
export async function recordChildRoutingVerification(session: Session, receiptId: string,
  terminal: ChildTerminalOutcome, features: TaskFeatures, passed: boolean): Promise<void> {
  try { await (await outcomeStore(session))?.recordVerification({ receiptId, provider: terminal.provider,
    model: terminal.model, features, passed, atMs: Date.now() }); }
  catch { /* Verifier telemetry must not invalidate the durable attempt. */ }
}
