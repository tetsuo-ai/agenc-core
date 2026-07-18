/**
 * Per-dir tool-registry shape for `runtime/src/agents/**`.
 *
 * The agent runtime needs a structural `ToolRegistry` interface so it
 * can forward tool dispatch from a filtered child registry back to the
 * parent's flat dispatch surface. The full registry implementation
 * lives in the AgenC implementation `runtime/src/tool-registry.ts`; we
 * mirror only the structural contract here so child runners stay
 * decoupled.
 */

import type { Tool } from "./tools-types.js";

// Permissive LLMTool / LLMToolCall shapes — the agent code never inspects
// these fields, it just forwards them to the parent dispatch().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMTool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMToolCall = any;

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly admissionUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
}

export interface ToolRegistry {
  readonly tools: readonly Tool[];
  toLLMTools(): LLMTool[];
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult>;
  getDiscoveredToolNames?(): ReadonlySet<string>;
}
