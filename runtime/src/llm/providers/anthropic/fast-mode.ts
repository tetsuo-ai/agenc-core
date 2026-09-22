/**
 * Anthropic fast mode (research preview): the same model served with a
 * faster inference configuration, up to 2.5x output tokens per second at a
 * premium price. On the wire it is `speed: "fast"` plus the
 * `fast-mode-2026-02-01` beta header; the response reports the served speed
 * in `usage.speed`. Only Claude Opus 5.5 ($8/$40 per MTok), Claude Opus 5
 * and Claude Opus 4.8 ($10/$50) accept it, on the Claude API only; other
 * models return an error, so the flag is never sent to them.
 * Source: https://platform.claude.com/docs/en/build-with-claude/fast-mode
 * (Opus 5.5 row checked 2026-09-22).
 */
import { parseClaudeModelId } from "../../../utils/model/claudeModelId.js";

export const ANTHROPIC_FAST_MODE_BETA_HEADER = "fast-mode-2026-02-01";

export const ANTHROPIC_FAST_MODE_MODELS = Object.freeze([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
] as const);

const FAST_MODE_MODEL_IDS: ReadonlySet<string> = new Set(ANTHROPIC_FAST_MODE_MODELS);

/**
 * True for the exact fast-mode models and their dated snapshots, in the
 * Claude API spelling. Identity comes from the shared parser, so
 * `claude-opus-5-5` and `claude-opus-5` never stand in for each other, and
 * Bedrock or Vertex spellings (no fast mode there) never match.
 */
export function anthropicSupportsFastMode(model: string): boolean {
  const id = parseClaudeModelId(model);
  return id !== undefined && id.platform === "anthropic" &&
    FAST_MODE_MODEL_IDS.has(id.canonical);
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
