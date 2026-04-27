/**
 * Tool-batch orchestration helper.
 *
 * Formerly a subset port of AgenC `services/tools/toolOrchestration.ts`
 * (188 LOC) that provided `partitionToolCalls`, `runToolsConcurrently`,
 * and `runToolsSerially`. Those helpers became dead code once T6's
 * `StreamingToolExecutor` + `router`/`orchestrator` path took over tool
 * dispatch. Only the env-driven concurrency cap remains, consumed by
 * `phases/execute-tools.ts` when it gates mid-stream dispatch.
 *
 * @module
 */

// ─────────────────────────────────────────────────────────────────────
// Concurrency cap
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TOOL_USE_CONCURRENCY = 10;

export function resolveMaxToolUseConcurrency(): number {
  const raw = process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
  if (!raw) return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOOL_USE_CONCURRENCY;
  }
  return parsed;
}
