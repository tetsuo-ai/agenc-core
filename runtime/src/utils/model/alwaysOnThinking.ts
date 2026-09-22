import { CLAUDE_OPUS_5_5, isClaudeModel } from './claudeModelId.js'

/**
 * Always-on-thinking Claude detection: the Fable/Mythos 5 family
 * (`claude-fable-5`, `claude-mythos-5`, provider spellings like
 * `us.anthropic.agenc-fable-5-v1`, and future minors such as
 * `claude-fable-5-1`) plus Claude Opus 5.5 (`claude-opus-5-5`,
 * Bedrock `anthropic.claude-opus-5-5`).
 *
 * These models have a DIFFERENT Messages API request surface than the
 * adaptive Opus/Sonnet family (Fable verified against provider docs
 * 2026-07-08; Opus 5.5 against the thinking troubleshooting table and the
 * Opus 5.5 migration guide on platform.claude.com, 2026-09-22):
 *
 * - Thinking is ALWAYS ON server-side. The `thinking` request parameter
 *   must be omitted: `{type: "disabled"}` and
 *   `{type: "enabled", budget_tokens: N}` both return a 400
 *   (`{type: "adaptive"}` is accepted but redundant). Depth is controlled
 *   via the effort parameter instead. Claude Opus 5 is NOT in this set: it
 *   still accepts `disabled` at effort `high` or below.
 * - Sampling parameters (`temperature` / `top_p` / `top_k`) are removed
 *   and return a 400 when sent.
 * - Assistant prefill is not supported, and safety classifiers may return
 *   `stop_reason: "refusal"` (HTTP 200) with a `stop_details` object.
 * - Forced `tool_choice` (`any` / `tool`) returns a 400 on Fable 5.1 and
 *   Opus 5.5, so the wire never forces a tool for this set.
 *
 * `claude-mythos-preview` is NOT in this family (it still accepted
 * `budget_tokens`); the digit requirement below excludes it. Opus 5.5 is
 * matched by exact identity through the shared parser, so `claude-opus-5`,
 * its dated snapshots and an unknown `claude-opus-5-50` stay adaptive. Kept
 * dependency-free so the LLM wire layer can import it without dragging in
 * settings/auth state.
 */
export function isAlwaysOnThinkingAnthropicModel(model: string): boolean {
  return (
    /(?:^|[/.-])(?:fable|mythos)-\d{1,2}(?!\d)/.test(model.toLowerCase()) ||
    isClaudeModel(model, CLAUDE_OPUS_5_5)
  )
}
