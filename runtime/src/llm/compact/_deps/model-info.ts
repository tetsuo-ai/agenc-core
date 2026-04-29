/**
 * Model + context-window helpers compact uses to size compaction
 * payloads. The gut runtime owns the live model resolution in
 * `llm/provider.ts`/`llm/capabilities.ts`; this is the surface compact
 * needs as a stable boundary.
 */

export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;

const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export function getMainLoopModel(): string {
  return process.env.AGENC_MODEL ?? "grok-4-fast";
}

export function getContextWindowForModel(..._args: unknown[]): number {
  const env = process.env.AGENC_CONTEXT_WINDOW_TOKENS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function getMaxOutputTokensForModel(..._args: unknown[]): number {
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
