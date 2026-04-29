/**
 * Lean port of `tools/orchestration.ts` for `phases/execute-tools.ts`.
 *
 * Only the env-driven concurrency cap is consumed by the gut path —
 * the rest of the upstream tool-orchestration helpers became dead code
 * once T6's `StreamingToolExecutor` + `router`/`orchestrator` path took
 * over dispatch. Mirrors the upstream behavior exactly so existing
 * `AGENC_MAX_TOOL_USE_CONCURRENCY` tuning keeps working.
 */

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
