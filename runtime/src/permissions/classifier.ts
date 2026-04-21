/**
 * T11 Wave 2-A — auto-mode classifier surface.
 *
 * Ports the STUB shape of openclaude's `yoloClassifier.ts` +
 * `classifierDecision.ts`:
 *
 *   - `isAutoModeAllowlistedTool` — safe-tool allowlist consulted by the
 *     evaluator before it invokes the classifier. Tools on this list are
 *     auto-allowed in auto mode with `{fastPath: "allowlist"}`.
 *   - `classifyYoloAction` — async classifier surface. T13 now ships a
 *     narrow runtime-backed implementation for Bash actions and falls back
 *     to manual approval for tools without a live local classifier path.
 *   - `formatActionForClassifier` — deterministic one-line summary of the
 *     action for the classifier prompt (also used in analytics).
 *   - `isAutoModeGateEnabled` — circuit breaker. Default off; overridable
 *     via `__setAutoModeGateResolverForTesting` (tests + T13 integration).
 *
 * Unsupported tools emit a once-per-session warning so operators can tell
 * which requests are still falling back to manual approval.
 *
 * @module
 */

import {
  matchedDangerousLabel,
  shouldUseSandbox,
  type BashPermissionInput,
} from "./bash.js";
import type { ToolPermissionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Safe-tool allowlist
// ---------------------------------------------------------------------------

/**
 * AgenC counterparts to the openclaude safe-tool list. Tool name strings
 * are exactly what the orchestrator dispatches on so rule evaluation
 * lines up with registered tool names.
 *
 * Categories preserved from openclaude:
 *   - Read-only file operations
 *   - Search / read-only
 *   - LSP
 *   - MCP resource read
 *   - Task/agent metadata
 *   - Plan-mode / UI
 *   - Team coordination
 *   - Workflow orchestration
 *   - Internal classifier tool (YoloClassifier)
 */
const SAFE_YOLO_ALLOWLISTED_TOOLS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // Read-only file operations
    "FileRead",
    // Search / read-only
    "Grep",
    "Glob",
    "LSP",
    "ToolSearch",
    // MCP resource read
    "ListMcpResources",
    "ReadMcpResource",
    // Task/agent metadata
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
    "TaskStop",
    "TaskOutput",
    // Plan-mode / UI
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    // Team coordination
    "TeamCreate",
    "TeamDelete",
    "SendMessage",
    // Workflow orchestration
    "Workflow",
    // Misc safe
    "Sleep",
    // Internal classifier tool
    "YoloClassifier",
  ]),
);

export function isAutoModeAllowlistedTool(toolName: string): boolean {
  return SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName);
}

/**
 * Exposed for tests and for T13 wiring verification. Not a public API
 * surface; do not re-export from the barrel.
 */
export function __listAutoModeAllowlistedToolsForTesting(): readonly string[] {
  return Array.from(SAFE_YOLO_ALLOWLISTED_TOOLS);
}

// ---------------------------------------------------------------------------
// Auto-mode gate (stub)
// ---------------------------------------------------------------------------

/**
 * Live circuit breaker for the auto-mode classifier. openclaude wires
 * this to GrowthBook's `tengu_iron_gate_closed` flag. AgenC defaults to
 * false (gate closed → auto mode unavailable) until T13 ships the real
 * circuit breaker.
 */
let autoModeGateResolver: () => boolean = () => false;

export function isAutoModeGateEnabled(): boolean {
  return autoModeGateResolver();
}

export function __setAutoModeGateResolverForTesting(
  resolver: () => boolean,
): () => void {
  const previous = autoModeGateResolver;
  autoModeGateResolver = resolver;
  return () => {
    autoModeGateResolver = previous;
  };
}

// ---------------------------------------------------------------------------
// Classifier result + LLM shim types
// ---------------------------------------------------------------------------

export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

/**
 * Minimal message shape the classifier accepts — transcript items are
 * provided by the orchestrator. Intentionally narrow so callers don't
 * have to reshape to openclaude's `Message` type.
 */
export interface LLMMessage {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: unknown;
}

export interface ToolLike {
  readonly name: string;
}

export interface YoloClassifierResult {
  readonly shouldBlock: boolean;
  readonly reason: string;
  readonly thinking?: string;
  readonly unavailable?: boolean;
  readonly transcriptTooLong?: boolean;
  readonly model: string;
  readonly usage: LLMUsage | null;
  readonly durationMs: number;
  readonly stage: "fast" | "thinking";
  readonly stage1Model?: string;
  readonly stage1Usage?: LLMUsage | null;
  readonly stage1DurationMs?: number;
  readonly stage2Model?: string;
  readonly stage2Usage?: LLMUsage | null;
  readonly stage2DurationMs?: number;
  readonly requestId?: string;
  readonly msgId?: string;
  readonly errorDumpPath?: string;
}

export interface ClassifyYoloActionOpts {
  readonly messages: readonly LLMMessage[];
  readonly action: { readonly toolName: string; readonly input: unknown };
  readonly tools: readonly ToolLike[];
  readonly permissionContext: ToolPermissionContext;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Once-per-session partial-runtime warning
// ---------------------------------------------------------------------------

/**
 * Pluggable warning sink so the daemon can route classifier fallback
 * warnings into its real observability surface (trace events, UI
 * banner, etc.). Default: `console.warn`. Tests replace this with a
 * capture function and reset via `__resetClassifierStubSessionForTesting`.
 */
export type ClassifierWarningSink = (event: {
  readonly cause: string;
  readonly message: string;
  readonly toolName: string;
}) => void;

let warningSink: ClassifierWarningSink = (event) => {
  // Intentional: partial-runtime behavior relies on a single warning.
  // eslint-disable-next-line no-console
  console.warn(`[permissions.classifier] ${event.cause}: ${event.message}`);
};

export function __setClassifierWarningSinkForTesting(
  sink: ClassifierWarningSink,
): () => void {
  const previous = warningSink;
  warningSink = sink;
  return () => {
    warningSink = previous;
  };
}

/**
 * Session-level sentinel so the partial-runtime warning fires exactly once per
 * process regardless of how many times `classifyYoloAction` is called.
 * Tests call `__resetClassifierStubSessionForTesting` to reset.
 */
let stubWarningFired = false;

export function __resetClassifierStubSessionForTesting(): void {
  stubWarningFired = false;
}

// ---------------------------------------------------------------------------
// classifyYoloAction — narrow runtime-backed path
// ---------------------------------------------------------------------------

/**
 * Runtime-backed implementation:
 *
 *   - Bash commands that the local sandbox heuristics already classify as
 *     safe are auto-allowed.
 *   - Bash commands matching the hard-dangerous list are auto-blocked.
 *   - Everything else falls back to manual approval via
 *     `{ shouldBlock: true, unavailable: true }`.
 *
 * This reduces the stub surface without dragging provider-bound side-query
 * wiring into the new permissions modules yet.
 */
export async function classifyYoloAction(
  opts: ClassifyYoloActionOpts,
): Promise<YoloClassifierResult> {
  const started = Date.now();
  const finish = (
    result: Omit<YoloClassifierResult, "durationMs" | "model" | "stage" | "usage"> & {
      readonly model?: string;
      readonly stage?: "fast" | "thinking";
      readonly usage?: LLMUsage | null;
    },
  ): YoloClassifierResult =>
    Object.freeze({
      model: "runtime-heuristic",
      stage: "fast" as const,
      usage: null,
      durationMs: Date.now() - started,
      ...result,
    });

  // Honor an already-aborted signal — callers expect cancellation to be
  // respected inside the classifier as well.
  if (opts.signal?.aborted) {
    return finish({
      shouldBlock: true,
      reason: "runtime_classifier_aborted",
      unavailable: true,
    });
  }

  const bashResult = classifyRuntimeBashAction(opts.action);
  if (bashResult !== null) {
    return finish(bashResult);
  }

  if (!stubWarningFired) {
    stubWarningFired = true;
    warningSink({
      cause: "auto_mode_classifier_partial_runtime",
      message:
        "Auto-mode classifier only has the runtime-backed Bash path; other tools fall back to manual approval.",
      toolName: opts.action.toolName,
    });
  }

  return finish({
    shouldBlock: true,
    reason: `runtime_classifier_manual_approval_required:${opts.action.toolName}`,
    unavailable: true,
  });
}

function classifyRuntimeBashAction(
  action: ClassifyYoloActionOpts["action"],
):
  | {
      readonly shouldBlock: boolean;
      readonly reason: string;
      readonly unavailable?: boolean;
    }
  | null {
  if (action.toolName !== "Bash") return null;
  if (!isBashPermissionInput(action.input)) {
    return {
      shouldBlock: true,
      reason: "runtime_classifier_manual_approval_required:Bash",
      unavailable: true,
    };
  }

  const command = action.input.command.trim();
  if (command.length === 0) {
    return {
      shouldBlock: true,
      reason: "runtime_classifier_manual_approval_required:Bash",
      unavailable: true,
    };
  }

  const dangerLabel = matchedDangerousLabel(command);
  if (dangerLabel !== null) {
    return {
      shouldBlock: true,
      reason: `bash_dangerous:${dangerLabel}`,
    };
  }

  if (shouldUseSandbox(action.input)) {
    return {
      shouldBlock: false,
      reason: "bash_sandbox_safe",
    };
  }

  return {
    shouldBlock: true,
    reason: "runtime_classifier_manual_approval_required:Bash",
    unavailable: true,
  };
}

function isBashPermissionInput(input: unknown): input is BashPermissionInput {
  if (!input || typeof input !== "object") return false;
  return typeof (input as { command?: unknown }).command === "string";
}

// ---------------------------------------------------------------------------
// formatActionForClassifier
// ---------------------------------------------------------------------------

/**
 * Deterministic one-line summary of a tool invocation. Used by the
 * classifier prompt and by analytics. Intentionally simple:
 *
 *   - Tool name
 *   - Compact JSON of the input (stable key order is the caller's
 *     responsibility; most tool inputs come from the model JSON so
 *     they already have stable serialization within a turn).
 *   - Max length capped so runaway inputs don't blow up the classifier
 *     transcript.
 */
const MAX_FORMATTED_ACTION_CHARS = 4_096;

export function formatActionForClassifier(
  toolName: string,
  input: unknown,
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input ?? null);
  } catch {
    serialized = "<unserializable>";
  }
  if (serialized.length > MAX_FORMATTED_ACTION_CHARS) {
    serialized = `${serialized.slice(0, MAX_FORMATTED_ACTION_CHARS)}…`;
  }
  return `${toolName}(${serialized})`;
}
