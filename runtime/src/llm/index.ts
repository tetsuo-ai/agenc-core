/**
 * LLM subsystem barrel — lean rebuild.
 *
 * Pre-gut this file re-exported the whole ChatExecutor/policy/retry
 * stack. That stack is being rewritten in the Tranche 5 loop collapse.
 * For now the barrel exports only the surviving golden pieces: core
 * types + the compaction chain + provider adapters.
 *
 * @module
 */

// Core types
export type {
  LLMProvider,
  LLMProviderConfig,
  LLMContentPart,
  LLMMessage,
  LLMChatOptions,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMUsage,
  MessageRole,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
export { validateToolCall } from "./types.js";

// Provider adapters (kept verbatim — the golden subsystems)
export { GrokProvider, type GrokProviderConfig } from "./grok/index.js";
export { OllamaProvider, type OllamaProviderConfig } from "./ollama/index.js";
