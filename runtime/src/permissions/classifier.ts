/**
 * T11 Wave 2-A — auto-mode classifier surface.
 *
 * Ports the STUB shape of openclaude's `yoloClassifier.ts` +
 * `classifierDecision.ts`:
 *
 *   - `isAutoModeAllowlistedTool` — safe-tool allowlist consulted by the
 *     evaluator before it invokes the classifier. Tools on this list are
 *     auto-allowed in auto mode with `{fastPath: "allowlist"}`.
 *   - `classifyYoloAction` — async 2-stage classifier. T11 ships a STUB
 *     that always returns `{ shouldBlock: false, unavailable: true }` so
 *     the live gate is effectively closed. T13 wires the real xAI /
 *     Anthropic Haiku call here.
 *   - `formatActionForClassifier` — deterministic one-line summary of the
 *     action for the classifier prompt (also used in analytics).
 *   - `isAutoModeGateEnabled` — circuit breaker. Default off; overridable
 *     via `__setAutoModeGateResolverForTesting` (tests + T13 integration).
 *
 * The stub emits a once-per-session warning so operators can tell that
 * auto-mode is not actually wired yet.
 *
 * @module
 */

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
// Once-per-session stub warning
// ---------------------------------------------------------------------------

/**
 * Pluggable warning sink so the daemon can route classifier-stubbed
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
  // Intentional: stub runtime behavior relies on a single warning.
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
 * Session-level sentinel so the stub warning fires exactly once per
 * process regardless of how many times `classifyYoloAction` is called.
 * Tests call `__resetClassifierStubSessionForTesting` to reset.
 */
let stubWarningFired = false;

export function __resetClassifierStubSessionForTesting(): void {
  stubWarningFired = false;
}

// ---------------------------------------------------------------------------
// classifyYoloAction — stub
// ---------------------------------------------------------------------------

/**
 * STUB implementation. Always returns `unavailable: true` with a stable
 * reason that points at T13. The evaluator treats an unavailable
 * classifier as fail-closed-or-open depending on the gate. Because
 * `isAutoModeGateEnabled()` is false by default, the fail-closed branch
 * is never taken in production; the evaluator falls back to normal ask.
 *
 * T13 is expected to replace this function with a real xAI/Haiku call
 * that honors `opts.signal` and returns a structured result.
 */
export async function classifyYoloAction(
  opts: ClassifyYoloActionOpts,
): Promise<YoloClassifierResult> {
  const started = Date.now();

  if (!stubWarningFired) {
    stubWarningFired = true;
    warningSink({
      cause: "auto_mode_classifier_stubbed",
      message:
        "Auto-mode classifier is stubbed (T11). Real classifier call lands in T13; treating requests as unavailable.",
      toolName: opts.action.toolName,
    });
  }

  // Honor an already-aborted signal — callers expect cancellation to be
  // respected even inside the stub.
  if (opts.signal?.aborted) {
    const durationMs = Date.now() - started;
    return Object.freeze({
      shouldBlock: true,
      reason: "classifier_stubbed_t13_aborted",
      unavailable: true,
      model: "stub",
      usage: null,
      durationMs,
      stage: "fast" as const,
    });
  }

  const durationMs = Date.now() - started;
  return Object.freeze({
    shouldBlock: false,
    reason: "classifier_stubbed_t13",
    unavailable: true,
    model: "stub",
    usage: null,
    durationMs,
    stage: "fast" as const,
  });
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
