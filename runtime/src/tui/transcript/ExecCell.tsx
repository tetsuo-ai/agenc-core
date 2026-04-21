/**
 * ExecCell — Codex-style shell execution cell.
 *
 * Renders a single `$ command` line and its captured stdout / stderr
 * below, followed by a compact status badge:
 *
 *     $ npm run build
 *     > …stdout / stderr (dimmed)…
 *     · running        (undefined exit)
 *     ✓ 0  in 12.3s    (exit 0)
 *     ✗ 1  in 4.1s     (non-zero exit)
 *     ⚠ timeout        (timedOut=true)
 *
 * When the combined stdout + stderr exceeds 20 lines, the middle is
 * collapsed to a "… (N lines elided) …" marker so a runaway build log
 * doesn't blow out the transcript. The collapse helper is exported so
 * `MessageList` can invoke it directly for inline tool_result rendering.
 *
 * @module
 */

import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";

/* ────────────────────────────────────────────────────────────────────── */
/* Pure helpers                                                            */
/* ────────────────────────────────────────────────────────────────────── */

const DEFAULT_KEEP_HEAD = 10;
const DEFAULT_KEEP_TAIL = 5;
const MAX_LINES_BEFORE_COLLAPSE = DEFAULT_KEEP_HEAD + DEFAULT_KEEP_TAIL + 5;

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
  // Use `split('\n')` instead of a regex so we preserve the exact
  // per-line content (blank lines included).
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES_BEFORE_COLLAPSE) {
    return text;
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
  readonly label: string;
  readonly color: string;
}

function computeStatus(props: ExecCellProps): StatusBadge {
  if (props.timedOut) {
    return {
      glyph: "\u26A0",
      label: "timeout",
      color: theme.colors.warning,
    };
  }
  if (props.exitCode === undefined) {
    return { glyph: "\u00B7", label: "running", color: theme.colors.dim };
  }
  if (props.exitCode === 0) {
    return { glyph: "\u2713", label: "0", color: theme.colors.success };
  }
  return {
    glyph: "\u2717",
    label: String(props.exitCode),
    color: theme.colors.error,
  };
}

export const ExecCell: React.FC<ExecCellProps> = (props) => {
  const status = useMemo(() => computeStatus(props), [props]);
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

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {/* command row */}
      <Box flexDirection="row">
        <Text color={theme.colors.primary}>{"$ "}</Text>
        <Text>{props.command}</Text>
      </Box>

      {hasStdout ? (
        <Box flexDirection="column">
          <Text dim>{collapsedStdout}</Text>
        </Box>
      ) : null}

      {hasStderr ? (
        <Box flexDirection="column">
          <Text color={theme.colors.error} dim>
            {collapsedStderr}
          </Text>
        </Box>
      ) : null}

      {/* status row */}
      <Box flexDirection="row">
        <Text color={status.color}>
          {status.glyph}
          {" "}
          {status.label}
        </Text>
        {durationLabel.length > 0 ? (
          <Text dim>{durationLabel}</Text>
        ) : null}
      </Box>
    </Box>
  );
};

export default ExecCell;
