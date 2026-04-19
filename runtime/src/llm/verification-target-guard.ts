/**
 * Structural anti-fabrication gate for verification harness writes.
 *
 * Prevents the "failed test → silently rewrite the test to exit 0" pattern:
 * when a `system.bash` / `desktop.bash` call fails in the current turn while
 * referencing a verification harness path (test/spec file), and the model
 * immediately follows up with a `system.writeFile` / `system.appendFile` /
 * `desktop.text_editor` targeting that same harness, the dispatch loop
 * refuses the write. The gate removes the affordance to lie rather than
 * trusting the model to heed a recovery hint it is free to ignore.
 *
 * The canonical `TEST_FILE_PATH_RE` lives here and is re-exported so the
 * gateway verification-metadata tagger uses the same source of truth as the
 * tool dispatch gate (see `Incident Fixes: Centralize runtime enforcement`).
 *
 * @module
 */

import { basename } from "node:path";

import type { ToolCallRecord } from "./chat-executor-types.js";
import { extractToolFailureText } from "./chat-executor-tool-utils.js";

/**
 * Regex matching verification-harness paths — test/spec directories or
 * `.test.`/`.spec.` file suffixes. Canonical source of truth, imported by
 * `tool-handler-factory` for result metadata tagging and by the chat
 * executor tool loop for the anti-fabrication gate.
 */
export const TEST_FILE_PATH_RE =
  /(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i;

/** Tool names whose invocation writes or overwrites files on disk. */
const FILE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.writeFile",
  "system.appendFile",
  "desktop.text_editor",
]);

/** Tool names that execute shell commands. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "system.bash",
  "desktop.bash",
]);

/** Maximum characters of failing evidence to surface in the refusal message. */
const EVIDENCE_EXCERPT_MAX_CHARS = 400;

export function isVerificationTargetPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  return TEST_FILE_PATH_RE.test(path);
}

export function isFileWriteToolName(toolName: string): boolean {
  return FILE_WRITE_TOOL_NAMES.has(toolName);
}

export function isShellToolName(toolName: string): boolean {
  return SHELL_TOOL_NAMES.has(toolName);
}

function extractShellInvocationText(record: ToolCallRecord): string {
  const command =
    typeof record.args?.command === "string"
      ? record.args.command
      : "";
  const argv = Array.isArray(record.args?.args)
    ? (record.args.args as unknown[])
        .filter((value): value is string => typeof value === "string")
        .join(" ")
    : "";
  const cwd =
    typeof record.args?.cwd === "string" ? record.args.cwd : "";
  return `${command} ${argv} ${cwd}`.trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max).trimEnd()}…`;
}

export interface AntiFabricationEvidence {
  /** The exact write-tool target path the gate refused. */
  readonly targetPath: string;
  /** Lowercased basename used for the harness match. */
  readonly matchedBasename: string;
  /** Name of the prior shell tool whose failure triggered the gate. */
  readonly failingToolName: string;
  /** Reconstructed shell invocation text of the failing call. */
  readonly failingInvocation: string;
  /** Truncated failure output / stderr excerpt from the failing call. */
  readonly failingExcerpt: string;
}

export interface AntiFabricationDecision {
  /** `true` when the dispatch loop should refuse the write. */
  readonly refuse: boolean;
  /** Stable reason key emitted on the `tool_rejected` trace event. */
  readonly reason?: string;
  /** Human-readable refusal message delivered to the model as the tool result. */
  readonly message?: string;
  /** Structured evidence captured in the trace payload. */
  readonly evidence?: AntiFabricationEvidence;
}

const REASON_KEY = "anti_fabrication_harness_overwrite";

/**
 * Evaluate whether a pending file-write tool call should be refused because
 * it would overwrite a verification harness that a prior shell call in the
 * same turn just failed against.
 *
 * Rules:
 *   1. The target tool must be a file-write tool.
 *   2. The target `path` must match `TEST_FILE_PATH_RE` (verification harness).
 *   3. At least one prior `system.bash` / `desktop.bash` call in the current
 *      turn must have `isError === true` AND its invocation text or failure
 *      text must reference the target harness by basename.
 *
 * The gate intentionally scans only the current-turn tool call ledger
 * (`ctx.allToolCalls`), which is reset per execution context.
 */
export function evaluateWriteOverFailedVerification(params: {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly priorToolCalls: readonly ToolCallRecord[];
}): AntiFabricationDecision {
  if (!isFileWriteToolName(params.toolName)) {
    return { refuse: false };
  }

  const rawPath =
    typeof params.args.path === "string" ? params.args.path : "";
  if (!isVerificationTargetPath(rawPath)) {
    return { refuse: false };
  }

  const rawBasename = basename(rawPath).toLowerCase();
  if (rawBasename.length === 0) {
    return { refuse: false };
  }

  for (const record of params.priorToolCalls) {
    if (!isShellToolName(record.name)) {
      continue;
    }
    if (!record.isError) {
      continue;
    }
    const invocationText = extractShellInvocationText(record).toLowerCase();
    const failureText = extractToolFailureText(record).toLowerCase();
    const haystack = `${invocationText}\n${failureText}`;
    if (!haystack.includes(rawBasename)) {
      continue;
    }

    const excerpt = truncate(
      (failureText.length > 0 ? failureText : invocationText).trim(),
      EVIDENCE_EXCERPT_MAX_CHARS,
    );

    const message =
      `Refusing \`${params.toolName}\` on verification harness ` +
      `\`${rawPath}\`: a prior \`${record.name}\` call in this turn ` +
      `failed while referencing \`${rawBasename}\`. Overwriting the ` +
      `harness instead of fixing the real failure would manufacture a ` +
      `fake pass. Fix the underlying cause (cwd/path, script invocation, ` +
      `or the code under test). If the harness itself is genuinely wrong, ` +
      `stop and explain the discrepancy in your final response for user ` +
      `review before modifying it.`;

    return {
      refuse: true,
      reason: REASON_KEY,
      message,
      evidence: {
        targetPath: rawPath,
        matchedBasename: rawBasename,
        failingToolName: record.name,
        failingInvocation: truncate(
          extractShellInvocationText(record),
          EVIDENCE_EXCERPT_MAX_CHARS,
        ),
        failingExcerpt: excerpt,
      },
    };
  }

  return { refuse: false };
}

/** Exported reason key so trace-consuming code can match on it deterministically. */
export const ANTI_FABRICATION_HARNESS_OVERWRITE_REASON = REASON_KEY;
