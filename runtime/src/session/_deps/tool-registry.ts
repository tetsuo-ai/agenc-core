/**
 * Per-dir tool-registry shape for `runtime/src/session/**`.
 *
 * Session only references the structural `ToolRegistry` interface
 * from the AgenC `runtime/src/tool-registry.ts`. Carved as a
 * local `_deps/` so the gut session tree stays decoupled when the
 * root tool-registry is removed.
 */

import type { FunctionCallOutputContentItem } from "../../tools/context.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMTool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMToolCall = any;

export type JSONSchema = Record<string, unknown>;

export interface ToolResult {
  content: string;
  isError?: boolean;
  codeModeResult?: unknown;
  contentItems?: readonly FunctionCallOutputContentItem[];
  metadata?: Record<string, unknown>;
}

// Permissive Tool shape; mirrors `agents/_deps/tools-types.ts` so the
// child registry built by `agents/run-agent.ts::buildFilteredRegistry`
// can consume `session.services.registry` without a structural mismatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
} & Record<string, any>;

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly codeModeResult?: unknown;
  readonly contentItems?: readonly FunctionCallOutputContentItem[];
}

export interface ToolRegistry {
  readonly tools: readonly Tool[];
  toLLMTools(): LLMTool[];
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult>;
  getDiscoveredToolNames?(): ReadonlySet<string>;
}
