/**
 * Lean stubs for the tool-execution surfaces `phases/execute-tools.ts`
 * pulls out of `runtime/src/tools/**` (`StreamingToolExecutor`,
 * `ToolCallRuntime`, `routerFromRegistry`, `ToolHookRegistry`).
 *
 * These satisfy the type surface and basic lifecycle the gut phase
 * relies on — construction, queueing, hook registration, draining —
 * so the openclaude port can be deleted without a full rewrite of the
 * tool dispatcher. Real dispatch behaviour (orchestrator approvals,
 * concurrency-class gating, sibling-abort cascade, MCP routing) is
 * reduced to a sequential `registry.dispatch(toolCall)` loop because
 * the lean rebuild has not yet ported those layers.
 *
 * Replace each helper with its real port when the corresponding gut
 * subsystem (orchestrator, router, hooks) lands.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */

import type { LLMToolCall } from "../../llm/types.js";

interface ToolDispatchResultLike {
  readonly content: string;
  readonly isError?: boolean;
}

interface ToolRegistryLike {
  readonly tools: ReadonlyArray<unknown>;
  dispatch(toolCall: LLMToolCall): Promise<ToolDispatchResultLike>;
}

// ─────────────────────────────────────────────────────────────────────
// ToolCallRuntime — concurrency runtime stub
// ─────────────────────────────────────────────────────────────────────

export interface ToolCallRuntimeOpts {
  readonly sharedServerCapacity?: number;
}

export class ToolCallRuntime {
  constructor(_opts: ToolCallRuntimeOpts = {}) {}

  // Permissive run() — phase code constructs a runtime and hands it to
  // the executor; the lean executor does not consult it for gating.
  async run<T>(_klass: unknown, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

// ─────────────────────────────────────────────────────────────────────
// routerFromRegistry — minimal router shell
// ─────────────────────────────────────────────────────────────────────

export interface ToolRouterLike {
  readonly registry: ToolRegistryLike;
}

export function routerFromRegistry(
  registry: ToolRegistryLike,
  _opts: Record<string, unknown> = {},
): ToolRouterLike {
  return { registry };
}

// ─────────────────────────────────────────────────────────────────────
// ToolHookRegistry — typed pre/post/failure/permission hook holder
// ─────────────────────────────────────────────────────────────────────

export type PreToolUseHook = (...args: any[]) => any;
export type PostToolUseHook = (...args: any[]) => any;
export type PostToolUseFailureHook = (...args: any[]) => any;
export type PermissionDecisionHook = (...args: any[]) => any;

export class ToolHookRegistry {
  private pre: PreToolUseHook[] = [];
  private post: PostToolUseHook[] = [];
  private failure: PostToolUseFailureHook[] = [];
  private permission: PermissionDecisionHook[] = [];

  addPre(hook: PreToolUseHook): void {
    this.pre.push(hook);
  }
  addPost(hook: PostToolUseHook): void {
    this.post.push(hook);
  }
  addFailure(hook: PostToolUseFailureHook): void {
    this.failure.push(hook);
  }
  addPermission(hook: PermissionDecisionHook): void {
    this.permission.push(hook);
  }

  getPre(): ReadonlyArray<PreToolUseHook> {
    return this.pre;
  }
  getPost(): ReadonlyArray<PostToolUseHook> {
    return this.post;
  }
  getFailure(): ReadonlyArray<PostToolUseFailureHook> {
    return this.failure;
  }
  getPermission(): ReadonlyArray<PermissionDecisionHook> {
    return this.permission;
  }
}

// ─────────────────────────────────────────────────────────────────────
// StreamingToolExecutor — sequential pass-through
// ─────────────────────────────────────────────────────────────────────

export type ToolStatus = "queued" | "executing" | "completed" | "yielded";

export interface StreamingToolResult {
  readonly toolCall: LLMToolCall;
  readonly result: ToolDispatchResultLike;
  readonly status: "completed" | "synthetic_error";
  readonly durationMs: number;
}

interface TrackedTool {
  readonly id: string;
  readonly toolCall: LLMToolCall;
  status: ToolStatus;
  result?: ToolDispatchResultLike;
}

export interface StreamingToolExecutorOptions {
  readonly registry: ToolRegistryLike;
  readonly abortSignal?: AbortSignal;
  readonly runtime?: ToolCallRuntime;
  readonly onSiblingAbort?: (reason: string) => void;
  readonly liveToolDispatch?: {
    readonly router: ToolRouterLike;
    readonly options: Record<string, unknown>;
  };
  // Permissive overflow for any remaining upstream knobs.
  readonly [extra: string]: unknown;
}

export class StreamingToolExecutor {
  private readonly registry: ToolRegistryLike;
  private readonly abortSignal?: AbortSignal;
  private readonly tools: TrackedTool[] = [];
  private closed = false;

  constructor(opts: StreamingToolExecutorOptions) {
    this.registry = opts.registry;
    this.abortSignal = opts.abortSignal;
  }

  addTool(_block: unknown, toolCall: LLMToolCall): void {
    if (this.closed) return;
    this.tools.push({
      id: toolCall.id,
      toolCall,
      status: "queued",
    });
  }

  close(): void {
    this.closed = true;
  }

  getToolStates(): ReadonlyArray<{
    readonly id: string;
    readonly status: ToolStatus;
    readonly toolName: string;
  }> {
    return this.tools.map((t) => ({
      id: t.id,
      status: t.status,
      toolName: t.toolCall.name,
    }));
  }

  *getCompletedResults(): Generator<StreamingToolResult, void> {
    for (const tool of this.tools) {
      if (tool.status !== "completed" || !tool.result) continue;
      tool.status = "yielded";
      yield {
        toolCall: tool.toolCall,
        result: tool.result,
        status: tool.result.isError ? "synthetic_error" : "completed",
        durationMs: 0,
      };
    }
  }

  async *getRemainingResults(): AsyncGenerator<StreamingToolResult, void> {
    for (const tool of this.tools) {
      if (tool.status === "yielded") continue;
      if (tool.status === "queued") {
        tool.status = "executing";
        try {
          tool.result = await this.registry.dispatch(tool.toolCall);
        } catch (err) {
          tool.result = {
            content: err instanceof Error ? err.message : String(err),
            isError: true,
          };
        }
        tool.status = "completed";
      }
      if (tool.status === "completed" && tool.result) {
        tool.status = "yielded";
        yield {
          toolCall: tool.toolCall,
          result: tool.result,
          status: tool.result.isError ? "synthetic_error" : "completed",
          durationMs: 0,
        };
      }
      if (this.abortSignal?.aborted) return;
    }
  }
}
