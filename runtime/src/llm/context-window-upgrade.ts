/**
 * Context-window upgrade hint helper.
 *
 * Both upstream openclaude and AgenC expose
 * `getUpgradeMessage(context)` — a sync helper that checks whether the
 * user is on a model that has a "more context" sibling available
 * (Sonnet -> Sonnet 1M, Opus -> Opus 1M) and returns either a short
 * `/model <alias>` warning or a longer "Tip: you have access to ..."
 * message. Their implementation is Anthropic-specific and queries an
 * entitlement endpoint cached at startup.
 *
 * The gut runtime is multi-provider, so the gut equivalent works off
 * the `ModelsManager` catalog instead of provider-specific entitlement
 * RPCs. The runtime owner registers a snapshot of:
 *
 *   - the currently selected model slug
 *   - the available models (from `tryListModels()`, kept sync)
 *
 * via `setContextWindowUpgradeContext()`. The post-compact stdout
 * breadcrumb (and any other sync caller) then reads that snapshot to
 * decide whether to emit a tip.
 *
 * The upgrade rule is intentionally conservative: only surface a tip
 * when the catalog contains a model that:
 *   1. Is from the same provider family (matched on slug prefix);
 *   2. Has a strictly larger `contextWindow`;
 *   3. Is not the same slug already in use.
 *
 * If no such sibling exists, the helper returns `null` so the caller
 * omits the tip line entirely. This keeps the message honest — we
 * never invent a "1M context available" tip when no 1M sibling is
 * actually configured.
 */

import type { ModelsManager } from "../session/session.js";
import type { ModelInfo } from "../session/turn-context.js";

export interface ContextWindowUpgradeSnapshot {
  /** Currently selected model slug (e.g. `'grok-4'`, `'gpt-5'`). */
  readonly currentModel: string;
  /**
   * Live `ModelsManager` reference. We only call its sync
   * `tryListModels()` method; async `getModelInfo` is intentionally
   * avoided so the caller does not have to await.
   */
  readonly modelsManager: ModelsManager;
}

let activeSnapshot: ContextWindowUpgradeSnapshot | null = null;

/**
 * Register (or replace) the runtime snapshot used by
 * `getUpgradeMessage`. Called by bootstrap once a Session is built;
 * called again when the user switches models via `/model`.
 *
 * Pass `null` to clear (e.g. on shutdown / for tests).
 */
export function setContextWindowUpgradeContext(
  snapshot: ContextWindowUpgradeSnapshot | null,
): void {
  activeSnapshot = snapshot;
}

/**
 * Read the active snapshot, if any. Exposed primarily for tests so
 * they can assert clean lifecycle.
 */
export function getContextWindowUpgradeContext(): ContextWindowUpgradeSnapshot | null {
  return activeSnapshot;
}

/**
 * Heuristic to decide whether two model slugs come from the same
 * provider family. We don't have an authoritative provider->slugs
 * registry here (the catalog the snapshot points at is already
 * multi-provider), so we approximate by matching the leading
 * alphanumeric prefix up to the first separator (`-`, `:`, or `/`).
 *
 * Examples:
 *   - `'gpt-5'` and `'gpt-5-mini'` -> `gpt`/`gpt` -> match.
 *   - `'grok-4'` and `'grok-code-fast-1'` -> `grok`/`grok` -> match.
 *   - `'claude-opus-4-7'` and `'claude-opus-4-7[1m]'` -> `claude`/`claude` -> match.
 *   - `'gpt-5'` and `'grok-4'` -> `gpt`/`grok` -> no match.
 */
function modelFamily(slug: string): string {
  const trimmed = slug.trim().toLowerCase();
  const sepMatch = trimmed.match(/^([a-z]+)/);
  return sepMatch ? sepMatch[1] : trimmed;
}

/**
 * Find an available model whose context window is strictly larger
 * than the current model's. Same-family ranking ties prefer the
 * smallest qualifying upgrade (avoids jumping straight to a 10M-token
 * model when a 1M sibling exists).
 */
function findUpgradeCandidate(
  current: ModelInfo,
  available: ReadonlyArray<ModelInfo>,
): ModelInfo | null {
  const currentWindow = current.contextWindow;
  if (currentWindow === undefined) return null;

  const currentFamily = modelFamily(current.slug);
  let best: ModelInfo | null = null;
  for (const candidate of available) {
    if (candidate.slug === current.slug) continue;
    if (candidate.contextWindow === undefined) continue;
    if (candidate.contextWindow <= currentWindow) continue;
    if (modelFamily(candidate.slug) !== currentFamily) continue;
    if (best === null || candidate.contextWindow < (best.contextWindow ?? Number.POSITIVE_INFINITY)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Return a short upgrade message string, or `null` when no upgrade
 * is available. `context` selects the message style:
 *   - `'warning'`: returns a `/model <slug>` action snippet suitable
 *     for a one-line nudge (e.g. shown when the user is close to the
 *     compaction threshold).
 *   - `'tip'`: returns a longer human-readable tip suitable for the
 *     post-compact stdout breadcrumb.
 */
export function getUpgradeMessage(context: "warning" | "tip"): string | null {
  const snapshot = activeSnapshot;
  if (snapshot === null) return null;

  const available = snapshot.modelsManager.tryListModels();
  if (available === undefined || available.length === 0) return null;

  const current = available.find((m) => m.slug === snapshot.currentModel);
  if (current === undefined) return null;

  const upgrade = findUpgradeCandidate(current, available);
  if (upgrade === null) return null;

  const currentWindow = current.contextWindow ?? 0;
  const upgradeWindow = upgrade.contextWindow ?? 0;
  const multiplier =
    currentWindow > 0 ? Math.round((upgradeWindow / currentWindow) * 10) / 10 : 0;

  switch (context) {
    case "warning":
      return `/model ${upgrade.slug}`;
    case "tip":
      if (multiplier >= 2) {
        return `Tip: You have access to ${upgrade.slug} with ${multiplier}x more context`;
      }
      return `Tip: You have access to ${upgrade.slug} with a larger context window`;
    default:
      return null;
  }
}
