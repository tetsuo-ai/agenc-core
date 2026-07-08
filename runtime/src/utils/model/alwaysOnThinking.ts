/**
 * Claude Fable/Mythos 5 family detection (`claude-fable-5`,
 * `claude-mythos-5`, provider spellings like
 * `us.anthropic.agenc-fable-5-v1`, and future minors such as
 * `claude-fable-5-1`).
 *
 * These models have a DIFFERENT Messages API request surface than the
 * Opus family (verified against provider docs 2026-07-08):
 *
 * - Thinking is ALWAYS ON server-side. The `thinking` request parameter
 *   must be omitted: `{type: "disabled"}` and
 *   `{type: "enabled", budget_tokens: N}` both return a 400
 *   (`{type: "adaptive"}` is accepted but redundant). Depth is controlled
 *   via the effort parameter instead.
 * - Sampling parameters (`temperature` / `top_p` / `top_k`) are removed
 *   and return a 400 when sent.
 * - Assistant prefill is not supported, and safety classifiers may return
 *   `stop_reason: "refusal"` (HTTP 200) with a `stop_details` object.
 *
 * `claude-mythos-preview` is NOT in this family (it still accepted
 * `budget_tokens`); the digit requirement below excludes it. Kept
 * dependency-free so the LLM wire layer can import it without dragging in
 * settings/auth state.
 */
export function isAlwaysOnThinkingAnthropicModel(model: string): boolean {
  return /(?:^|[/.-])(?:fable|mythos)-\d{1,2}(?!\d)/.test(model.toLowerCase())
}
