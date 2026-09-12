/**
 * Anthropic fast mode (research preview): the same model served with a
 * faster inference configuration, up to 2.5x output tokens per second at a
 * premium price. On the wire it is `speed: "fast"` plus the
 * `fast-mode-2026-02-01` beta header; the response reports the served speed
 * in `usage.speed`. Only Claude Opus 5 and Claude Opus 4.8 accept it; other
 * models return an error, so the flag is never sent to them.
 * Source: https://platform.claude.com/docs/en/build-with-claude/fast-mode
 */
export const ANTHROPIC_FAST_MODE_BETA_HEADER = "fast-mode-2026-02-01";

export const ANTHROPIC_FAST_MODE_MODELS = Object.freeze([
  "claude-opus-5",
  "claude-opus-4-8",
] as const);

function normalizeAnthropicModel(model: string): string {
  return model.trim().toLowerCase().replace(/^anthropic[/:]/, "");
}

/** True for the exact fast-mode models and their dated snapshots. */
export function anthropicSupportsFastMode(model: string): boolean {
  const normalized = normalizeAnthropicModel(model);
  return ANTHROPIC_FAST_MODE_MODELS.some(
    (id) => normalized === id || normalized.startsWith(`${id}-20`),
  );
}

/**
 * The session's `service_tier = "priority"` is AgenC's one "Fast" dial: it
 * maps to OpenAI priority processing and, here, to Anthropic fast mode.
 */
export function anthropicFastModeRequested(
  options: { readonly serviceTier?: string } | undefined,
): boolean {
  return options?.serviceTier === "priority";
}
