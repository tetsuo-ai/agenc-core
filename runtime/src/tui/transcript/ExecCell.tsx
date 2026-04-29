/**
 * ExecCell — shell execution history cell.
 *
 * Mirrors AgenC runtime's history-cell shape more closely than the older boxed
 * `$ command` widget: a single semantic Bash(command) header, optional
 * indented stdout / stderr lines, and a compact status note.
 *
 * When stdout/stderr exceed the visible budget, output is collapsed so long
 * logs do not dominate the transcript.
 *
 * @module
 */

import { basename } from "node:path";
import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";
import { sanitizeTranscriptText } from "./sanitize.js";

/* ────────────────────────────────────────────────────────────────────── */
/* Pure helpers                                                            */
/* ────────────────────────────────────────────────────────────────────── */

const DEFAULT_KEEP_HEAD = 3;
const DEFAULT_KEEP_TAIL = 0;
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";
const SHELL_CWD_RESET_PATTERN = /(?:^|\n)(Shell cwd was reset(?: to .+)?)$/u;

/**
 * Collapse a multi-line string: keep the first `keepHead` lines, then an
 * elision marker, then the last `keepTail` lines. Short inputs (<= head +
 * tail + margin) are returned unchanged so we don't turn a 12-line output
 * into a 17-line one.
 */
export function collapseOutput(
  text: string,
  keepHead: number = DEFAULT_KEEP_HEAD,
  keepTail: number = DEFAULT_KEEP_TAIL,
): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const sanitized = sanitizeTranscriptText(text);
  // Use `split('\n')` instead of a regex so we preserve the exact
  // per-line content (blank lines included).
  const lines = sanitized.split("\n");
  const visibleBudget = keepHead + keepTail;
  if (visibleBudget <= 0 || lines.length <= visibleBudget + 1) {
    return sanitized;
  }
  const head = lines.slice(0, keepHead);
  const tail = keepTail > 0 ? lines.slice(lines.length - keepTail) : [];
  const elided = lines.length - keepHead - keepTail;
  const marker = `... +${elided} ${elided === 1 ? "line" : "lines"} (Ctrl+O to expand)`;
  return [...head, marker, ...tail].join("\n");
}

/**
 * Format a duration in milliseconds as a compact human string:
 * `842ms`, `12.3s`, `2m4s`. Used for the status badge.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60 * 1000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

function removeSandboxTags(value: string): string {
  return value
    .replace(/<sandbox_violations>[\s\S]*?<\/sandbox_violations>/gu, "")
    .replace(/<\/?sandbox(?:\s[^>]*)?>/gu, "")
    .trim();
}

function extractCwdResetWarning(value: string): {
  readonly cleaned: string;
  readonly warning: string | null;
} {
  const match = value.match(SHELL_CWD_RESET_PATTERN);
  if (!match) return { cleaned: value, warning: null };
  return {
    cleaned: value.replace(SHELL_CWD_RESET_PATTERN, "").trim(),
    warning: match[1] ?? null,
  };
}

export interface BashResultForTranscriptInput {
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly exitCode?: unknown;
  readonly timedOut?: unknown;
  readonly truncated?: unknown;
  readonly verbose?: unknown;
  readonly cwdWasReset?: unknown;
  readonly backgroundTaskHint?: unknown;
  readonly imagePaths?: unknown;
  readonly noOutputExpected?: unknown;
  readonly returnCodeInterpretation?: unknown;
  readonly backgroundTaskId?: unknown;
}

export interface BashResultSegment {
  readonly text: string;
  readonly stream: "stdout" | "stderr" | "notice";
}

function collapseForDisplay(value: string, verbose: unknown): string {
  return verbose === true ? value : collapseOutput(value);
}

function appendSegments(
  segments: BashResultSegment[],
  value: string,
  stream: BashResultSegment["stream"],
): void {
  if (value.length === 0) return;
  for (const line of value.split("\n")) {
    segments.push({ text: line, stream });
  }
}

export function formatBashResultSegments(
  input: BashResultForTranscriptInput,
): BashResultSegment[] {
  const rawStdout = typeof input.stdout === "string" ? input.stdout : "";
  const rawStderr = typeof input.stderr === "string" ? input.stderr : "";
  const stdout = collapseForDisplay(
    removeSandboxTags(sanitizeTranscriptText(rawStdout)),
    input.verbose,
  );
  const stderrWithoutSandbox = removeSandboxTags(sanitizeTranscriptText(rawStderr));
  const { cleaned: rawStderrCleaned, warning } = extractCwdResetWarning(stderrWithoutSandbox);
  const stderr = collapseForDisplay(rawStderrCleaned, input.verbose);
  const segments: BashResultSegment[] = [];

  appendSegments(segments, stdout, "stdout");
  appendSegments(segments, stderr, "stderr");
  if (warning !== null) appendSegments(segments, warning, "notice");
  if (input.cwdWasReset === true && warning === null) {
    appendSegments(segments, "Shell cwd was reset", "notice");
  }
  if (typeof input.backgroundTaskHint === "string" && input.backgroundTaskHint.length > 0) {
    appendSegments(segments, input.backgroundTaskHint, "notice");
  } else if (typeof input.backgroundTaskId === "string" && input.backgroundTaskId.length > 0) {
    appendSegments(segments, `Running in the background: ${input.backgroundTaskId}`, "notice");
  }
  if (input.truncated === true) {
    appendSegments(segments, "Output truncated", "notice");
  }
  const imagePaths = Array.isArray(input.imagePaths)
    ? input.imagePaths.filter((path): path is string => typeof path === "string")
    : [];
  if (imagePaths.length > 0) {
    const images = imagePaths.map((path) => basename(path) || path).join(", ");
    appendSegments(segments, `Image output: ${images}`, "notice");
  }
  if (
    segments.length === 0 &&
    (typeof input.exitCode === "number" ||
      input.timedOut === true ||
      input.noOutputExpected === true ||
      (typeof input.returnCodeInterpretation === "string" &&
        input.returnCodeInterpretation.length > 0))
  ) {
    appendSegments(
      segments,
      typeof input.returnCodeInterpretation === "string" &&
        input.returnCodeInterpretation.length > 0
        ? input.returnCodeInterpretation
        : input.noOutputExpected === true
          ? "Done"
          : "(No output)",
      "notice",
    );
  }
  return segments;
}

export function formatBashResultLines(
  input: BashResultForTranscriptInput,
): string[] {
  return formatBashResultSegments(input).map((segment) => segment.text);
}

export function formatBashResultForTranscript(
  input: BashResultForTranscriptInput,
): React.ReactNode {
  return formatBashResultLines(input);
}

/* ────────────────────────────────────────────────────────────────────── */
/* Component                                                               */
/* ────────────────────────────────────────────────────────────────────── */

export interface ExecCellProps {
  /** The command as the operator would have typed it. */
  readonly command: string;
  /** Captured stdout since the command started. Cumulative. */
  readonly stdout: string;
  /** Captured stderr since the command started. Cumulative. */
  readonly stderr: string;
  /** Exit code. `undefined` while the command is still running. */
  readonly exitCode?: number;
  /** Wall-clock duration of the command in milliseconds. */
  readonly durationMs?: number;
  /**
   * True when the runtime killed the command because it hit its timeout
   * budget. Takes priority over `exitCode` in the status badge.
   */
  readonly timedOut?: boolean;
  readonly truncated?: boolean;
  readonly cwdWasReset?: boolean;
  readonly backgroundTaskHint?: string;
  readonly imagePaths?: readonly string[];
  readonly noOutputExpected?: boolean;
  readonly returnCodeInterpretation?: string;
  readonly backgroundTaskId?: string;
  readonly verbose?: boolean;
}

interface StatusBadge {
  readonly glyph: string;
  readonly color: string;
}

function computeStatus(props: ExecCellProps): StatusBadge {
  if (props.timedOut) {
    return {
      glyph: BLACK_CIRCLE,
      color: theme.colors.warning,
    };
  }
  if (props.exitCode === undefined) {
    return { glyph: BLACK_CIRCLE, color: theme.colors.dim };
  }
  if (props.exitCode === 0) {
    return { glyph: BLACK_CIRCLE, color: theme.colors.success };
  }
  return {
    glyph: BLACK_CIRCLE,
    color: theme.colors.error,
  };
}

function segmentColor(segment: BashResultSegment): string | undefined {
  if (segment.stream === "stderr") return theme.colors.error;
  if (segment.stream === "notice") return theme.colors.dim;
  return undefined;
}

function renderIndentedSegments(
  segments: readonly BashResultSegment[],
): React.ReactElement[] {
  return segments.map((segment, index) => {
    const color = segmentColor(segment);
    return (
      <Box key={`${segment.stream}-${index}`} flexDirection="row">
        <Text dim>{index === 0 ? "  ⎿  " : "     "}</Text>
        {segment.text === "(No output)" ? (
          <Text dim>
            <ink-link href="agenc://bash/no-output">(No output)</ink-link>
          </Text>
        ) : (
          <Text {...(color ? { color } : {})} dim>
            {segment.text.length > 0 ? segment.text : " "}
          </Text>
        )}
      </Box>
    );
  });
}

export const ExecCell: React.FC<ExecCellProps> = (props) => {
  const status = useMemo(() => computeStatus(props), [props]);
  const displayCommand = useMemo(
    () => sanitizeTranscriptText(props.command ?? ""),
    [props.command],
  );
  const resultSegments = useMemo(
    () =>
      formatBashResultSegments({
        stdout: props.stdout,
        stderr: props.stderr,
        ...(props.exitCode !== undefined ? { exitCode: props.exitCode } : {}),
        ...(props.timedOut !== undefined ? { timedOut: props.timedOut } : {}),
        ...(props.truncated !== undefined
          ? { truncated: props.truncated }
          : {}),
        ...(props.cwdWasReset !== undefined ? { cwdWasReset: props.cwdWasReset } : {}),
        ...(props.backgroundTaskHint !== undefined
          ? { backgroundTaskHint: props.backgroundTaskHint }
          : {}),
        ...(props.imagePaths !== undefined ? { imagePaths: props.imagePaths } : {}),
        ...(props.noOutputExpected !== undefined
          ? { noOutputExpected: props.noOutputExpected }
          : {}),
        ...(props.returnCodeInterpretation !== undefined
          ? { returnCodeInterpretation: props.returnCodeInterpretation }
          : {}),
        ...(props.backgroundTaskId !== undefined
          ? { backgroundTaskId: props.backgroundTaskId }
          : {}),
        verbose: props.verbose,
      }),
    [
      props.backgroundTaskHint,
      props.backgroundTaskId,
      props.cwdWasReset,
      props.exitCode,
      props.imagePaths,
      props.noOutputExpected,
      props.returnCodeInterpretation,
      props.stderr,
      props.stdout,
      props.timedOut,
      props.truncated,
      props.verbose,
    ],
  );
  const durationLabel =
    typeof props.durationMs === "number" && props.durationMs >= 0
      ? ` in ${formatDuration(props.durationMs)}`
      : "";
  const statusDetail = props.timedOut
    ? `Timed out${durationLabel}`
    : props.exitCode === undefined
      ? "Running"
      : props.exitCode === 0
        ? `Completed · Done${durationLabel}`
        : `Exited ${props.exitCode}${durationLabel}`;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={status.color} dim={props.exitCode === undefined && !props.timedOut}>
          {status.glyph}
        </Text>
        <Text> </Text>
        <Text bold>Bash</Text>
        {displayCommand.length > 0 ? <Text dim>{`(${displayCommand})`}</Text> : null}
      </Box>
      {renderIndentedSegments(resultSegments)}
      {statusDetail ? (
        <Box flexDirection="row">
          <Text dim>{"  ⎿  "}</Text>
          <Text dim color={props.exitCode && props.exitCode !== 0 ? theme.colors.error : theme.colors.dim}>
            {statusDetail}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};

export default ExecCell;
