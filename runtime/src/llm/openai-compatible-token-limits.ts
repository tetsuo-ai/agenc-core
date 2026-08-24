/**
 * Canonical OpenAI-compatible model-limit authority.
 *
 * The implementation lives with the model utilities used by the interactive
 * runtime. This stable LLM-layer facade deliberately owns no second table or
 * fallback values.
 */

export {
  boundedOutputTokens,
  CAPPED_DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  ESCALATED_MAX_OUTPUT_TOKENS,
  getOpenAICompatibleContextWindow,
  getOpenAICompatibleMaxOutputTokens,
  OPENAI_COMPATIBLE_FALLBACK_CONTEXT_WINDOW,
  type OpenAICompatibleTokenLimitOptions,
} from '../utils/model/openaiContextWindows.js'
