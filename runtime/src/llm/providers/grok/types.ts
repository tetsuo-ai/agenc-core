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
  /** Allow the model to emit multiple tool calls in parallel (default: false). */
  parallelToolCalls?: boolean;
  /** Vision-capable model to auto-switch to when images are present (default: 'grok-2-vision-1212') */
  visionModel?: string;
}
