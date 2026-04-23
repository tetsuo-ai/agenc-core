/**
 * Per-dir tool-registry shape for `runtime/src/bin/**`.
 *
 * The CLI bootstrap path needs the structural `ToolRegistry` interface
 * + the `BuildToolRegistryOptions` shape. The full registry impl
 * lives in the openclaude-port `runtime/src/tool-registry.ts`; this
 * shim exposes only the minimum types the bin entry point reaches
 * for, plus a permissive `buildToolRegistry` factory.
 *
 * The factory delegates to a deferred lookup at call time so the
 * bin/bootstrap path stays decoupled from the openclaude registry
 * module at type level. When the lean rebuild owns its own registry
 * the inner call site becomes the single migration seam.
 */

import type { Tool } from "./tools-types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMTool = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LLMToolCall = any;

export interface ToolDispatchResult {
  readonly content: string;
  readonly isError?: boolean;
}

export interface ToolRegistry {
  readonly tools: readonly Tool[];
  toLLMTools(): LLMTool[];
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResult>;
}

// Permissive options bag — bin only forwards the caller-supplied
// options through to the underlying registry factory.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BuildToolRegistryOptions = Record<string, any> & {
  readonly workspaceRoot?: string;
  readonly extraTools?: ReadonlyArray<Tool>;
};

/**
 * Permissive registry factory. The lean rebuild has not landed an
 * in-house ToolRegistry yet, so the bin path returns an empty registry
 * by default — child sessions still get a non-null `ToolRegistry`
 * shape and the LLM payload is empty until tool wiring is ported.
 *
 * Caller-supplied `extraTools` are appended to the registry as-is so
 * the bootstrap path can ship its built-in `system.agent.delegate`
 * tool (and any future built-ins) without depending on the deleted
 * openclaude registry. Callers that need full tool dispatch can supply
 * a `BuildToolRegistryOptions.factory` thunk to override entirely.
 */
export function buildToolRegistry(
  options: BuildToolRegistryOptions = {},
): ToolRegistry {
  const factory = (options as { factory?: () => ToolRegistry }).factory;
  if (typeof factory === "function") {
    return factory();
  }
  const tools: Tool[] = [...(options.extraTools ?? [])];
  return {
    tools,
    toLLMTools: () => [],
    dispatch: async (toolCall: LLMToolCall): Promise<ToolDispatchResult> => {
      const name =
        toolCall && typeof toolCall === "object" && "name" in toolCall
          ? String((toolCall as { name?: unknown }).name ?? "")
          : "";
      const tool = tools.find((t) => t.name === name);
      if (tool) {
        const args =
          (toolCall as { arguments?: Record<string, unknown> }).arguments ?? {};
        const result = await tool.execute(args);
        return {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
      }
      return {
        content: "tool registry not wired in lean rebuild",
        isError: true,
      };
    },
  };
}
