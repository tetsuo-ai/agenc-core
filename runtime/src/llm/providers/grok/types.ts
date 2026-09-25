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
  /**
   * "oauth" when `apiKey` is the xAI sign-in (Sign in with X) bearer rather
   * than an API key. That route never sends priority processing: xAI's
   * documentation of it covers API-key requests and says nothing about the
   * sign-in grant. Absent means an API key.
   */
  readonly authMode?: "api_key" | "oauth";
  /** Home-bound native OAuth authority for preflight refresh checks. */
  credentialHome?: HomeContext;
  /** API base URL; defaults to the canonical provider-registry endpoint. */
  baseURL?: string;
  readonly fetchImpl?: typeof fetch;
  /** Optional operator override for effective context window budgeting. */
  contextWindowTokens?: number;
  /**
   * Allow the model to emit multiple tool calls in one response (default:
   * true, matching the xAI API default). Set false to force one call per
   * model turn.
   */
  parallelToolCalls?: boolean;
  /**
   * Responses `previous_response_id` continuation on the streaming path. The
   * request builder turns it on for Grok unless
   * `providers.grok.incremental_continuation` (or `AGENC_XAI_INCREMENTAL`) is
   * false; without it, follow-up requests re-upload the full history.
   */
  incrementalContinuation?: boolean;
  /** Vision-capable model to auto-switch to when images are present (default: 'grok-2-vision-1212') */
  visionModel?: string;
}
