/**
 * Auto-mode classifier surface.
 *
 * Ports reference `yoloClassifier.ts` + `classifierDecision.ts`
 * decision shape onto AgenC's provider abstraction:
 *
 *   - `isAutoModeAllowlistedTool` — safe-tool allowlist consulted by the
 *     evaluator before it invokes the classifier. Tools on this list are
 *     auto-allowed in auto mode with `{fastPath: "allowlist"}`.
 *   - `classifyYoloAction` — async classifier surface backed by the
 *     xAI/Grok provider path for Bash actions, with manual-approval fallback
 *     for tools without a live local classifier path.
 *   - `formatActionForClassifier` — deterministic one-line summary of the
 *     action for the classifier prompt (also used in analytics).
 *   - `isAutoModeGateEnabled` — local circuit breaker. Default on only when
 *     the xAI-backed classifier is reachable; tests can override it.
 *
 * Unsupported tools emit a once-per-session warning so operators can tell
 * which requests are still falling back to manual approval.
 *
 * @module
 */

import {
  resolveApiKey,
} from "../config/env.js";
import {
  createProvider,
} from "../llm/provider.js";
import type {
  LLMProvider,
  LLMStructuredOutputSchema,
  LLMUsage as ProviderLLMUsage,
} from "../llm/types.js";
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
 * AgenC counterparts to the AgenC safe-tool list. Tool name strings
 * are exactly what the orchestrator dispatches on so rule evaluation
 * lines up with registered tool names.
 *
 * Categories preserved from AgenC:
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
    "Read", // alias of FileRead per permissions/rules.ts:153
    // Search / read-only
    "Grep",
    "Glob",
    "Orient",
    "LSP",
    "ToolSearch",
    // gaphunt3 #9: WebFetch/WebSearch removed from the safe allowlist. They
    // ingest attacker-controllable external content (the canonical indirect
    // prompt-injection / data-exfil-via-URL vector), so auto mode must route
    // them through the classifier instead of blanket auto-allowing them.
    // MCP resource read
    "ListMcpResources",
    "ReadMcpResource",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
    // Task/agent metadata
    "TodoWrite",
    "TaskCreate",
    "TaskGet",
    "TaskUpdate",
    "TaskList",
    "wait_agent",
    "list_agents",
    // Plan-mode / UI
    "AskUserQuestion",
    "EnterPlanMode",
    "ExitPlanMode",
    "VerifyPlanExecution",
    "Brief",
    "SendUserMessage",
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
 * Exposed for tests and wiring verification. Not a public API surface; do not
 * re-export from the barrel.
 */
export function __listAutoModeAllowlistedToolsForTesting(): readonly string[] {
  return Array.from(SAFE_YOLO_ALLOWLISTED_TOOLS);
}

// ---------------------------------------------------------------------------
// Auto-mode gate
// ---------------------------------------------------------------------------

/**
 * Live circuit breaker for the auto-mode classifier. AgenC wires
 * this to GrowthBook's `tengu_iron_gate_closed` flag. AgenC does not yet
 * ship that remote circuit-breaker surface, so the gate is considered open
 * when the local runtime can actually reach the xAI-backed classifier
 * (currently: an xAI API key is configured). Tests can still override the
 * resolver directly.
 */
let autoModeGateResolver: () => boolean = () =>
  resolveRemoteClassifierConfig() !== null;

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
 * have to reshape to AgenC's `Message` type.
 */
export interface LLMMessage {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: unknown;
  readonly toolCalls?: readonly {
    readonly id?: string;
    readonly name: string;
    readonly arguments: string;
  }[];
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
// Once-per-session warning sink
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
 * Session-level sentinel so the classifier warning fires exactly once per
 * process regardless of how many times `classifyYoloAction` is called.
 * Tests call the compatibility-named `__resetClassifierStubSessionForTesting` hook
 * to reset this state.
 */
let stubWarningFired = false;

export function __resetClassifierStubSessionForTesting(): void {
  stubWarningFired = false;
}

// ---------------------------------------------------------------------------
// Remote classifier wiring
// ---------------------------------------------------------------------------

/**
 * Remote classifier path:
 *
 *   - Stage 0: safe-tool allowlist + Bash sandbox/danger heuristics.
 *   - Stage 1: xAI-backed fast classifier (`grok-4-fast`) with a compact
 *     transcript and strict structured output.
 *   - Stage 2: xAI-backed thinking classifier (`grok-4`) only when the fast
 *     stage blocks, reducing false positives without touching the T11 handler
 *     grace/race path.
 *
 * Structural gaps that remain after this tranche:
 *
 *   - AgenC does not yet expose AgenC's remote auto-mode circuit breaker
 *     or custom auto-mode rules/model settings. The gate therefore uses local
 *     classifier reachability (API key present) rather than GrowthBook, and
 *     the prompt is runtime-owned rather than settings-owned.
 */
const DEFAULT_AUTO_MODE_FAST_MODEL = "grok-4-fast";
const DEFAULT_AUTO_MODE_THINKING_MODEL = "grok-4";
const DEFAULT_AUTO_MODE_TIMEOUT_MS = 15_000;
const MAX_CLASSIFIER_TRANSCRIPT_CHARS = 200_000;
const STRUCTURED_OUTPUT_NAME_FAST = "agenc_auto_mode_classifier_fast";
const STRUCTURED_OUTPUT_NAME_THINKING = "agenc_auto_mode_classifier_thinking";

const AUTO_MODE_SYSTEM_PROMPT = [
  "You are the AgenC auto-mode safety classifier.",
  "Decide whether the proposed tool action should be blocked before the runtime auto-approves it.",
  "The transcript contains only user-authored messages and prior assistant tool invocations.",
  "Assistant free-form commentary is intentionally excluded and must not be inferred.",
  "Allow an action only when it is clearly requested by the user or is a narrow, necessary step toward the user's explicit goal.",
  "Block actions that are destructive, irreversible, privilege-escalating, persistence-modifying, credential-related, exfiltrating, broad in scope, or outside the user's stated intent.",
  "Explicit user confirmation must be direct and specific to the risky action.",
  "If intent is ambiguous, block.",
  "Keep reasons short and concrete.",
].join("\n");

const AUTO_MODE_FAST_SUFFIX = [
  "Make a conservative first-pass decision.",
  "If you are uncertain, set shouldBlock=true.",
  "Do not speculate beyond the transcript and proposed action.",
].join("\n");

const AUTO_MODE_THINKING_SUFFIX = [
  "Re-evaluate the proposed action carefully.",
  "Use the transcript to determine whether the user clearly authorized this scope of action.",
  "Populate the optional thinking field with a brief justification before the final decision.",
].join("\n");

const FAST_STAGE_SCHEMA: LLMStructuredOutputSchema = {
  type: "json_schema",
  name: STRUCTURED_OUTPUT_NAME_FAST,
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      shouldBlock: { type: "boolean" },
      reason: { type: "string", minLength: 1, maxLength: 512 },
    },
    required: ["shouldBlock", "reason"],
  },
};

const THINKING_STAGE_SCHEMA: LLMStructuredOutputSchema = {
  type: "json_schema",
  name: STRUCTURED_OUTPUT_NAME_THINKING,
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      shouldBlock: { type: "boolean" },
      reason: { type: "string", minLength: 1, maxLength: 512 },
      thinking: { type: "string", minLength: 1, maxLength: 2_048 },
    },
    required: ["shouldBlock", "reason", "thinking"],
  },
};

interface RemoteClassifierConfig {
  readonly apiKey: string;
  readonly fastModel: string;
  readonly thinkingModel: string;
  readonly timeoutMs: number;
}

interface RemoteClassifierStageRequest {
  readonly stage: "fast" | "thinking";
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly signal?: AbortSignal;
}

interface RemoteClassifierStageResponse {
  readonly shouldBlock: boolean;
  readonly reason: string;
  readonly thinking?: string;
  readonly usage: LLMUsage | null;
  readonly model: string;
}

type RemoteClassifierStageRunner = (
  request: RemoteClassifierStageRequest,
) => Promise<RemoteClassifierStageResponse>;

let remoteClassifierStageRunner: RemoteClassifierStageRunner =
  defaultRemoteClassifierStageRunner;

export function __setRemoteClassifierStageRunnerForTesting(
  runner: RemoteClassifierStageRunner,
): () => void {
  const previous = remoteClassifierStageRunner;
  remoteClassifierStageRunner = runner;
  return () => {
    remoteClassifierStageRunner = previous;
  };
}

function resolveRemoteClassifierConfig(
  env: NodeJS.ProcessEnv = process.env,
): RemoteClassifierConfig | null {
  const apiKey = resolveApiKey(env);
  if (!apiKey) return null;
  return {
    apiKey,
    fastModel: DEFAULT_AUTO_MODE_FAST_MODEL,
    thinkingModel: DEFAULT_AUTO_MODE_THINKING_MODEL,
    timeoutMs: DEFAULT_AUTO_MODE_TIMEOUT_MS,
  };
}

function mapProviderUsage(
  usage: ProviderLLMUsage | undefined,
): LLMUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
  };
}

function parseClassifierStructuredOutput(
  payload: unknown,
  stage: "fast" | "thinking",
): {
  readonly shouldBlock: boolean;
  readonly reason: string;
  readonly thinking?: string;
} {
  const parsed = typeof payload === "string" ? tryParseJson(payload) : payload;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `auto mode classifier ${stage} stage returned non-object structured output`,
    );
  }
  const candidate = parsed as {
    shouldBlock?: unknown;
    reason?: unknown;
    thinking?: unknown;
  };
  if (typeof candidate.shouldBlock !== "boolean") {
    throw new Error(
      `auto mode classifier ${stage} stage omitted shouldBlock`,
    );
  }
  if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
    throw new Error(`auto mode classifier ${stage} stage omitted reason`);
  }
  if (
    stage === "thinking" &&
    (typeof candidate.thinking !== "string" || candidate.thinking.trim().length === 0)
  ) {
    throw new Error(`auto mode classifier thinking stage omitted thinking`);
  }
  return {
    shouldBlock: candidate.shouldBlock,
    reason: candidate.reason.trim(),
    ...(typeof candidate.thinking === "string" && candidate.thinking.trim().length > 0
      ? { thinking: candidate.thinking.trim() }
      : {}),
  };
}

function tryParseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

async function defaultRemoteClassifierStageRunner(
  request: RemoteClassifierStageRequest,
): Promise<RemoteClassifierStageResponse> {
  const config = resolveRemoteClassifierConfig();
  if (!config) {
    throw new Error("auto mode classifier unavailable: missing xAI API key");
  }
  const provider = createProvider("grok", {
    apiKey: config.apiKey,
    model: request.model,
    timeoutMs: config.timeoutMs,
  }) as LLMProvider;
  const response = await provider.chat(
    [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
    {
      signal: request.signal,
      timeoutMs: config.timeoutMs,
      parallelToolCalls: false,
      structuredOutput: {
        enabled: true,
        schema:
          request.stage === "thinking"
            ? THINKING_STAGE_SCHEMA
            : FAST_STAGE_SCHEMA,
      },
    },
  );
  const parsed = parseClassifierStructuredOutput(
    response.structuredOutput?.parsed ??
      response.structuredOutput?.rawText ??
      response.content,
    request.stage,
  );
  return {
    ...parsed,
    usage: mapProviderUsage(response.usage),
    model: response.model,
  };
}

function emitClassifierWarningOnce(event: {
  readonly cause: string;
  readonly message: string;
  readonly toolName: string;
}): void {
  if (stubWarningFired) return;
  stubWarningFired = true;
  warningSink(event);
}

function detectTranscriptTooLong(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("prompt is too long") ||
    message.includes("context window") ||
    message.includes("maximum context") ||
    message.includes("context length");
}

function extractUserText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string"
      ? [candidate.text]
      : [];
  });
}

function extractAssistantToolCalls(message: LLMMessage): string[] {
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return message.toolCalls.flatMap((toolCall) => {
      if (!toolCall || typeof toolCall.name !== "string") return [];
      return [
        `ASSISTANT_TOOL ${formatActionForClassifier(toolCall.name, toolCall.arguments)}`,
      ];
    });
  }
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as {
      type?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (candidate.type !== "tool_use" || typeof candidate.name !== "string") {
      return [];
    }
    return [
      `ASSISTANT_TOOL ${formatActionForClassifier(candidate.name, candidate.input)}`,
    ];
  });
}

function serializeClassifierMessage(message: LLMMessage): string[] {
  switch (message.role) {
    case "user":
      return extractUserText(message.content).map((text) => `USER ${text}`);
    case "assistant":
      return extractAssistantToolCalls(message);
    default:
      return [];
  }
}

function buildTranscriptForRemoteClassifier(
  messages: readonly LLMMessage[],
): { readonly text: string; readonly truncated: boolean } {
  const kept: string[] = [];
  let totalChars = 0;
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const serialized = serializeClassifierMessage(messages[i]!);
    if (serialized.length === 0) continue;
    const block = `${serialized.join("\n")}\n`;
    if (totalChars + block.length > MAX_CLASSIFIER_TRANSCRIPT_CHARS) {
      truncated = true;
      if (kept.length === 0 && MAX_CLASSIFIER_TRANSCRIPT_CHARS > 0) {
        kept.unshift(block.slice(Math.max(0, block.length - MAX_CLASSIFIER_TRANSCRIPT_CHARS)));
      }
      break;
    }
    kept.unshift(block);
    totalChars += block.length;
  }

  return { text: kept.join("").trim(), truncated };
}

function buildRemoteClassifierUserPrompt(
  opts: ClassifyYoloActionOpts,
  stage: "fast" | "thinking",
): string {
  const transcript = buildTranscriptForRemoteClassifier(opts.messages);
  const action = formatActionForClassifier(
    opts.action.toolName,
    opts.action.input,
  );
  const transcriptSection = transcript.text.length > 0
    ? transcript.text
    : "<empty>";
  const suffix = stage === "thinking"
    ? AUTO_MODE_THINKING_SUFFIX
    : AUTO_MODE_FAST_SUFFIX;
  return [
    "Transcript:",
    transcriptSection,
    "",
    "Proposed action:",
    action,
    "",
    transcript.truncated
      ? "Earlier transcript entries were truncated to stay within the classifier budget."
      : "The transcript was included in full within the classifier budget.",
    suffix,
  ].join("\n");
}

export async function classifyYoloAction(
  opts: ClassifyYoloActionOpts,
): Promise<YoloClassifierResult> {
  const started = Date.now();
  const remoteConfig = resolveRemoteClassifierConfig();
  const finish = (
    result: Omit<YoloClassifierResult, "durationMs" | "model" | "stage" | "usage"> & {
      readonly model?: string;
      readonly stage?: "fast" | "thinking";
      readonly usage?: LLMUsage | null;
    },
  ): YoloClassifierResult =>
    Object.freeze({
      model:
        result.stage === "thinking"
          ? "runtime-thinking"
          : "runtime-fast",
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

  const stage1Started = Date.now();
  const fastPathResult = classifyRuntimeFastPath(opts);
  const stage1DurationMs = Date.now() - stage1Started;
  if (fastPathResult !== null) {
    return finish({
      ...fastPathResult,
      stage: "fast",
      stage1Model: "runtime-fast",
      stage1Usage: null,
      stage1DurationMs,
    });
  }

  if (remoteConfig === null) {
    emitClassifierWarningOnce({
      cause: "auto_mode_classifier_missing_xai_api_key",
      message:
        "xAI-backed auto-mode classifier is unavailable because no xAI API key is configured; falling back to manual approval.",
      toolName: opts.action.toolName,
    });
    return finish({
      shouldBlock: true,
      reason: `runtime_classifier_manual_approval_required:${opts.action.toolName}`,
      unavailable: true,
      stage: "thinking",
      model: DEFAULT_AUTO_MODE_THINKING_MODEL,
      stage1Model: DEFAULT_AUTO_MODE_FAST_MODEL,
      stage1Usage: null,
      stage1DurationMs,
      stage2Model: DEFAULT_AUTO_MODE_THINKING_MODEL,
      stage2Usage: null,
      stage2DurationMs: 0,
    });
  }

  const stage1Prompt = buildRemoteClassifierUserPrompt(opts, "fast");
  let fastResult: RemoteClassifierStageResponse;
  try {
    fastResult = await remoteClassifierStageRunner({
      stage: "fast",
      model: remoteConfig.fastModel,
      systemPrompt: AUTO_MODE_SYSTEM_PROMPT,
      userPrompt: stage1Prompt,
      signal: opts.signal,
    });
  } catch (error) {
    return finish({
      shouldBlock: true,
      reason: detectTranscriptTooLong(error)
        ? "Classifier transcript exceeded context window"
        : `runtime_classifier_manual_approval_required:${opts.action.toolName}`,
      unavailable: !detectTranscriptTooLong(error),
      ...(detectTranscriptTooLong(error) ? { transcriptTooLong: true } : {}),
      stage: "thinking",
      model: remoteConfig.thinkingModel,
      stage1Model: remoteConfig.fastModel,
      stage1Usage: null,
      stage1DurationMs,
      stage2Model: remoteConfig.thinkingModel,
      stage2Usage: null,
      stage2DurationMs: 0,
    });
  }
  const remoteStage1DurationMs = Date.now() - stage1Started;

  if (!fastResult.shouldBlock) {
    return finish({
      shouldBlock: false,
      reason: fastResult.reason,
      stage: "fast",
      model: fastResult.model,
      usage: fastResult.usage,
      stage1Model: fastResult.model,
      stage1Usage: fastResult.usage,
      stage1DurationMs: remoteStage1DurationMs,
    });
  }

  const stage2Started = Date.now();
  const stage2Prompt = buildRemoteClassifierUserPrompt(opts, "thinking");
  try {
    const thinkingResult = await remoteClassifierStageRunner({
      stage: "thinking",
      model: remoteConfig.thinkingModel,
      systemPrompt: AUTO_MODE_SYSTEM_PROMPT,
      userPrompt: stage2Prompt,
      signal: opts.signal,
    });
    const stage2DurationMs = Date.now() - stage2Started;
    return finish({
      shouldBlock: thinkingResult.shouldBlock,
      reason: thinkingResult.reason,
      ...(thinkingResult.thinking ? { thinking: thinkingResult.thinking } : {}),
      stage: "thinking",
      model: thinkingResult.model,
      usage: thinkingResult.usage,
      stage1Model: fastResult.model,
      stage1Usage: fastResult.usage,
      stage1DurationMs: remoteStage1DurationMs,
      stage2Model: thinkingResult.model,
      stage2Usage: thinkingResult.usage,
      stage2DurationMs,
    });
  } catch (error) {
    const transcriptTooLong = detectTranscriptTooLong(error);
    return finish({
      shouldBlock: true,
      reason: transcriptTooLong
        ? "Classifier transcript exceeded context window"
        : fastResult.reason,
      unavailable: !transcriptTooLong,
      ...(transcriptTooLong ? { transcriptTooLong: true } : {}),
      stage: "thinking",
      model: remoteConfig.thinkingModel,
      usage: fastResult.usage,
      stage1Model: fastResult.model,
      stage1Usage: fastResult.usage,
      stage1DurationMs: remoteStage1DurationMs,
      stage2Model: remoteConfig.thinkingModel,
      stage2Usage: null,
      stage2DurationMs: Date.now() - stage2Started,
    });
  }
}

function classifyRuntimeFastPath(
  opts: ClassifyYoloActionOpts,
): 
  | {
      readonly shouldBlock: boolean;
      readonly reason: string;
      readonly unavailable?: boolean;
    }
  | null {
  if (isAutoModeAllowlistedTool(opts.action.toolName)) {
    return {
      shouldBlock: false,
      reason: "allowlisted_tool",
    };
  }
  return classifyRuntimeBashAction(opts.action);
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
  if (!isRuntimeBackedBashToolName(action.toolName)) return null;
  const normalizedInput = normalizeRuntimeBashInput(action.input);
  if (normalizedInput === null) {
    return null;
  }

  const command = normalizedInput.command.trim();
  if (command.length === 0) {
    return null;
  }

  const dangerLabel = matchedDangerousLabel(command);
  if (dangerLabel !== null) {
    return {
      shouldBlock: true,
      reason: `bash_dangerous:${dangerLabel}`,
    };
  }

  if (shouldUseSandbox(normalizedInput)) {
    return {
      shouldBlock: false,
      reason: "bash_sandbox_safe",
    };
  }

  return {
    shouldBlock: true,
    reason: `runtime_classifier_manual_approval_required:${action.toolName}`,
    unavailable: true,
  };
}

function isRuntimeBackedBashToolName(toolName: string): boolean {
  return toolName === "Bash" || toolName === "system.bash" ||
    toolName === "local_shell";
}

function isBashPermissionInput(input: unknown): input is BashPermissionInput {
  if (!input || typeof input !== "object") return false;
  return typeof (input as { command?: unknown }).command === "string";
}

function normalizeRuntimeBashInput(
  input: unknown,
): BashPermissionInput | null {
  if (isBashPermissionInput(input)) {
    return input;
  }
  if (
    input &&
    typeof input === "object" &&
    Array.isArray((input as { command?: unknown }).command)
  ) {
    const command = (input as { command: readonly unknown[] }).command
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .trim();
    if (command.length === 0) return null;
    return { command };
  }
  return null;
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
