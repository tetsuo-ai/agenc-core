// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import React from "react";

import { Box, Text } from "./ink.js";
import { AskUserQuestionTool } from "../tools/ask-user-question/tui-tool.js";
import { formatToolPathForDisplay } from "../tools/system/agent-path-hints.js";
import {
  pickToolResultDispatch,
  resultTextForTuiTool,
} from "./tool-result-routing.js";

/**
 * Tag extractor mirroring upstream `extractTag` semantics — pulls
 * `<tag>...</tag>` content out of a flat string. Inlined locally
 * instead of imported from `utils/messages.ts` because
 * that module pulls a `bun:bundle` feature gate + provider chain in
 * at module-load time, which the vitest source resolver cannot follow.
 * The TUI renderer only needs the regex extraction; nothing else from that
 * file is in scope.
 */
function extractToolTag(content: string, tagName: string): string | null {
  const open = `<${tagName}>`;
  const close = `</${tagName}>`;
  const startIdx = content.indexOf(open);
  if (startIdx === -1) return null;
  const valueStart = startIdx + open.length;
  const closeIdx = content.indexOf(close, valueStart);
  if (closeIdx === -1) return null;
  return content.slice(valueStart, closeIdx);
}

/**
 * Local Bash output renderer. Visually equivalent to upstream
 * `UserBashOutputMessage` (extracts `<bash-stdout>` and `<bash-stderr>`
 * tags and renders them in distinct colors), but does not import
 * upstream component because the upstream chain drags `bun:bundle`
 * resolution through a feature-gated `require('../memdir/teamMemPaths')`
 * inside `utils/config.ts` that vitest cannot follow
 * from raw source (only the compiled dist resolves it). Production
 * runtime CAN later be flipped to dispatch to the real upstream
 * component once the dist is in scope; the wire shape
 * (`<bash-stdout>` envelope produced by
 * `session-transcript.formatStructuredToolResult`) is already the
 * upstream-compatible one. Until then this local renderer is the
 * dispatch target for `pickToolResultDispatch === 'bash-output-view'`.
 */
const BASH_OUTPUT_TRUNCATION_LIMIT = 8 * 1024;
const GLOB_TRUNCATION_NOTE =
  "(Results are truncated. Consider using a more specific path or pattern.)";

function truncateForDisplay(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit - 64);
  const dropped = value.length - head.length;
  return `${head}\n… [${dropped} chars truncated]`;
}

/**
 * Local diff renderer for the `Edit` tool. Mirrors the visual
 * contract of upstream `FileEditToolDiff` / `StructuredDiffList` —
 * file-path header, hunk header (`@@ ... @@`) in cyan, additions in
 * green, deletions in red — but does not import upstream because
 * `FileEditToolDiff` requires a live `edits[]` array to call
 * `loadDiffData(file_path, edits)` (which reads the file from disk).
 * AgenC's tool result already contains the computed diff string, so
 * this local renderer parses the diff lines directly. Production
 * runtime can later flip to the upstream component once the TUI
 * propagates the original `edits[]` from the matching tool_use input
 * (`UserToolSuccessMessage` already passes `options.input` to
 * `renderToolResultMessage`).
 */
/** Number of changed diff rows shown inline before collapsing to "… +N more". */
const EDIT_PREVIEW_MAX_LINES = 8;

/**
 * Capped Edit/Write diff preview. Parses the unified-diff body, counts
 * additions/removals for the "(+a -r)" stat line, and renders a compact
 * green/red change list capped to a handful of rows (industry-standard
 * CLI-agent convention). File-header lines (`+++`/`---`) and hunk markers
 * (`@@`) are dropped from the count; only real content changes are shown.
 */
export function EditDiffView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const file = extractToolTag(content, "edit-file") ?? "";
  const diff = extractToolTag(content, "edit-diff") ?? "";
  const displayFile = file.length > 0 ? formatToolPathForDisplay(file) : "";
  if (diff.trim().length === 0) {
    return <Text dimColor>(No changes)</Text>;
  }
  const truncatedDiff = truncateForDisplay(diff, BASH_OUTPUT_TRUNCATION_LIMIT);
  const changes: { readonly kind: "add" | "rem"; readonly code: string }[] = [];
  let additions = 0;
  let removals = 0;
  for (const line of truncatedDiff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+")) {
      additions++;
      changes.push({ kind: "add", code: line.slice(1) });
    } else if (line.startsWith("-")) {
      removals++;
      changes.push({ kind: "rem", code: line.slice(1) });
    }
  }
  const stats = `(+${additions} -${removals})`;
  const shown = changes.slice(0, EDIT_PREVIEW_MAX_LINES);
  const remaining = changes.length - shown.length;
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {displayFile.length > 0 ? `${displayFile} ${stats}` : stats}
      </Text>
      {shown.map((change, idx) => (
        <Text key={idx} color={change.kind === "add" ? "green" : "red"}>
          {`${change.kind === "add" ? "+" : "-"} ${change.code}`}
        </Text>
      ))}
      {remaining > 0 ? (
        <Text dimColor>{`… +${remaining} more ${
          remaining === 1 ? "line" : "lines"
        }`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * Local FileRead renderer. Bold path header, optional line range,
 * monospace content body. Mirrors upstream `FileReadTool/UI.tsx`
 * visual contract without importing it (same bun:bundle / config.ts
 * resolution issue as the Bash and Edit renderers).
 */
export function FileReadView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  // Capped preview (industry-standard CLI-agent convention): one summary line
  // "Read N lines" instead of dumping the whole file body under the call row.
  // Prefer an explicit `<read-lines>start-end>` range when present, else count
  // the lines in `<read-content>`.
  const range = extractToolTag(content, "read-lines") ?? "";
  const body = extractToolTag(content, "read-content") ?? "";
  let lineCount: number | null = null;
  const rangeMatch = range.match(/(\d+)\s*-\s*(\d+)/);
  if (rangeMatch) {
    const start = Number.parseInt(rangeMatch[1]!, 10);
    const end = Number.parseInt(rangeMatch[2]!, 10);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      lineCount = end - start + 1;
    }
  }
  if (lineCount === null && body.length > 0) {
    lineCount = body.replace(/\n$/, "").split("\n").length;
  }
  if (lineCount === null) {
    return <Text dimColor>(empty file)</Text>;
  }
  return (
    <Text dimColor>{`Read ${lineCount} ${lineCount === 1 ? "line" : "lines"}`}</Text>
  );
}

/**
 * Local Write renderer. One-line "Wrote N bytes to <path>" summary.
 * Mirrors upstream `FileWriteTool/UI.tsx` visual contract.
 */
export function FileWriteView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  // Capped preview: the one-line "Wrote N bytes to <path>" summary. The live
  // Write result envelope carries no unified diff (only the summary), so there
  // is no green/red body to render — the summary itself is the compact result.
  const summary = extractToolTag(content, "write-summary") ?? "Wrote file";
  return <Text color="green">{summary}</Text>;
}

/**
 * Local Grep matches renderer. One line per match formatted as
 * `file:line:content`, with file path bolded via Text dimming on the
 * line metadata. Mirrors upstream `GrepTool/UI.tsx` visual contract.
 */
export function GrepMatchesView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  // Capped preview: a single "Found N matches" summary line rather than the
  // full match list under the call row.
  const matchesBlock = extractToolTag(content, "grep-matches") ?? "";
  const matchLines =
    matchesBlock.length > 0
      ? matchesBlock.split("\n").filter((line) => line.trim().length > 0)
      : [];
  if (matchLines.length === 0) {
    return <Text dimColor>No matches</Text>;
  }
  return (
    <Text dimColor>{`Found ${matchLines.length} ${
      matchLines.length === 1 ? "match" : "matches"
    }`}</Text>
  );
}

/**
 * Local Glob path-list renderer. Mirrors upstream `GlobTool/UI.tsx`
 * visual contract — pattern header + one path per line.
 */
export function GlobPathsView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const pattern = extractToolTag(content, "glob-pattern") ?? "";
  const pathsBlock = extractToolTag(content, "glob-paths") ?? "";
  const truncated = extractToolTag(content, "glob-truncated") === "true";
  const paths = pathsBlock.length > 0 ? pathsBlock.split("\n") : [];
  if (paths.length === 0) {
    const emptyHeader = pattern.length > 0 ? `Glob: ${pattern}` : null;
    return (
      <Box flexDirection="column">
        {emptyHeader !== null ? <Text bold>{emptyHeader}</Text> : null}
        <Text dimColor>(no paths)</Text>
        {truncated ? <Text dimColor>{GLOB_TRUNCATION_NOTE}</Text> : null}
      </Box>
    );
  }
  const TRUNCATE_AT = 200;
  const visible = paths.slice(0, TRUNCATE_AT);
  const truncatedCount = paths.length - visible.length;
  const headerText =
    pattern.length > 0
      ? `Glob: ${pattern} (${paths.length} ${
          paths.length === 1 ? "path" : "paths"
        })`
      : null;
  return (
    <Box flexDirection="column">
      {headerText !== null ? <Text bold>{headerText}</Text> : null}
      {visible.map((path, idx) => (
        <Text key={idx}>{path}</Text>
      ))}
      {truncatedCount > 0 ? (
        <Text dimColor>{`… ${truncatedCount} more paths truncated`}</Text>
      ) : null}
      {truncated ? <Text dimColor>{GLOB_TRUNCATION_NOTE}</Text> : null}
    </Box>
  );
}

/**
 * Cross-cutting tool-error renderer. Mirrors upstream
 * `FallbackToolUseErrorMessage` — red-bold header + dimmed message.
 * Used for any tool whose result arrives via the error channel,
 * regardless of tool name.
 */
export function ToolErrorView({
  content,
}: {
  readonly content: string;
}): React.ReactElement {
  const toolName = extractToolTag(content, "tool-error-name") ?? "";
  const message = extractToolTag(content, "tool-error") ?? content;
  return (
    <Box flexDirection="column">
      <Text bold color="red">
        {toolName.length > 0 ? `${toolName} error` : "Tool error"}
      </Text>
      <Text>{message}</Text>
    </Box>
  );
}

/** Default number of stdout lines shown inline under a Run/Bash call row. */
const BASH_PREVIEW_MAX_LINES = 5;
/** Width cap for an individual previewed line (keeps the gutter tidy). */
const MAX_PREVIEW_LINE_WIDTH = 200;

function truncatePreviewWidth(line: string): string {
  if (line.length <= MAX_PREVIEW_LINE_WIDTH) return line;
  return `${line.slice(0, MAX_PREVIEW_LINE_WIDTH - 1)}… [${
    line.length - (MAX_PREVIEW_LINE_WIDTH - 1)
  } chars truncated]`;
}

/**
 * Cap a block to the first `maxLines` non-trailing-whitespace lines (each line
 * also width-capped), appending a "… +K lines" continuation when the block is
 * longer. Matches the common CLI-agent `output_lines` convention.
 */
function capPreviewLines(
  value: string,
  maxLines: number,
): { readonly lines: readonly string[]; readonly remaining: number } {
  const all = value.replace(/\s+$/, "").split("\n").map(truncatePreviewWidth);
  if (all.length <= maxLines) return { lines: all, remaining: 0 };
  return { lines: all.slice(0, maxLines), remaining: all.length - maxLines };
}

export function BashOutputView({
  content,
  verbose: _verbose,
}: {
  readonly content: string;
  readonly verbose?: boolean;
}): React.ReactElement {
  const stdoutRaw = extractToolTag(content, "bash-stdout") ?? "";
  const stderrRaw = extractToolTag(content, "bash-stderr") ?? "";
  // Color the output by exit-code: zero stays plain (success), non-zero
  // surfaces stderr in red so a failed command is visually distinct.
  const exitCodeMatch = content.match(/exit_code=(-?\d+)/);
  const exitCode =
    exitCodeMatch && exitCodeMatch[1] !== undefined
      ? Number.parseInt(exitCodeMatch[1], 10)
      : null;
  const isFailure = exitCode !== null && exitCode !== 0;
  const stdoutTrimmed = stdoutRaw.trim();
  const stderrTrimmed = stderrRaw.trim();
  // Capped stdout: first N lines + "… +K lines". On a non-zero exit the stderr
  // is appended (also capped) so the failure reason is visible inline.
  const isSilent = stdoutTrimmed.length === 0 && stderrTrimmed.length === 0;
  if (isSilent) {
    return (
      <Text dimColor>
        {isFailure ? "(no output, non-zero exit)" : "(No output)"}
      </Text>
    );
  }
  const stdoutCap = capPreviewLines(stdoutTrimmed, BASH_PREVIEW_MAX_LINES);
  const showStderr = isFailure && stderrTrimmed.length > 0;
  const stderrCap = showStderr
    ? capPreviewLines(stderrTrimmed, BASH_PREVIEW_MAX_LINES)
    : null;
  return (
    <Box flexDirection="column">
      {stdoutCap.lines.map((line, idx) => (
        <Text key={`o${idx}`}>{line}</Text>
      ))}
      {stdoutCap.remaining > 0 ? (
        <Text dimColor>{`… +${stdoutCap.remaining} ${
          stdoutCap.remaining === 1 ? "line" : "lines"
        }`}</Text>
      ) : null}
      {stderrCap
        ? stderrCap.lines.map((line, idx) => (
            <Text key={`e${idx}`} color="red">
              {line}
            </Text>
          ))
        : null}
      {stderrCap && stderrCap.remaining > 0 ? (
        <Text dimColor>{`… +${stderrCap.remaining} ${
          stderrCap.remaining === 1 ? "line" : "lines"
        }`}</Text>
      ) : null}
    </Box>
  );
}

type SafeParseResult =
  | { readonly success: true; readonly data: Record<string, unknown> }
  | { readonly success: false; readonly error: Error };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function shortJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (text.length <= 140) return text;
    return `${text.slice(0, 137)}...`;
  } catch {
    return String(value);
  }
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).join("\n");
  if (isRecord(value) && typeof value.content === "string") return value.content;
  return shortJson(value);
}

function filePathFromInput(input: unknown): string {
  const record = objectFromUnknown(input);
  const filePath = record.file_path ?? record.path;
  return typeof filePath === "string" ? filePath : "";
}

function displayFilePathFromInput(input: unknown): string {
  const filePath = filePathFromInput(input);
  return filePath.length > 0 ? formatToolPathForDisplay(filePath) : "";
}

function truncateInline(value: string, limit = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function contentLengthSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return `${value.length} ${value.length === 1 ? "char" : "chars"}`;
}

function commandFromExecInput(record: Record<string, unknown>): string | null {
  const command = record.command ?? record.cmd;
  return typeof command === "string" && command.trim().length > 0
    ? truncateInline(command)
    : null;
}

/**
 * Readable Grep/search arg summary: `"<pattern>" in <path>`. Mirrors the
 * common CLI-agent convention — never a raw JSON dump, never -A/-B flag noise.
 * Falls back to just the quoted pattern when no path is given.
 */
function grepSummaryForInput(record: Record<string, unknown>): string | null {
  const pattern =
    typeof record.pattern === "string"
      ? record.pattern
      : typeof record.query === "string"
        ? record.query
        : null;
  if (pattern === null || pattern.trim().length === 0) return null;
  const rawPath =
    typeof record.path === "string"
      ? record.path
      : typeof record.glob === "string"
        ? record.glob
        : null;
  const displayPath =
    rawPath !== null && rawPath.trim().length > 0
      ? formatToolPathForDisplay(rawPath)
      : "";
  const quoted = `"${truncateInline(pattern, 80)}"`;
  return displayPath.length > 0 ? `${quoted} in ${displayPath}` : quoted;
}

function searchToolsSummary(record: Record<string, unknown>): string {
  const selected =
    Array.isArray(record.select)
      ? record.select.filter((value): value is string => typeof value === "string")
      : typeof record.select === "string"
        ? [record.select]
        : [];
  if (selected.length === 1) return `Select tool: ${selected[0]}`;
  if (selected.length > 1) return `Select tools: ${selected.join(", ")}`;
  if (typeof record.query === "string" && record.query.trim().length > 0) {
    return `Search tools: ${truncateInline(record.query)}`;
  }
  return "Search tools";
}

function formatDollarSkillName(skill: string): string {
  const trimmed = skill.trim().replace(/^\/+/, "").replace(/^\$+/, "");
  return trimmed.length > 0 ? `$${trimmed}` : "$skill";
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function skillInputParts(record: Record<string, unknown>): {
  readonly displayName: string;
  readonly argsPreview: string;
} {
  const rawSkill =
    typeof record.skill === "string"
      ? record.skill
      : typeof record.name === "string"
        ? record.name
        : "";
  const parsedSkill = parseJsonRecord(rawSkill);
  const skill =
    typeof parsedSkill?.skill === "string"
      ? parsedSkill.skill
      : rawSkill;
  const rawArgs =
    typeof parsedSkill?.args === "string"
      ? parsedSkill.args
      : typeof record.args === "string"
        ? record.args
        : "";
  const parsedArgs = parseJsonRecord(rawArgs);
  const argsPreview =
    parsedArgs !== null
      ? Object.entries(parsedArgs)
          .flatMap(([key, value]) =>
            value === undefined || value === null
              ? []
              : [`${key} ${truncateInline(String(value), 72)}`],
          )
          .join(", ")
      : truncateInline(rawArgs, 72);
  return {
    displayName: formatDollarSkillName(skill),
    argsPreview,
  };
}

function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp.");
}

function mcpInputSummary(record: Record<string, unknown>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}: ${shortJson(value)}`)
    .join(", ");
}

function toolUseSummaryForInput(name: string, input: unknown): string {
  const record = objectFromUnknown(input);
  const path = filePathFromInput(record);
  const displayPath = path.length > 0 ? formatToolPathForDisplay(path) : "";
  if (name === "exec_command") {
    return commandFromExecInput(record) ?? "command";
  }
  if (name === "Grep" || name === "Glob") {
    const grep = grepSummaryForInput(record);
    if (grep !== null) return grep;
  }
  if (name === "system.searchTools") {
    return searchToolsSummary(record);
  }
  if (name === "Skill") {
    const { displayName, argsPreview } = skillInputParts(record);
    return argsPreview.length > 0 ? `${displayName}: ${argsPreview}` : displayName;
  }
  if (isMcpToolName(name)) {
    return mcpInputSummary(record);
  }
  if (name === "Write" || name === "MultiEdit") {
    // Readable args = the file path only (no char-count noise). The result
    // preview carries the size/diff stats under the call row.
    return displayPath.length > 0 ? displayPath : "file";
  }
  if (name === "Edit") {
    // Readable args = the file path only. The "(+a -r)" stats + diff are
    // surfaced in the result preview, not stuffed into the args row.
    return displayPath.length > 0 ? displayPath : "edit";
  }
  if (name === "Bash" && typeof record.command === "string") {
    return truncateInline(record.command);
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const size = contentLengthSummary(value);
    if (
      size !== null &&
      (key === "content" || key === "old_string" || key === "new_string")
    ) {
      sanitized[key] = `[${size}]`;
    } else if (typeof value === "string") {
      sanitized[key] = truncateInline(value);
    } else {
      sanitized[key] = value;
    }
  }
  const summary = shortJson(sanitized);
  return summary.length > 0 ? summary : name;
}

function userFacingNameForTool(name: string): string {
  if (name === "exec_command") return "Run";
  if (name === "system.searchTools") return "Tool search";
  return name;
}

function userFacingNameForInput(name: string, input: unknown): string {
  if (name === "Skill") {
    return skillInputParts(objectFromUnknown(input)).displayName;
  }
  return userFacingNameForTool(name);
}

function skillToolUseMessage(input: unknown): string {
  return skillInputParts(objectFromUnknown(input)).argsPreview;
}

function activityDescriptionForTool(name: string, input: unknown): string {
  const summary = toolUseSummaryForInput(name, input);
  if (name === "exec_command") {
    return summary.length > 0 ? `Run: ${summary}` : "Run command";
  }
  if (name === "system.searchTools") return summary;
  if (name === "Skill") return summary.length > 0 ? `Load ${summary}` : "Load skill";
  if (isMcpToolName(name)) {
    return summary.length > 0 ? `${name} ${summary}` : name;
  }
  return `${name} ${summary}`;
}

export function createTuiTool(name: string): any {
  if (name === "AskUserQuestion") {
    return AskUserQuestionTool;
  }
  const fileReadOverrides =
    name === "FileRead"
      ? {
          getPath(input: unknown) {
            return filePathFromInput(input);
          },
          getActivityDescription(input: unknown) {
            const filePath = displayFilePathFromInput(input);
            return filePath.length > 0 ? `Reading ${filePath}` : "Reading file";
          },
          isReadOnly() {
            return true;
          },
          renderToolUseMessage(input: unknown) {
            return displayFilePathFromInput(input) || "file";
          },
          userFacingName() {
            return "Read";
          },
        }
      : {};
  const fallbackTool = {
    name,
    aliases: [],
    maxResultSizeChars: Infinity,
    inputSchema: {
      safeParse(input: unknown): SafeParseResult {
        return { success: true, data: objectFromUnknown(input) };
      },
    },
    async call() {
      return { result: undefined };
    },
    async description() {
      return name;
    },
    async prompt() {
      return `${name} is provided by the AgenC runtime.`;
    },
    async checkPermissions() {
      return { behavior: "ask", message: `Permission required to use ${name}` };
    },
    isConcurrencySafe() {
      return false;
    },
    isEnabled() {
      return true;
    },
    isReadOnly() {
      return false;
    },
    isDestructive() {
      return false;
    },
    toAutoClassifierInput(input: unknown) {
      return input;
    },
    userFacingName(input: unknown) {
      return userFacingNameForInput(name, input);
    },
    getActivityDescription(input: unknown) {
      return activityDescriptionForTool(name, input);
    },
    renderToolUseMessage(input: unknown) {
      return name === "Skill"
        ? skillToolUseMessage(input)
        : toolUseSummaryForInput(name, input);
    },
    renderToolResultMessage(
      content: unknown,
      _progress: unknown,
      options?: { readonly verbose?: boolean },
    ) {
      // Per-tool dispatch table. Routes recognized tool results to
      // local upstream-compatible renderers; unrouted tool names fall
      // through to the generic <Text> rendering below. Dispatch
      // decision lives in the JSX-free
      // `tool-result-routing.ts` so unit tests
      // can exercise the routing logic without dragging the upstream
      // component chain into vitest.
      const joined = resultTextForTuiTool(content);
      const target = pickToolResultDispatch(name, joined);
      switch (target) {
        case "tool-error-view":
          return <ToolErrorView content={joined} />;
        case "bash-output-view":
          return (
            <BashOutputView
              content={joined}
              verbose={options?.verbose ?? false}
            />
          );
        case "edit-diff-view":
          return <EditDiffView content={joined} />;
        case "file-read-view":
          return <FileReadView content={joined} />;
        case "file-write-view":
          return <FileWriteView content={joined} />;
        case "grep-matches-view":
          return <GrepMatchesView content={joined} />;
        case "glob-paths-view":
          return <GlobPathsView content={joined} />;
        case "generic":
        default:
          return (
            <Box flexDirection="column">
              <Text>{joined}</Text>
            </Box>
          );
      }
    },
    renderToolUseErrorMessage(error: unknown) {
      // Cross-cutting error path: format and dispatch to ToolErrorView.
      // Any tool whose result reaches this path renders with the same
      // red-bold-header style as the upstream FallbackToolUseErrorMessage.
      const message =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error &&
              typeof (error as { message: unknown }).message === "string"
            ? (error as { message: string }).message
            : shortJson(error);
      const envelope = `<tool-error-name>${name}</tool-error-name>\n<tool-error>${message}</tool-error>`;
      return <ToolErrorView content={envelope} />;
    },
    mapToolResultToToolResultBlockParam(content: unknown, toolUseID: string) {
      return {
        type: "tool_result",
        tool_use_id: toolUseID,
        content: resultTextForTuiTool(content),
      };
    },
  };
  return {
    ...fallbackTool,
    ...fileReadOverrides,
  };
}

/**
 * Pre-seed names for tools the TUI dispatches to a structured
 * renderer. These match the live registered tool names in
 * `runtime/src/tools/system/*.ts` (NOT the upstream-product naming —
 * e.g. AgenC's read tool is `FileRead`, not `Read`). If a tool is
 * pre-seeded that the live runtime never registers, the TUI entry
 * is harmless (just unused). If a tool the runtime DOES register is
 * NOT pre-seeded, `createTuiTools` still adds it on the fly when
 * its name flows through `transcript.toolNames`.
 *
 * `Task`, `Agent`, and `mcp__*` names from the previous TUI-only list are
 * intentionally absent: AgenC's agent layer uses `spawn_agent` (a
 * different lifecycle than upstream's Task), and MCP tools are
 * registered with dynamic `mcp__<server>__<tool>` names. Both require
 * a separate dispatch contract beyond exact-case routing.
 */
export function createTuiTools(names: Iterable<string>): readonly any[] {
  const unique = new Set<string>([
    "AskUserQuestion",
    "Bash",
    "Edit",
    "FileRead",
    "Write",
    "Grep",
    "Glob",
  ]);
  for (const name of names) {
    if (name.trim().length > 0) unique.add(name);
  }
  return [...unique].sort().map(createTuiTool);
}
