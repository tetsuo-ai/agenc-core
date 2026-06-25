import type { LLMToolCall } from "../../llm/types.js";
import type { ConcurrencyClass } from "../concurrency.js";
import { classify } from "../concurrency.js";
import type { ToolCallSource, ToolInvocation, ToolPayload } from "../context.js";
import type { ApprovalPolicy, SandboxMode } from "../orchestrator.js";
import type { Tool } from "../types.js";
import type { AdditionalPermissionProfile } from "../../sandbox/engine/index.js";

const TOOL_RUNTIME_CONTEXT_ARG = "__toolRuntimeContext";
const RUNTIME_CONTEXT_MARKER = Symbol("agenc.toolRuntimeContext");

export type ToolRuntimeKind =
  | "custom"
  | "function"
  | "local_shell"
  | "mcp"
  | "tool_search";

export interface ToolRuntimeCallContext {
  readonly callId: string;
  readonly toolName: string;
  readonly runtimeKind: ToolRuntimeKind;
  readonly classification: ConcurrencyClass;
  readonly supportsParallelToolCalls: boolean;
  readonly source: ToolCallSource;
  readonly submittedAtMs: number;
  /**
   * Per-call dispatch signal (childAbort ∪ drainCancel). When present, the
   * runtime guard threads it into Semaphore.acquire / AsyncRwLock.withWrite
   * / withRead so a PARKED waiter wakes immediately on abort, removes itself
   * from the acquire queue atomically, and forwards any in-flight
   * permit/turn. Optional + additive: existing callers compile unchanged.
   */
  readonly acquireSignal?: AbortSignal;
}

export interface ToolRuntimeAttemptContext extends ToolRuntimeCallContext {
  readonly approvalPolicy: ApprovalPolicy;
  readonly requestedSandboxMode: SandboxMode;
  readonly sandboxMode: SandboxMode;
  readonly approvalResolved: boolean;
  readonly additionalPermissions?: AdditionalPermissionProfile;
  readonly rawArgs: string;
  readonly invocation: ToolInvocation;
}

export function runtimeKindForPayload(payload: ToolPayload): ToolRuntimeKind {
  switch (payload.kind) {
    case "custom":
      return "custom";
    case "function":
      return "function";
    case "local_shell":
      return "local_shell";
    case "mcp":
      return "mcp";
    case "tool_search":
      return "tool_search";
  }
}

export function buildToolRuntimeCallContext(params: {
  readonly toolCall: Pick<LLMToolCall, "id" | "name">;
  readonly payload: ToolPayload;
  readonly tool: Tool;
  readonly args: Record<string, unknown>;
  readonly source: ToolCallSource;
  readonly supportsParallelToolCalls?: boolean;
  readonly submittedAtMs?: number;
}): ToolRuntimeCallContext {
  return {
    callId: params.toolCall.id,
    toolName: params.toolCall.name,
    runtimeKind: runtimeKindForPayload(params.payload),
    classification: classify(params.tool, params.args),
    supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
    source: params.source,
    submittedAtMs: params.submittedAtMs ?? performance.now(),
  };
}

export function buildToolRuntimeAttemptContext(
  call: ToolRuntimeCallContext,
  params: {
    readonly approvalPolicy: ApprovalPolicy;
    readonly requestedSandboxMode: SandboxMode;
    readonly sandboxMode: SandboxMode;
    readonly approvalResolved: boolean;
    readonly additionalPermissions?: AdditionalPermissionProfile;
    readonly rawArgs: string;
    readonly invocation: ToolInvocation;
  },
): ToolRuntimeAttemptContext {
  return {
    ...call,
    approvalPolicy: params.approvalPolicy,
    requestedSandboxMode: params.requestedSandboxMode,
    sandboxMode: params.sandboxMode,
    approvalResolved: params.approvalResolved,
    ...(params.additionalPermissions !== undefined
      ? { additionalPermissions: params.additionalPermissions }
      : {}),
    rawArgs: params.rawArgs,
    invocation: params.invocation,
  };
}

export function attachToolRuntimeContext(
  args: Record<string, unknown>,
  context: ToolRuntimeAttemptContext,
): void {
  if ((context as { [RUNTIME_CONTEXT_MARKER]?: unknown })[RUNTIME_CONTEXT_MARKER] !== true) {
    Object.defineProperty(context, RUNTIME_CONTEXT_MARKER, {
      value: true,
      enumerable: false,
      configurable: false,
    });
  }
  Object.defineProperty(args, TOOL_RUNTIME_CONTEXT_ARG, {
    value: context,
    enumerable: false,
    configurable: true,
  });
}

export function readToolRuntimeContext(
  args: Record<string, unknown>,
): ToolRuntimeAttemptContext | undefined {
  const value = args[TOOL_RUNTIME_CONTEXT_ARG];
  if (typeof value !== "object" || value === null) return undefined;
  if ((value as { [RUNTIME_CONTEXT_MARKER]?: unknown })[RUNTIME_CONTEXT_MARKER] !== true) {
    return undefined;
  }
  const candidate = value as Partial<ToolRuntimeAttemptContext>;
  return typeof candidate.callId === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.sandboxMode === "string"
    ? (value as ToolRuntimeAttemptContext)
    : undefined;
}
