/**
 * Core tool system types for @tetsuo-ai/runtime
 *
 * Defines the MCP-compatible Tool interface and supporting types
 * that bridge Skills and LLM adapters.
 *
 * @module
 */

import type { FunctionCallOutputContentItem } from "./context.js";
import type { PermissionResult } from "../permissions/types.js";
import type { ToolEvaluatorContext } from "../permissions/evaluator.js";
import type { PermissionDefaultMode } from "../config/schema.js";

/**
 * JSON Schema type alias.
 * Matches LLMTool.function.parameters exactly — zero additional deps.
 */
export type JSONSchema = Record<string, unknown>;

export type ToolSource =
  "builtin" | "mcp" | "plugin" | "skill" | "provider_native";

export type ToolRecoveryCategory =
  "idempotent" | "side-effecting" | "interactive";

export interface ToolMetadata {
  /** Coarse tool family for discovery/ranking. */
  readonly family?: string;
  /** Source of the tool surface. */
  readonly source?: ToolSource;
  /** Discovery keywords. */
  readonly keywords?: readonly string[];
  /** Session profiles this tool is especially suited for. */
  readonly preferredProfiles?: readonly string[];
  /** Hide from default advertised bundles unless explicitly expanded. */
  readonly hiddenByDefault?: boolean;
  /** Whether the tool mutates project/runtime state. */
  readonly mutating?: boolean;
  /**
   * Tool performs no *arg-directed* filesystem writes — it mutates only
   * in-memory / runtime state, or writes to a fixed runtime-derived path the
   * model cannot steer (e.g. ExitPlanMode persisting the plan file to a
   * sanitized `<agenc-home>/plans/<random-slug>.md` outside the workspace).
   * Exempts it from the FS-write sandbox (workspace_write/read_only)
   * indeterminate-target denial in enforceRuntimeSandboxAttempt.
   *
   * MUST be false for anything that can write a model-controlled path or
   * execute arbitrary code/shell. The exemption is trusted ONLY because each
   * opted-in tool was hand-audited (see enforceRuntimeSandboxAttempt) — it is
   * not a structural guarantee, so adding it requires reading the tool's
   * execute() and confirming no arg-steerable write. Audit surface: grep
   * `virtualNoFsWrites`.
   */
  readonly virtualNoFsWrites?: boolean;
  /**
   * When `true`, the tool is omitted from the outgoing tools array sent
   * to the provider unless the model has explicitly discovered it via
   * `system.searchTools` in this turn. Mirrors the reference runtime's
   * `defer_loading` flag: heavy specialist tools (marketplace mutations,
   * browser sessions, office/pdf/calendar/email, http, sandbox, etc.)
   * stay deferred so the default per-call tool catalog is the small
   * subset a coding agent actually needs, while the full catalog
   * remains discoverable on demand.
   */
  readonly deferred?: boolean;
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly metadata: Required<
    Pick<
      ToolMetadata,
      "family" | "source" | "hiddenByDefault" | "mutating" | "deferred"
    >
  > &
    Pick<ToolMetadata, "keywords" | "preferredProfiles">;
}

/**
 * Result returned by a tool execution.
 *
 * `content` is a string because both `ToolHandler` (LLM system) and
 * MCP specify text content for tool results.
 */
export interface ToolResult {
  /** Result content — JSON string for structured data, plain text otherwise */
  content: string;
  /** True if execution failed (error message in content) */
  isError?: boolean;
  /** Structured value returned to nested code-mode callers. */
  codeModeResult?: unknown;
  /** Rich content items for providers that support multimodal tool outputs. */
  contentItems?: readonly FunctionCallOutputContentItem[];
  /** Optional metadata for logging — not sent to LLMs */
  metadata?: Record<string, unknown>;
  /** Authoritative metered usage for this tool invocation, when charged. */
  admissionUsage?: ToolAdmissionUsage;
}

export interface ToolAdmissionEstimate {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** Null records an explicitly unpriced external charge. */
  readonly maxCostUsd: number | null;
}

export interface ToolAdmissionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/**
 * Non-enumerable execution-only fields injected by `runToolUse()`.
 *
 * Tools may read these directly from the `args` object when they need
 * streaming progress or hard-cancel support, but they must not depend
 * on them being present for correctness.
 */
export interface ToolExecutionInjectedArgs {
  readonly __onProgress?: (event: {
    readonly chunk: string;
    readonly stream?: "stdout" | "stderr" | "status";
    readonly processId?: number;
  }) => void;
  readonly __abortSignal?: AbortSignal;
  readonly __callId?: string;
  readonly __toolRuntimeContext?: import("./runtimes/context.js").ToolRuntimeAttemptContext;
}

/**
 * MCP-compatible tool interface.
 *
 * Tools are the atomic unit of functionality exposed to LLM agents.
 * They can be converted to `LLMTool[]` for provider configs and
 * dispatched via `ToolHandler` for the executor.
 */
export interface Tool {
  /** Namespaced tool name (e.g. "jupiter.getQuote", "agenc.listTasks") */
  readonly name: string;
  /** Human-readable description for LLM consumption */
  readonly description: string;
  /** JSON Schema describing the input parameters */
  readonly inputSchema: JSONSchema;
  /** Optional discovery/routing metadata. */
  readonly metadata?: ToolMetadata;
  /** Execute the tool with the given arguments */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
  /**
   * Conservative per-invocation charge bound for the execution kernel.
   * Omit only for locally executed, non-metered tools. Returning a null cost
   * keeps the operation visible but makes it fail closed under a hard USD cap.
   */
  readonly admissionEstimate?: (
    args: Readonly<Record<string, unknown>>,
  ) => ToolAdmissionEstimate;

  // ── T7 concurrency + limits ──────────────────────────────────────
  /**
   * T7 `ConcurrencyClass` tag. Undefined → treated as `Exclusive` by
   * `classify()`. Import ConcurrencyClass from `runtime/src/tools/concurrency.ts`.
   */
  readonly concurrencyClass?: import("./concurrency.js").ConcurrencyClass;
  /**
   * Per-call downgrade hook (AgenC pattern). Return `true` when
   * the specific invocation is safe to run concurrently; `false` or
   * `throw` downgrades to `Exclusive`.
   */
  readonly isConcurrencySafe?: (args: Record<string, unknown>) => boolean;
  /** I-9 per-tool timeout override (ms). Falls back to
   *  `DEFAULT_TOOL_TIMEOUT_MS=30_000` when absent. */
  readonly timeoutMs?: number;
  /**
   * Timeout ownership. `executor` means the generic tool executor
   * enforces `timeoutMs`; `tool` means the tool handler has its own
   * timeout semantics and the executor should only preserve aborts.
   */
  readonly timeoutBehavior?: "executor" | "tool";
  /** I-15 per-tool result size cap (bytes). Falls back to
   *  `DEFAULT_MAX_TOOL_RESULT_BYTES=400_000` when absent. */
  readonly maxResultBytes?: number;
  /** MCP-style server id when the tool's class is `shared_server`. */
  readonly serverId?: string;
  /** Router flag: whether this tool supports the model's
   *  `parallel_tool_calls` request knob. Used by `router.ts`. */
  readonly supportsParallelToolCalls?: boolean;
  /** Orchestrator hint: `true` → orchestrator.classifyToolApproval
   *  treats the tool as read-only under `granular` policy. */
  readonly isReadOnly?: boolean;
  /** Orchestrator hint: `true` → under `on_request` policy the tool
   *  always requires user approval. */
  readonly requiresApproval?: boolean;
  /**
   * Optional per-tool default approval mode from `tools_config`.
   * Uses the config-file literals (`on-request`, `on-failure`) and is
   * mapped to the orchestrator's internal approval policy at dispatch.
   */
  readonly defaultPermissionMode?: PermissionDefaultMode;
  /**
   * AgenC behavior: tools that must collect interactive user input
   * can force an approval/user-interaction prompt even when the current
   * permission mode would otherwise bypass normal approvals.
   */
  readonly requiresUserInteraction?: () => boolean;
  /**
   * Daemon restart policy for a tool call left in-flight by a crash.
   * Missing categories are treated as side-effecting.
   */
  readonly recoveryCategory?: ToolRecoveryCategory;
  /**
   * Optional AgenC-style permission hook. The permissions evaluator
   * calls this before the generic mode gate so tools can request asks,
   * denies, or updated inputs based on their own arguments.
   */
  readonly checkPermissions?: (
    input: unknown,
    context: ToolEvaluatorContext,
  ) => PermissionResult | Promise<PermissionResult>;
  /**
   * AgenC behavior: how this tool should respond to a user
   * 'interrupt' abort (typed message mid-turn). `'cancel'` → the
   * executor synthesizes a `user_interrupted` terminal result and
   * stops the tool. `'block'` → the tool is allowed to finish; the
   * interrupt does not cancel it. Omitting the field defaults to
   * `'block'` — conservative, matches AgenC default.
   */
  readonly interruptBehavior?: () => "cancel" | "block";
}

/**
 * Bigint-safe JSON replacer.
 *
 * Use with `JSON.stringify` for any data that may contain bigint values
 * (e.g. lamport amounts, capability masks). Without this, `JSON.stringify`
 * throws `TypeError: Do not know how to serialize a BigInt`.
 */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Bigint-safe `JSON.stringify` wrapper.
 *
 * Equivalent to `JSON.stringify(value, bigintReplacer)`.
 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}
