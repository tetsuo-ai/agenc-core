/**
 * Standalone tool helper functions for ChatExecutor.
 *
 * @module
 */

import type { LLMToolCall, LLMMessage, ToolHandler } from "./types.js";
import type { ToolCallRecord, ToolCallAction, RecoveryHint, LLMRetryPolicyOverrides } from "./chat-executor-types.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import { classifyVerificationProbeResult } from "../gateway/verifier-probes.js";
import { resolveRuntimeTimeoutMs } from "./runtime-limit-policy.js";
import { DEFAULT_LLM_RETRY_POLICY_MATRIX } from "./policy.js";
import type { LLMFailureClass, LLMRetryPolicyRule } from "./policy.js";
import {
  HIGH_RISK_TOOLS,
  HIGH_RISK_TOOL_PREFIXES,
  SAFE_TOOL_RETRY_TOOLS,
  SAFE_TOOL_RETRY_PREFIXES,
  MAX_TOOL_CALL_ARGUMENT_CHARS,
  MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS,
  RECOVERY_HINT_PREFIX,
} from "./chat-executor-constants.js";
import { safeStringify } from "../tools/types.js";
import { normalizeOverescapedToolText } from "../utils/overescaped-text.js";

const NON_JSON_FAILURE_PREFIXES = [
  "mcp tool \"",
  "error executing tool",
  "tool not found:",
];
const SHELL_EXECUTION_ANOMALY_RE =
  /(?:^|\n)(?:[^:\n]+:\s+line\s+\d+:\s+)?(?:(?:ba|z|k)?sh|cd|pushd|popd|source|\.)[^:\n]*:\s+.*(?:no such file or directory|command not found|not found|permission denied|not a directory)/i;
const COLLABORATION_PAYOUT_MODES = new Set(["fixed", "weighted", "milestone"]);

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

interface ToolArgumentRepairResult {
  readonly args: Record<string, unknown>;
  readonly repairedFields: readonly string[];
}

export function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true;
  const verificationAssessment = classifyVerificationProbeResult(result);
  if (
    verificationAssessment.verdict === "fail" ||
    verificationAssessment.verdict === "weak_pass"
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return isLikelyFailureText(result);
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true;
    if (
      typeof obj.error === "object" &&
      obj.error !== null &&
      !Array.isArray(obj.error)
    ) {
      const nestedError = obj.error as Record<string, unknown>;
      if (
        typeof nestedError.message === "string" &&
        nestedError.message.trim().length > 0
      ) {
        return true;
      }
      if (
        typeof nestedError.code === "string" &&
        nestedError.code.trim().length > 0
      ) {
        return true;
      }
    }
    if (obj.timedOut === true) return true;
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true;
    if (
      typeof obj.stderr === "string" &&
      SHELL_EXECUTION_ANOMALY_RE.test(obj.stderr)
    ) {
      return true;
    }
  } catch {
    // Non-JSON tool output — detect known tool-wrapper failure signatures.
    return isLikelyFailureText(result);
  }
  return false;
}

export function parseToolResultObject(
  result: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractToolFailureText(record: ToolCallRecord): string {
  return extractToolFailureTextFromResult(record.result);
}

export function extractToolFailureTextFromResult(result: string): string {
  const parsed = parseToolResultObject(result);
  if (!parsed) return result;

  const pieces: string[] = [];
  const appendPiece = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (pieces.includes(trimmed)) return;
    pieces.push(trimmed);
  };
  if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    appendPiece(parsed.error);
  }
  if (
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    !Array.isArray(parsed.error)
  ) {
    const nestedError = parsed.error as Record<string, unknown>;
    if (
      typeof nestedError.message === "string" &&
      nestedError.message.trim().length > 0
    ) {
      appendPiece(nestedError.message);
    }
    if (
      typeof nestedError.code === "string" &&
      nestedError.code.trim().length > 0
    ) {
      appendPiece(nestedError.code);
    }
    if (
      typeof nestedError.family === "string" &&
      nestedError.family.trim().length > 0
    ) {
      appendPiece(nestedError.family);
    }
    if (
      typeof nestedError.kind === "string" &&
      nestedError.kind.trim().length > 0
    ) {
      appendPiece(nestedError.kind);
    }
  }
  if (typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0) {
    appendPiece(parsed.stderr);
  }
  if (typeof parsed.stdout === "string" && parsed.stdout.trim().length > 0) {
    if (parsed.timedOut === true || pieces.length > 0) {
      appendPiece(parsed.stdout);
    }
  }
  if (parsed.timedOut === true) {
    pieces.unshift("Tool timed out before completing.");
  }
  if (pieces.length > 0) return pieces.join("\n");
  return result;
}

export function resolveRetryPolicyMatrix(
  overrides?: LLMRetryPolicyOverrides,
): LLMRetryPolicyMatrix {
  if (!overrides) return DEFAULT_LLM_RETRY_POLICY_MATRIX;
  const merged = {
    ...DEFAULT_LLM_RETRY_POLICY_MATRIX,
  } as Record<LLMFailureClass, LLMRetryPolicyRule>;
  for (const failureClass of Object.keys(
    DEFAULT_LLM_RETRY_POLICY_MATRIX,
  ) as LLMFailureClass[]) {
    const baseRule = merged[failureClass];
    const patch = overrides[failureClass];
    if (!patch) continue;
    merged[failureClass] = {
      ...baseRule,
      ...patch,
    };
  }
  return merged;
}

function hasExplicitIdempotencyKey(args: Record<string, unknown>): boolean {
  const value = args.idempotencyKey;
  return typeof value === "string" && value.trim().length > 0;
}

export function sanitizeToolCallArgumentsForReplay(raw: string): string {
  if (raw.length <= MAX_TOOL_CALL_ARGUMENT_CHARS) {
    return raw;
  }
  const preview = truncateText(
    raw,
    MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS,
  );
  return safeStringify({
    __truncatedToolCallArgs: true,
    originalChars: raw.length,
    preview,
  });
}

export function sanitizeToolCallsForReplay(
  toolCalls: readonly LLMToolCall[] | undefined,
): LLMToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    arguments: sanitizeToolCallArgumentsForReplay(
      toolCall.arguments,
    ),
  }));
}

function isHighRiskToolCall(
  toolName: string,
): boolean {
  if (HIGH_RISK_TOOLS.has(toolName)) return true;
  return HIGH_RISK_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isToolRetrySafe(toolName: string): boolean {
  if (SAFE_TOOL_RETRY_TOOLS.has(toolName)) return true;
  return SAFE_TOOL_RETRY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

function isLikelyToolTransportFailure(
  errorText: string,
): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("transport") ||
    lower.includes("bridge")
  );
}

export function enrichToolResultMetadata(
  result: string,
  metadata: Record<string, unknown>,
): string {
  const parsed = parseToolResultObject(result);
  if (!parsed) return result;
  return safeStringify({
    ...parsed,
    ...metadata,
  });
}

function isLikelyFailureText(result: string): boolean {
  const text = result.trim().toLowerCase();
  if (text.length === 0) return false;
  if (text.startsWith("mcp tool \"") && text.includes("\" failed:")) return true;
  if (text.includes("requires desktop session")) return true;
  return NON_JSON_FAILURE_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// ============================================================================
// Permission / argument / retry helpers (extracted from executeSingleToolCall)
// ============================================================================

/** Result of checking whether a tool call is permitted. */
interface ToolCallPermissionResult {
  readonly action: ToolCallAction;
  readonly errorResult?: string;
  readonly expandAfterRound?: boolean;
  readonly routingMiss?: boolean;
}

/** Check global allowlist and routed subset constraints for a tool call. */
export function checkToolCallPermission(
  toolCall: LLMToolCall,
  allowedTools: Set<string> | null,
  routedToolSet: Set<string> | null,
  canExpandOnRoutingMiss: boolean,
  routedToolsExpanded: boolean,
): ToolCallPermissionResult {
  // Global allowlist check.
  if (allowedTools && !allowedTools.has(toolCall.name)) {
    return {
      action: "skip",
      errorResult: safeStringify({
        error: `Tool "${toolCall.name}" is not permitted`,
      }),
    };
  }

  // Dynamic routed subset check.
  if (routedToolSet && !routedToolSet.has(toolCall.name)) {
    return {
      action: "skip",
      errorResult: safeStringify({
        error:
          `Tool "${toolCall.name}" was not available in the routed tool subset for this turn`,
        routingMiss: true,
      }),
      expandAfterRound: canExpandOnRoutingMiss && !routedToolsExpanded,
      routingMiss: true,
    };
  }

  return { action: "processed" };
}

/** Result of parsing tool call arguments. */
type ParseToolCallArgsResult =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

/** Parse and validate tool call JSON arguments. */
export function parseToolCallArguments(
  toolCall: LLMToolCall,
): ParseToolCallArgsResult {
  try {
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("Tool arguments must be a JSON object");
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (parseErr) {
    return {
      ok: false,
      error: safeStringify({
        error: `Invalid tool arguments: ${(parseErr as Error).message}`,
      }),
    };
  }
}

export function normalizeToolCallArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeFilesystemToolCallArguments(toolName, args);
}

const TOOL_ARG_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "system.readFile": { filePath: "path" },
  "system.listDir": { filePath: "path", dirPath: "path", directoryPath: "path" },
  "system.writeFile": {
    filePath: "path",
    text: "content",
    contents: "content",
    body: "content",
  },
  "system.appendFile": {
    filePath: "path",
    text: "content",
    contents: "content",
    body: "content",
  },
  "system.mkdir": { filePath: "path", dirPath: "path", directoryPath: "path" },
  "system.delete": { filePath: "path", targetPath: "path" },
  "system.move": {
    sourcePath: "source",
    from: "source",
    destinationPath: "destination",
    destPath: "destination",
    to: "destination",
  },
};

const TOOL_TEXT_FIELDS_TO_NORMALIZE: Readonly<Record<string, readonly string[]>> = {
  "system.writeFile": ["content"],
  "system.appendFile": ["content"],
  "system.editFile": ["old_string", "new_string"],
  "system.bash": ["command"],
};

function normalizeFilesystemToolCallArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const aliasMap = TOOL_ARG_ALIASES[toolName];
  let nextArgs = args;
  if (aliasMap) {
    for (const [alias, canonical] of Object.entries(aliasMap)) {
      if (!Object.prototype.hasOwnProperty.call(nextArgs, alias)) {
        continue;
      }
      const aliasValue = nextArgs[alias];
      if (aliasValue === undefined) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(nextArgs, canonical)) {
        if (nextArgs === args) {
          nextArgs = { ...args };
        }
        delete nextArgs[alias];
        continue;
      }
      if (nextArgs === args) {
        nextArgs = { ...args };
      }
      nextArgs[canonical] = aliasValue;
      delete nextArgs[alias];
    }
  }

  const textFields = TOOL_TEXT_FIELDS_TO_NORMALIZE[toolName];
  if (!textFields) {
    return nextArgs;
  }
  for (const field of textFields) {
    const value = nextArgs[field];
    if (typeof value !== "string") continue;
    const normalized = normalizeOverescapedToolText(value);
    if (normalized === value) continue;
    if (nextArgs === args) {
      nextArgs = { ...args };
    }
    nextArgs[field] = normalized;
  }
  return nextArgs;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function trimRecoveredArgumentValue(value: string): string {
  return value
    .trim()
    .replace(/^[`"'“”]+|[`"'“”]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function buildNamedFieldRegex(
  fieldName: string,
  trailingFields: readonly string[],
): RegExp {
  const escapedField = escapeRegex(fieldName);
  const trailing = trailingFields.map((field) => escapeRegex(field)).join("|");
  return new RegExp(
    `\\b${escapedField}\\s*(?:=|:)?\\s*([\\s\\S]+?)` +
      `(?=(?:,\\s*(?:${trailing})\\b)|(?:\\.\\s*(?:after|then|reply|respond|once|when)\\b)|$)`,
    "i",
  );
}

function extractNamedStringArgument(
  messageText: string,
  fieldName: string,
  trailingFields: readonly string[],
): string | undefined {
  const quoted = new RegExp(
    `\\b${escapeRegex(fieldName)}\\s*(?:=|:)?\\s*["'\`]([\\s\\S]+?)["'\`]`,
    "i",
  ).exec(messageText);
  if (quoted?.[1]) {
    const normalized = trimRecoveredArgumentValue(quoted[1]);
    return normalized.length > 0 ? normalized : undefined;
  }

  const unquoted = buildNamedFieldRegex(fieldName, trailingFields).exec(messageText);
  if (!unquoted?.[1]) return undefined;
  const normalized = trimRecoveredArgumentValue(unquoted[1]);
  return normalized.length > 0 ? normalized : undefined;
}

function isMissingNumberArg(value: unknown): boolean {
  return typeof value !== "number" || !Number.isFinite(value);
}

function repairCollaborationArgumentsFromMessageText(
  args: Record<string, unknown>,
  messageText: string,
): ToolArgumentRepairResult {
  let nextArgs = args;
  const repairedFields: string[] = [];

  if (!hasNonEmptyString(args.title)) {
    const recoveredTitle = extractNamedStringArgument(messageText, "title", [
      "description",
      "requiredCapabilities",
      "maxMembers",
      "payoutMode",
    ]);
    if (recoveredTitle) {
      if (nextArgs === args) nextArgs = { ...args };
      nextArgs.title = recoveredTitle;
      repairedFields.push("title");
    }
  }

  if (!hasNonEmptyString(args.description)) {
    const recoveredDescription = extractNamedStringArgument(
      messageText,
      "description",
      ["requiredCapabilities", "maxMembers", "payoutMode"],
    );
    if (recoveredDescription) {
      if (nextArgs === args) nextArgs = { ...nextArgs };
      nextArgs.description = recoveredDescription;
      repairedFields.push("description");
    }
  }

  if (!hasNonEmptyString(args.requiredCapabilities)) {
    const recoveredCaps =
      /\brequiredCapabilities\s*(?:=|:)?\s*["'\`]?([0-9]+)["'\`]?/i.exec(
        messageText,
      )?.[1];
    if (recoveredCaps) {
      if (nextArgs === args) nextArgs = { ...nextArgs };
      nextArgs.requiredCapabilities = recoveredCaps;
      repairedFields.push("requiredCapabilities");
    }
  }

  if (isMissingNumberArg(args.maxMembers)) {
    const recoveredMaxMembers = /\bmaxMembers\s*(?:=|:)?\s*([0-9]+)\b/i.exec(
      messageText,
    )?.[1];
    if (recoveredMaxMembers) {
      if (nextArgs === args) nextArgs = { ...nextArgs };
      nextArgs.maxMembers = Number.parseInt(recoveredMaxMembers, 10);
      repairedFields.push("maxMembers");
    }
  }

  if (
    !hasNonEmptyString(args.payoutMode) ||
    !COLLABORATION_PAYOUT_MODES.has(args.payoutMode.trim())
  ) {
    const recoveredMode =
      /\bpayoutMode\s*(?:=|:)?\s*(fixed|weighted|milestone)\b/i.exec(
        messageText,
      )?.[1];
    if (recoveredMode) {
      if (nextArgs === args) nextArgs = { ...nextArgs };
      nextArgs.payoutMode = recoveredMode.toLowerCase();
      repairedFields.push("payoutMode");
    }
  }

  return { args: nextArgs, repairedFields };
}

export function repairToolCallArgumentsFromMessageText(
  toolName: string,
  args: Record<string, unknown>,
  messageText: string,
): ToolArgumentRepairResult {
  if (toolName !== "social.requestCollaboration") {
    return { args, repairedFields: [] };
  }
  return repairCollaborationArgumentsFromMessageText(args, messageText);
}

export function summarizeToolArgumentChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const field of fields) {
    if (safeStringify(before[field]) !== safeStringify(after[field])) {
      changed.push(field);
    }
  }
  return changed.sort();
}

/** Configuration for tool execution with retry. */
interface ToolExecutionConfig {
  readonly toolCallTimeoutMs: number;
  readonly retryPolicyMatrix: LLMRetryPolicyMatrix;
  readonly signal?: AbortSignal;
  readonly requestDeadlineAt: number;
}

/** Result of executing a tool with retry logic. */
interface ToolExecutionResult {
  result: string;
  isError: boolean;
  toolFailed: boolean;
  timedOut: boolean;
  retryCount: number;
  retrySuppressedReason?: string;
  durationMs: number;
  finalToolTimeoutMs: number;
}

/** Execute a tool call with timeout racing and transport-failure retry. */
export async function executeToolWithRetry(
  toolCall: LLMToolCall,
  args: Record<string, unknown>,
  handler: ToolHandler,
  config: ToolExecutionConfig,
): Promise<ToolExecutionResult> {
  const toolStart = Date.now();
  let result = safeStringify({ error: "Tool execution failed" });
  let isError = false;
  let toolFailed = false;
  let timedOut = false;
  let finalToolTimeoutMs = config.toolCallTimeoutMs;
  let retrySuppressedReason: string | undefined;
  let retryCount = 0;
  const maxToolRetries = Math.max(
    0,
    config.retryPolicyMatrix.tool_error.maxRetries,
  );

  for (let attempt = 0; attempt <= maxToolRetries; attempt++) {
    const toolTimeoutMs = resolveRuntimeTimeoutMs({
      configuredTimeoutMs: config.toolCallTimeoutMs,
      requestDeadlineAt: config.requestDeadlineAt,
    });
    finalToolTimeoutMs = toolTimeoutMs ?? 0;
    let toolTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const toolCallPromise = (async (): Promise<{
      result: string;
      isError: boolean;
      timedOut: boolean;
      threw: boolean;
    }> => {
      try {
        const value = await handler(toolCall.name, args);
        return {
          result: value,
          isError: false,
          timedOut: false,
          threw: false,
        };
      } catch (toolErr) {
        return {
          result: safeStringify({ error: (toolErr as Error).message }),
          isError: true,
          timedOut: false,
          threw: true,
        };
      }
    })();
    const timeoutPromise = toolTimeoutMs === undefined
      ? undefined
      : new Promise<{
        result: string;
        isError: boolean;
        timedOut: boolean;
        threw: boolean;
      }>((resolve) => {
        toolTimeoutHandle = setTimeout(() => {
          resolve({
            result: safeStringify({
              error: `Tool "${toolCall.name}" timed out after ${toolTimeoutMs}ms`,
            }),
            isError: true,
            timedOut: true,
            threw: false,
          });
        }, toolTimeoutMs);
      });
    const toolOutcome = timeoutPromise
      ? await Promise.race([
          toolCallPromise,
          timeoutPromise,
        ])
      : await toolCallPromise;
    if (toolTimeoutHandle !== undefined) {
      clearTimeout(toolTimeoutHandle);
    }

    result = toolOutcome.result;
    isError = toolOutcome.isError;
    timedOut = toolOutcome.timedOut;

    toolFailed = didToolCallFail(isError, result);
    const failureText = toolFailed
      ? extractToolFailureText({
        name: toolCall.name,
        args,
        result,
        isError: toolFailed,
        durationMs: 0,
      })
      : "";
    const transportFailure =
      timedOut ||
      toolOutcome.threw ||
      isLikelyToolTransportFailure(failureText);
    if (!toolFailed) break;

    const canRetryTransportFailure =
      transportFailure &&
      attempt < maxToolRetries &&
      !config.signal?.aborted &&
      (config.requestDeadlineAt - Date.now()) > 0;
    if (!canRetryTransportFailure) break;

    const highRiskTool = isHighRiskToolCall(toolCall.name);
    const hasIdempotency = hasExplicitIdempotencyKey(args);
    const retrySafe = highRiskTool
      ? hasIdempotency
      : isToolRetrySafe(toolCall.name);
    if (!retrySafe) {
      retrySuppressedReason = highRiskTool && !hasIdempotency
        ? `Suppressed auto-retry for high-risk tool "${toolCall.name}" without idempotencyKey`
        : `Suppressed auto-retry for potentially side-effecting tool "${toolCall.name}"`;
      break;
    }

    retryCount++;
  }
  const durationMs = Date.now() - toolStart;
  if (retryCount > 0) {
    result = enrichToolResultMetadata(result, { retryAttempts: retryCount });
  }
  if (retrySuppressedReason) {
    result = enrichToolResultMetadata(result, { retrySuppressedReason });
  }

  return {
    result,
    isError,
    toolFailed,
    timedOut,
    retryCount,
    retrySuppressedReason,
    durationMs,
    finalToolTimeoutMs,
  };
}

/** Build recovery hint messages for injection after a tool round. */
export function buildToolLoopRecoveryMessages(
  recoveryHints: readonly RecoveryHint[],
  maxRuntimeSystemHints: number,
  currentRuntimeHintCount: number,
): LLMMessage[] {
  const messages: LLMMessage[] = [];
  if (maxRuntimeSystemHints <= 0) return messages;
  let hintCount = currentRuntimeHintCount;
  for (const hint of recoveryHints) {
    if (hintCount >= maxRuntimeSystemHints) break;
    messages.push({
      role: "system",
      content: `${RECOVERY_HINT_PREFIX} ${hint.message}`,
    });
    hintCount++;
  }
  return messages;
}

/** Build a routing expansion hint message when tool routing misses are detected. */
export function buildRoutingExpansionMessage(
  maxRuntimeSystemHints: number,
  currentRuntimeHintCount: number,
): LLMMessage | null {
  if (maxRuntimeSystemHints <= 0) return null;
  if (currentRuntimeHintCount >= maxRuntimeSystemHints) return null;
  return {
    role: "system",
    content:
      `${RECOVERY_HINT_PREFIX} The previous tool request targeted a tool outside the routed subset. ` +
      "Tool availability has been expanded for one retry. Choose the best available tool and continue.",
  };
}
