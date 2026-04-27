/**
 * ExecCell — shell execution history cell.
 *
 * Mirrors AgenC runtime's history-cell shape more closely than the older boxed
 * `$ command` widget: a single semantic Bash(command) header, optional
 * indented stdout / stderr lines, and a compact status note.
 *
 * When stdout/stderr exceed the head/tail budget, the middle is collapsed to
 * an "… (N lines elided) …" marker so long logs do not dominate the
 * transcript.
 *
 * @module
 */

import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";
import { sanitizeTranscriptText } from "./sanitize.js";

/* ────────────────────────────────────────────────────────────────────── */
/* Pure helpers                                                            */
/* ────────────────────────────────────────────────────────────────────── */

const DEFAULT_KEEP_HEAD = 5;
const DEFAULT_KEEP_TAIL = 5;
const MAX_LINES_BEFORE_COLLAPSE = DEFAULT_KEEP_HEAD + DEFAULT_KEEP_TAIL + 5;
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

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
  if (lines.length <= MAX_LINES_BEFORE_COLLAPSE) {
    return sanitized;
  }
  const head = lines.slice(0, keepHead);
  const tail = lines.slice(lines.length - keepTail);
  const elided = lines.length - keepHead - keepTail;
  const marker = `... (${elided} lines elided) ...`;
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

function renderIndentedLines(
  lines: readonly string[],
  color?: string,
): React.ReactElement[] {
  return lines.map((line, index) => (
    <Box key={`${color ?? "default"}-${index}`} flexDirection="row">
      <Text dim>{index === 0 ? "  ⎿  " : "     "}</Text>
      <Text {...(color ? { color } : {})} dim>
        {line.length > 0 ? line : " "}
      </Text>
    </Box>
  ));
}

export const ExecCell: React.FC<ExecCellProps> = (props) => {
  const status = useMemo(() => computeStatus(props), [props]);
  const displayCommand = useMemo(
    () => sanitizeTranscriptText(props.command ?? ""),
    [props.command],
  );
  const collapsedStdout = useMemo(
    () => collapseOutput(props.stdout ?? ""),
    [props.stdout],
  );
  const collapsedStderr = useMemo(
    () => collapseOutput(props.stderr ?? ""),
    [props.stderr],
  );

  const hasStdout = collapsedStdout.length > 0;
  const hasStderr = collapsedStderr.length > 0;
  const durationLabel =
    typeof props.durationMs === "number" && props.durationMs >= 0
      ? ` in ${formatDuration(props.durationMs)}`
      : "";
  const statusDetail = props.timedOut
    ? `Timed out${durationLabel}`
    : props.exitCode === undefined
      ? "Running"
      : props.exitCode === 0
        ? `Completed${durationLabel}`
        : `Exited ${props.exitCode}${durationLabel}`;
  const stdoutLines = hasStdout ? collapsedStdout.split("\n") : [];
  const stderrLines = hasStderr ? collapsedStderr.split("\n") : [];
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
      {renderIndentedLines(stdoutLines)}
      {renderIndentedLines(stderrLines, theme.colors.error)}
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
