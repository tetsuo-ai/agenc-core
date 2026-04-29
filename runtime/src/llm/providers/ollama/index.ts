/**
 * Ollama provider entrypoint.
 *
 * The implementation still lives in `llm/ollama` while the tranche keeps the
 * historical files stable; this module is the canonical provider namespace.
 *
 * @module
 */

export { OllamaProvider } from "../../ollama/adapter.js";
export type { OllamaProviderConfig } from "../../ollama/types.js";
