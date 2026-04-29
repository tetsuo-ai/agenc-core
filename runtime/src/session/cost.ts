/**
 * Cost sidecar — session cost tracking + formatting.
 *
 * Hand-port of AgenC `cost-tracker.ts` (327 LOC) + `costHook.ts`
 * (22 LOC) + relevant `utils/tokens.ts` (261 LOC) bits, restructured
 * to live as a SidecarManager-compatible Sidecar rather than the
 * AgenC bootstrap-state global.
 *
 * Responsibilities:
 *   - Subscribe to `token_count` events and tally cumulative
 *     input/output/cached/reasoning tokens per model.
 *   - Maintain a model cost registry (USD/1K input + USD/1K output
 *     + USD/1K cached). Ships sensible defaults for grok-4-*, gpt-*,
 *     claude-*, and local providers; callers can override the registry.
 *   - Format cumulative cost for `/status` and status-line display.
 *   - Emit `token_budget_exceeded` warnings via the session-level
 *     BudgetTracker (integrates with llm/token-budget.ts per I-22).
 *
 * @module
 */

import { join } from "node:path";
import { promises as fsp } from "node:fs";
import { monotonicMs } from "./_deps/utils.js";
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
 * pricing plus reasonable defaults for local providers (zero cost).
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
// Cross-session persistence (T6 gap: cost totals survive resume).
//
// Layout: ~/.agenc/projects/<slug>/cost-totals.json
//
//   {
//     "version": 1,
//     "totalUsage": { inputTokens, outputTokens, cacheReadTokens, ... },
//     "totalCostUsd": N,
//     "sessions": [ { sessionId, startedAtMs, endedAtMs, usage, costUsd } ],
//     "updatedAtMs": N
//   }
//
// Writes are atomic via tmp+fsync+rename so a crash mid-save leaves
// either the previous or the new file intact.
// ─────────────────────────────────────────────────────────────────────

export const COST_TOTALS_FILENAME = "cost-totals.json";
export const COST_TOTALS_SCHEMA_VERSION = 1;

/** Aggregate token totals used by lifetime totals and per-session records. */
export interface CostTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface SessionCostRecord {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly usage: CostTotals;
  readonly costUsd: number;
}

export interface CostTotalsFile {
  readonly version: number;
  readonly totalUsage: CostTotals;
  readonly totalCostUsd: number;
  readonly sessions: ReadonlyArray<SessionCostRecord>;
  readonly updatedAtMs: number;
}

function emptyTotals(): CostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addTotals(a: CostTotals, b: CostTotals): CostTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function validateTotalsFile(raw: unknown): CostTotalsFile | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Partial<CostTotalsFile>;
  if (typeof f.version !== "number") return null;
  if (!f.totalUsage || typeof f.totalUsage !== "object") return null;
  if (typeof f.totalCostUsd !== "number") return null;
  if (!Array.isArray(f.sessions)) return null;
  if (typeof f.updatedAtMs !== "number") return null;
  return f as CostTotalsFile;
}

/**
 * Atomic write helper — write to `<path>.tmp`, fsync, rename over
 * `path`. Mirrors the pattern used by `session-store.ts`
 * `writeIndexSnapshot` but self-contained so cost.ts has no dep on
 * SessionStore. Uses node:fs/promises so the CostSidecar save path
 * is async and doesn't block the event loop.
 */
export async function atomicWriteJson(
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await fsp.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, path);
}

// ─────────────────────────────────────────────────────────────────────
// CostSidecar
// ─────────────────────────────────────────────────────────────────────

export interface CostSidecarOpts {
  readonly registry?: Readonly<Record<string, ModelCostEntry>>;
  /** Optional BudgetTracker to receive token totals (I-22 integration). */
  readonly budgetTracker?: BudgetTracker | null;
  /**
   * Project directory for cross-session persistence. When set, the
   * sidecar loads/saves `cost-totals.json` under this directory. When
   * unset, the sidecar is in-memory only (legacy behavior, tests).
   */
  readonly projectDir?: string;
  /** Session id stamped onto the per-session record on save. */
  readonly sessionId?: string;
  /**
   * Optional diagnostic sink for load/save failures. Matches the
   * sidecar-manager `SidecarDiagnostic` shape but stays a plain
   * callback so cost.ts stays UI-layer agnostic.
   */
  readonly onDiagnostic?: (d: {
    readonly level: "warning" | "error";
    readonly cause: string;
    readonly message: string;
  }) => void;
  /**
   * Test-only seam — override the atomic write implementation to
   * simulate disk failures. Falls back to `atomicWriteJson`.
   */
  readonly writeImpl?: (path: string, content: string) => Promise<void>;
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

  // ── cross-session persistence state ──
  private projectDir: string | null;
  private sessionId: string | null;
  private readonly onDiagnostic?: (d: {
    readonly level: "warning" | "error";
    readonly cause: string;
    readonly message: string;
  }) => void;
  private readonly writeImpl: (path: string, content: string) => Promise<void>;
  private readonly sessionStartedAtWallMs = Date.now();
  /** Lifetime snapshot from disk (does not include current session). */
  private loadedTotalUsage: CostTotals = emptyTotals();
  private loadedTotalCostUsd = 0;
  private loadedSessions: SessionCostRecord[] = [];
  /** True once loadFromDisk has run (success or absent-file). */
  private loaded = false;
  private saveDegraded = false;

  constructor(opts: CostSidecarOpts = {}) {
    this.registry = opts.registry ?? DEFAULT_MODEL_COSTS;
    this.budgetTracker = opts.budgetTracker ?? null;
    this.projectDir = opts.projectDir ?? null;
    this.sessionId = opts.sessionId ?? null;
    this.onDiagnostic = opts.onDiagnostic;
    this.writeImpl = opts.writeImpl ?? atomicWriteJson;
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
    return this.saveDegraded;
  }

  // ─────────────────────────────────────────────────────────────────
  // Cross-session persistence
  // ─────────────────────────────────────────────────────────────────

  /**
   * Configure (or reconfigure) the persistence target. Useful when the
   * sidecar is constructed before the project dir / session id are
   * known (e.g., tests mutate it later).
   */
  setPersistenceContext(opts: {
    readonly projectDir: string;
    readonly sessionId: string;
  }): void {
    this.projectDir = opts.projectDir;
    this.sessionId = opts.sessionId;
  }

  private get totalsPath(): string | null {
    return this.projectDir
      ? join(this.projectDir, COST_TOTALS_FILENAME)
      : null;
  }

  /**
   * Load lifetime totals from disk. Missing file → empty state (no
   * warning). Malformed JSON or bad schema → empty state + warning
   * diagnostic. Safe to call before the sidecar is wired into the
   * event log.
   */
  async loadFromDisk(): Promise<void> {
    this.loaded = true;
    const path = this.totalsPath;
    if (!path) return;
    let raw: string;
    try {
      raw = await fsp.readFile(path, "utf8");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return; // first-run, start empty
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_load_failed",
        message: `cost-totals read failed: ${code ?? (err as Error).message}`,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_load_corrupt",
        message: `cost-totals JSON parse failed: ${(err as Error).message}`,
      });
      return;
    }
    const validated = validateTotalsFile(parsed);
    if (!validated) {
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_load_corrupt",
        message: "cost-totals schema invalid",
      });
      return;
    }
    // Coerce partial totalUsage (forward-compat: missing fields → 0).
    this.loadedTotalUsage = {
      inputTokens: validated.totalUsage.inputTokens ?? 0,
      outputTokens: validated.totalUsage.outputTokens ?? 0,
      cacheReadTokens: validated.totalUsage.cacheReadTokens ?? 0,
      reasoningOutputTokens: validated.totalUsage.reasoningOutputTokens ?? 0,
      totalTokens: validated.totalUsage.totalTokens ?? 0,
    };
    this.loadedTotalCostUsd = validated.totalCostUsd;
    this.loadedSessions = [...validated.sessions];
  }

  /** Current session's in-memory totals, in `CostTotals` shape. */
  getSessionTotals(): CostTotals {
    return {
      inputTokens: this.getTotalInputTokens(),
      outputTokens: this.getTotalOutputTokens(),
      cacheReadTokens: this.getTotalCachedInputTokens(),
      reasoningOutputTokens: this.getTotalReasoningOutputTokens(),
      totalTokens: this.getSessionTotalTokensRaw(),
    };
  }

  private getSessionTotalTokensRaw(): number {
    let total = 0;
    for (const usage of this.perModel.values()) total += usage.totalTokens;
    return total;
  }

  /**
   * Lifetime totals — loaded-from-disk totals plus the current
   * session's in-memory tally. Returned values are tokens, not cost.
   */
  getLifetimeTotals(): CostTotals {
    return addTotals(this.loadedTotalUsage, this.getSessionTotals());
  }

  getLifetimeCostUsd(): number {
    return this.loadedTotalCostUsd + this.getTotalCostUsd();
  }

  /**
   * Append a finished session's totals to the sessions[] array. Does
   * not itself write to disk — call `saveToDisk()` afterward.
   */
  appendSessionRecord(summary: SessionCostRecord): void {
    this.loadedSessions.push(summary);
    this.loadedTotalUsage = addTotals(this.loadedTotalUsage, summary.usage);
    this.loadedTotalCostUsd += summary.costUsd;
  }

  /**
   * Atomically write the current lifetime totals to disk. Tolerates
   * disk failure: emits `cost_save_failed` warning and flags the
   * sidecar degraded but keeps the in-memory totals intact so the
   * next save attempt can succeed.
   */
  async saveToDisk(): Promise<void> {
    const path = this.totalsPath;
    if (!path) return;
    if (!this.loaded) await this.loadFromDisk();
    const payload: CostTotalsFile = {
      version: COST_TOTALS_SCHEMA_VERSION,
      totalUsage: this.loadedTotalUsage,
      totalCostUsd: this.loadedTotalCostUsd,
      sessions: this.loadedSessions,
      updatedAtMs: Date.now(),
    };
    try {
      await fsp.mkdir(this.projectDir!, { recursive: true });
      await this.writeImpl(path, JSON.stringify(payload));
      this.saveDegraded = false;
    } catch (err) {
      this.saveDegraded = true;
      this.onDiagnostic?.({
        level: "warning",
        cause: "cost_save_failed",
        message: `cost-totals atomic write failed: ${(err as { code?: string }).code ?? (err as Error).message}`,
      });
    }
  }

  /**
   * Sidecar lifecycle hook invoked by `SidecarManager.stop()` during
   * session shutdown. Finalizes the current session into `sessions[]`
   * and flushes to disk. Called before the event-log is closed so
   * any diagnostic emissions still land in the rollout.
   */
  async stop(): Promise<void> {
    if (!this.projectDir || !this.sessionId) return;
    const usage = this.getSessionTotals();
    const record: SessionCostRecord = {
      sessionId: this.sessionId,
      startedAtMs: this.sessionStartedAtWallMs,
      endedAtMs: Date.now(),
      usage,
      costUsd: this.getTotalCostUsd(),
    };
    this.appendSessionRecord(record);
    await this.saveToDisk();
  }
}
