/**
 * Cost sidecar — session cost tracking + formatting.
 *
 * Hand-port of openclaude `cost-tracker.ts` (327 LOC) + `costHook.ts`
 * (22 LOC) + relevant `utils/tokens.ts` (261 LOC) bits, restructured
 * to live as a SidecarManager-compatible Sidecar rather than the
 * openclaude bootstrap-state global.
 *
 * Responsibilities:
 *   - Subscribe to `token_count` events and tally cumulative
 *     input/output/cached/reasoning tokens per model.
 *   - Maintain a model cost registry (USD/1K input + USD/1K output
 *     + USD/1K cached). T13 populates the registry with real rates;
 *     T5 ships sensible defaults for grok-4-*, gpt-*, claude-*, and
 *     a fallback 0-cost entry.
 *   - Format cumulative cost for `/status` and status-line display.
 *   - Emit `token_budget_exceeded` warnings via the session-level
 *     BudgetTracker (integrates with llm/token-budget.ts per I-22).
 *
 * @module
 */

import { monotonicMs } from "../utils/monotonic.js";
import type { BudgetTracker } from "../llm/token-budget.js";
import type { Event } from "./event-log.js";
import type { Sidecar } from "./sidecar.js";

// ─────────────────────────────────────────────────────────────────────
// Cost registry — USD per 1K tokens.
// ─────────────────────────────────────────────────────────────────────

export interface ModelCostEntry {
  readonly inputUsdPer1K: number;
  readonly outputUsdPer1K: number;
  readonly cachedInputUsdPer1K?: number;
  readonly reasoningOutputUsdPer1K?: number;
  /** Free-form label for display. */
  readonly label?: string;
}

/**
 * Default model cost registry. Values are best-available public
 * pricing at the time of T6 + reasonable defaults for local
 * providers (zero cost). T13 replaces with a capability-aware
 * dynamic registry.
 *
 * Prices here are illustrative; override via `registerModelCost()`.
 */
export const DEFAULT_MODEL_COSTS: Readonly<Record<string, ModelCostEntry>> =
  Object.freeze({
    "grok-4-fast": { inputUsdPer1K: 0.002, outputUsdPer1K: 0.01 },
    "grok-4-1-fast-non-reasoning": {
      inputUsdPer1K: 0.002,
      outputUsdPer1K: 0.01,
    },
    "grok-4.20-0309-reasoning": {
      inputUsdPer1K: 0.003,
      outputUsdPer1K: 0.012,
      reasoningOutputUsdPer1K: 0.012,
    },
    "gpt-4o": { inputUsdPer1K: 0.0025, outputUsdPer1K: 0.01 },
    "gpt-4o-mini": { inputUsdPer1K: 0.00015, outputUsdPer1K: 0.0006 },
    "claude-3-5-sonnet": { inputUsdPer1K: 0.003, outputUsdPer1K: 0.015 },
    "claude-3-5-haiku": { inputUsdPer1K: 0.001, outputUsdPer1K: 0.005 },
    ollama: { inputUsdPer1K: 0, outputUsdPer1K: 0, label: "local" },
    lmstudio: { inputUsdPer1K: 0, outputUsdPer1K: 0, label: "local" },
  });

// ─────────────────────────────────────────────────────────────────────
// Per-model usage accumulator
// ─────────────────────────────────────────────────────────────────────

export interface ModelUsage {
  readonly model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Number of completed turns attributed to this model. */
  turns: number;
}

function emptyModelUsage(model: string): ModelUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    turns: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Cost computation
// ─────────────────────────────────────────────────────────────────────

export function computeUsdCost(
  usage: ModelUsage,
  registry: Readonly<Record<string, ModelCostEntry>>,
): number {
  const entry = registry[usage.model] ?? registry[canonicalModel(usage.model)];
  if (!entry) return 0;
  const inputCost = (usage.inputTokens / 1000) * entry.inputUsdPer1K;
  const outputCost = (usage.outputTokens / 1000) * entry.outputUsdPer1K;
  const cachedCost =
    entry.cachedInputUsdPer1K !== undefined
      ? (usage.cachedInputTokens / 1000) * entry.cachedInputUsdPer1K
      : 0;
  const reasoningCost =
    entry.reasoningOutputUsdPer1K !== undefined
      ? (usage.reasoningOutputTokens / 1000) * entry.reasoningOutputUsdPer1K
      : 0;
  return inputCost + outputCost + cachedCost + reasoningCost;
}

/**
 * Normalize model slug to a canonical key present in the registry.
 * T13 replaces this with the capability-registry alias map.
 */
function canonicalModel(model: string): string {
  if (model.startsWith("grok-4-fast")) return "grok-4-fast";
  if (model.startsWith("grok-4")) return "grok-4.20-0309-reasoning";
  if (model.startsWith("gpt-4o-mini")) return "gpt-4o-mini";
  if (model.startsWith("gpt-4o")) return "gpt-4o";
  if (model.startsWith("claude-3-5-haiku")) return "claude-3-5-haiku";
  if (model.startsWith("claude-3-5-sonnet")) return "claude-3-5-sonnet";
  if (model.startsWith("ollama:")) return "ollama";
  if (model.startsWith("lmstudio:")) return "lmstudio";
  return model;
}

// ─────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────

export function formatUsdCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m${secs}s`;
  }
  const hrs = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  return `${hrs}h${mins}m`;
}

// ─────────────────────────────────────────────────────────────────────
// CostSidecar
// ─────────────────────────────────────────────────────────────────────

export interface CostSidecarOpts {
  readonly registry?: Readonly<Record<string, ModelCostEntry>>;
  /** Optional BudgetTracker to receive token totals (I-22 integration). */
  readonly budgetTracker?: BudgetTracker | null;
}

export class CostSidecar implements Sidecar {
  readonly name = "cost";
  private readonly registry: Readonly<Record<string, ModelCostEntry>>;
  private readonly budgetTracker: BudgetTracker | null;
  private readonly perModel = new Map<string, ModelUsage>();
  private totalApiDurationMs = 0;
  private readonly startedAtMs = monotonicMs();
  private lastTurnStartMs: number | null = null;
  private currentModel: string | null = null;

  constructor(opts: CostSidecarOpts = {}) {
    this.registry = opts.registry ?? DEFAULT_MODEL_COSTS;
    this.budgetTracker = opts.budgetTracker ?? null;
  }

  onEvent(event: Event): void {
    const msg = event.msg;
    switch (msg.type) {
      case "turn_started": {
        this.lastTurnStartMs = monotonicMs();
        break;
      }
      case "turn_context": {
        this.currentModel = msg.payload.model;
        break;
      }
      case "session_meta": {
        if (msg.payload.model) this.currentModel = msg.payload.model;
        break;
      }
      case "token_count": {
        const model = this.currentModel ?? "unknown";
        const usage = this.perModel.get(model) ?? emptyModelUsage(model);
        usage.inputTokens += msg.payload.promptTokens ?? 0;
        usage.outputTokens += msg.payload.completionTokens ?? 0;
        usage.cachedInputTokens += msg.payload.cachedInputTokens ?? 0;
        usage.reasoningOutputTokens += msg.payload.reasoningOutputTokens ?? 0;
        usage.totalTokens += msg.payload.totalTokens ?? 0;
        this.perModel.set(model, usage);
        if (this.budgetTracker) {
          this.budgetTracker.addEmitted(
            (msg.payload.completionTokens ?? 0) +
              (msg.payload.reasoningOutputTokens ?? 0),
          );
        }
        break;
      }
      case "turn_complete": {
        const model = this.currentModel ?? "unknown";
        const usage = this.perModel.get(model);
        if (usage) usage.turns += 1;
        if (this.lastTurnStartMs !== null) {
          this.totalApiDurationMs += monotonicMs() - this.lastTurnStartMs;
          this.lastTurnStartMs = null;
        }
        break;
      }
      default:
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Accessors (consumed by /status command + T12 TUI status line)
  // ─────────────────────────────────────────────────────────────────

  getTotalCostUsd(): number {
    let total = 0;
    for (const usage of this.perModel.values()) {
      total += computeUsdCost(usage, this.registry);
    }
    return total;
  }

  getPerModelUsage(): ReadonlyArray<ModelUsage> {
    return Array.from(this.perModel.values());
  }

  getTotalInputTokens(): number {
    let total = 0;
    for (const usage of this.perModel.values()) total += usage.inputTokens;
    return total;
  }

  getTotalOutputTokens(): number {
    let total = 0;
    for (const usage of this.perModel.values()) total += usage.outputTokens;
    return total;
  }

  getTotalCachedInputTokens(): number {
    let total = 0;
    for (const usage of this.perModel.values()) total += usage.cachedInputTokens;
    return total;
  }

  getTotalReasoningOutputTokens(): number {
    let total = 0;
    for (const usage of this.perModel.values())
      total += usage.reasoningOutputTokens;
    return total;
  }

  getTotalTurns(): number {
    let total = 0;
    for (const usage of this.perModel.values()) total += usage.turns;
    return total;
  }

  getTotalDurationMs(): number {
    return monotonicMs() - this.startedAtMs;
  }

  getTotalApiDurationMs(): number {
    return this.totalApiDurationMs;
  }

  /** One-line session cost summary for `/status`. */
  formatSummary(): string {
    const cost = this.getTotalCostUsd();
    const input = this.getTotalInputTokens();
    const output = this.getTotalOutputTokens();
    const turns = this.getTotalTurns();
    const duration = formatDuration(this.getTotalDurationMs());
    return `${formatUsdCost(cost)} • in=${formatTokenCount(input)} out=${formatTokenCount(output)} • turns=${turns} • ${duration}`;
  }

  /** Reset state (for `/clear` and tests). */
  reset(): void {
    this.perModel.clear();
    this.totalApiDurationMs = 0;
    this.lastTurnStartMs = null;
    this.currentModel = null;
  }

  isDegraded(): boolean {
    return false; // Cost tracker is in-memory only.
  }
}
