/**
 * Grok (xAI) provider entrypoint.
 *
 * The implementation still lives in `llm/grok` while the tranche keeps the
 * historical files stable; this module is the canonical provider namespace.
 *
 * @module
 */

export { GrokProvider } from "../../grok/adapter.js";
export type { GrokProviderConfig } from "../../grok/types.js";
