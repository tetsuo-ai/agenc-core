/**
 * Grok provider configuration types
 *
 * @module
 */

import type {
  LLMProviderConfig,
  LLMXaiCapabilitySurface,
} from "../../types.js";
import type { HomeContext } from "../../../config/home.js";

/**
 * Configuration specific to the Grok (xAI) provider.
 * Uses the `openai` SDK pointed at the xAI API.
 */
export interface GrokProviderConfig
  extends LLMProviderConfig,
    LLMXaiCapabilitySurface
{
  /** xAI API key */
  apiKey: string;
  /** Home-bound native OAuth authority for preflight refresh checks. */
  credentialHome?: HomeContext;
  /** API base URL; defaults to the canonical provider-registry endpoint. */
  baseURL?: string;
  /** Optional operator override for effective context window budgeting. */
  contextWindowTokens?: number;
  /**
   * Allow the model to emit multiple tool calls in one response (default:
   * true, matching the xAI API default). Set false to force one call per
   * model turn.
   */
  parallelToolCalls?: boolean;
  /**
   * Opt in to Responses `previous_response_id` continuation on the streaming
   * path (`AGENC_XAI_INCREMENTAL=1` / `providers.grok.incremental_continuation`).
   * Off by default: follow-up requests then re-upload the full history.
   */
  incrementalContinuation?: boolean;
  /** Vision-capable model to auto-switch to when images are present (default: 'grok-2-vision-1212') */
  visionModel?: string;
}
