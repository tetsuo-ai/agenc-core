/**
 * Ollama provider configuration types
 *
 * @module
 */

import type { LLMProviderConfig } from "../../types.js";

/**
 * Configuration specific to the Ollama local inference provider.
 */
export interface OllamaProviderConfig extends Omit<LLMProviderConfig, "model"> {
  /** Model identifier; defaults to the canonical provider-registry model. */
  model?: string;
  /** Server host URL; defaults to the canonical provider-registry endpoint. */
  host?: string;
  /** Keep model in memory after request (default: '5m') */
  keepAlive?: string;
  /** Context window size */
  numCtx?: number;
  /** Number of GPU layers */
  numGpu?: number;
}
