/**
 * Semantic tool-call history cell.
 *
 * AgenC keeps the transcript chrome branded, but the behavior follows the
 * upstream codex runtime/AgenC shape: one semantic cell per tool invocation,
 * tool-family aware labels, in-place progress, and compact result previews.
 */

import React, { useEffect, useMemo, useState } from "react";

import { Ansi } from "../ink/Ansi.js";
import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { renderHighlightedCodeLines, type HighlightedCodeLine } from "../render/code-highlight.js";
import {
  looksLikeDiffText,
  renderDiffDisplayLines,
} from "../render/diff-display.js";
import { theme } from "../theme.js";

import { DisplayLineBlock } from "./DisplayLineBlock.js";
import { collapseOutput } from "./ExecCell.js";
import { sanitizeTranscriptText } from "./sanitize.js";
import {
  renderToolPresentation,
  type ToolRenderTone,
} from "./tool-renderers.js";
import {
  compactRecoverableToolFailureMessage,
  recoverableFailureKind,
} from "../../tools/result-metadata.js";

type ToolFamily =
  | "read"
  | "list"
  | "write"
  | "edit"
  | "mcp"
  | "search"
  | "exec"
  | "generic";
const TOOL_ARGS_MAX = 100;
const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

export interface ToolCellProps {
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly isComplete?: boolean;
  readonly isError?: boolean;
  readonly result?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly progress?: string;
}

interface ToolPresentation {
  readonly family: ToolFamily;
  readonly target: string;
  readonly argsSummary: string;
  readonly preserveResultLines: boolean;
}

interface ShellWriteBlockSummary {
  readonly target: string;
  readonly detail: string;
}

interface NumberedCodeLine {
  readonly prefix: string;
  readonly text: string;
  readonly plainText: string;
}

interface FileMutationSummary {
  readonly filePath: string;
  readonly operation: "create" | "write" | "edit";
  readonly additions: number;
  readonly removals: number;
  readonly replacements?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim().length > 0) {
      return field.trim();
    }
  }
  return undefined;
}

function readRawStringField(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string") {
      return field;
    }
  }
  return undefined;
}

function compactJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  let rendered: string;
  if (typeof value === "string") {
    rendered = sanitizeTranscriptText(value);
  } else {
    try {
      rendered = sanitizeTranscriptText(JSON.stringify(value));
    } catch {
      rendered = sanitizeTranscriptText(String(value));
    }
  }
  return rendered.length > TOOL_ARGS_MAX
    ? `${rendered.slice(0, TOOL_ARGS_MAX - 1)}…`
    : rendered;
}

function parseJsonRecord(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatNumberField(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

function summarizeExecJsonResult(parsed: Record<string, unknown>): string {
  const stdout =
    typeof parsed.stdout === "string"
      ? parsed.stdout
      : typeof parsed.output === "string"
        ? parsed.output
        : "";
  const stderr = typeof parsed.stderr === "string" ? parsed.stderr : "";
  return [stdout.trimEnd(), stderr.trimEnd()]
    .filter((entry) => entry.length > 0)
    .join("\n");
}

function summarizeStructuredResult(
  toolName: string | undefined,
  family: ToolFamily,
  value: string,
): string | null {
  const parsed = parseJsonRecord(value);
  if (!parsed) return null;

  if (typeof parsed.error === "string") {
    return parsed.error;
  }

  if (family === "exec") {
    return summarizeExecJsonResult(parsed);
  }

  if (family === "write") {
    return "";
  }

  if (family === "edit") {
    const replacements = formatNumberField(parsed.replacements);
    if (replacements !== undefined) {
      return `${replacements} replacement${replacements === "1" ? "" : "s"}`;
    }
    return "";
  }

  return null;
}

function summarizeShellWriteBlock(
  value: string | undefined,
): ShellWriteBlockSummary | null {
  if (!value) return null;
  const parsed = parseJsonRecord(value);
  const error = typeof parsed?.error === "string" ? parsed.error : value;
  if (!error.includes("shell_workspace_file_write_disallowed")) return null;
  const targetMatch = /Blocked target\(s\):\s*(.+)$/u.exec(error);
  const target = targetMatch?.[1]?.trim() ?? "workspace file";
  return {
    target: "shell write",
    detail: `Blocked target: ${target}. Use Edit (or Write for new files) for source edits.`,
  };
}

function isMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp.") || toolName.startsWith("mcp__");
}

function displayMcpName(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    return toolName.replace(/^mcp__/, "").replace(/__/g, ".");
  }
  if (toolName.startsWith("mcp.")) {
    return toolName.slice("mcp.".length);
  }
  return toolName;
}

function classifyTool(toolName: string | undefined): ToolFamily {
  if (!toolName) return "generic";
  const normalized = toolName.toLowerCase();
  if (
    normalized === "fileread" ||
    normalized === "readfile" ||
    normalized === "read_file"
  ) {
    return "read";
  }
  if (
    normalized === "write" ||
    normalized === "writefile" ||
    normalized === "write_file"
  ) {
    return "write";
  }
  if (
    normalized === "edit" ||
    normalized === "editfile" ||
    normalized === "edit_file"
  ) {
    return "edit";
  }
  if (
    normalized === "system.grep" ||
    normalized === "grep" ||
    normalized === "system.glob" ||
    normalized === "glob"
  ) {
    return "search";
  }
  if (
    normalized === "system.listdir" ||
    normalized === "system.list_dir" ||
    normalized === "listdir" ||
    normalized === "list_dir" ||
    normalized === "ls"
  ) {
    return "list";
  }
  if (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "exec_command" ||
    normalized === "system.bash" ||
    normalized === "desktop.bash"
  ) {
    return "exec";
  }
  if (isMcpToolName(toolName)) return "mcp";
  return "generic";
}

function toolTarget(
  family: ToolFamily,
  toolName: string | undefined,
  toolArgs: unknown,
): string {
  if (family === "mcp" && toolName) return displayMcpName(toolName);
  if (family === "exec") {
    const command = readStringField(toolArgs, ["command", "cmd"]);
    return command ? compactJson(command) : toolName ?? "exec";
  }
  const path = readStringField(toolArgs, ["path", "file_path", "cwd"]);
  if (path) return path;
  const command = readStringField(toolArgs, ["command", "cmd"]);
  if (command) return command;
  const query = readStringField(toolArgs, ["pattern", "query", "q"]);
  if (query) return query;
  return family === "generic" ? "" : toolName ?? "tool";
}

function buildPresentation(
  toolName: string | undefined,
  toolArgs: unknown,
): ToolPresentation {
  const family = classifyTool(toolName);
  const target = toolTarget(family, toolName, toolArgs);
  switch (family) {
    case "read":
    case "list":
      return {
        family,
        target,
        argsSummary: "",
        preserveResultLines: true,
      };
    case "write":
      return {
        family,
        target,
        argsSummary: "",
        preserveResultLines: false,
      };
    case "edit":
      return {
        family,
        target,
        argsSummary: "",
        preserveResultLines: false,
      };
    case "mcp":
      return {
        family,
        target,
        argsSummary: "",
        preserveResultLines: false,
      };
    case "search":
      return {
        family,
        target,
        argsSummary: "",
        preserveResultLines: false,
      };
    case "exec":
      return {
        family,
        target,
        argsSummary: "",
        preserveResultLines: false,
      };
    case "generic":
      return {
        family,
        target,
        argsSummary: compactJson(toolArgs),
        preserveResultLines: false,
      };
  }
}

function familyFromTone(tone: ToolRenderTone | undefined): ToolFamily | null {
  switch (tone) {
    case "read":
      return "read";
    case "list":
      return "list";
    case "write":
      return "write";
    case "edit":
    case "notebook":
      return "edit";
    case "search":
    case "web":
    case "lsp":
      return "search";
    case "exec":
      return "exec";
    case "mcp":
      return "mcp";
    case "agent":
    case "task":
    case "team":
    case "schedule":
    case "plan":
    case "skill":
    case "generic":
    case undefined:
      return null;
  }
}

function stripMcpEnvelope(input: string): string {
  return input.replace(/^Wall time: [^\n]*\nOutput:\n?/u, "").trimEnd();
}

function normalizeResult(
  toolName: string | undefined,
  family: ToolFamily,
  value: string | undefined,
): string {
  if (!value) return "";
  const sanitized = sanitizeTranscriptText(value);
  const structured = summarizeStructuredResult(toolName, family, sanitized);
  if (structured !== null) return structured.trimEnd();
  if (family === "mcp") return stripMcpEnvelope(sanitized);
  return sanitized.trimEnd();
}

function readFileMutationSummary(
  metadata: Readonly<Record<string, unknown>> | undefined,
): FileMutationSummary | null {
  if (!isRecord(metadata)) return null;
  const ui = metadata.ui;
  if (!isRecord(ui) || ui.kind !== "file_mutation") return null;
  const filePath = typeof ui.filePath === "string" ? ui.filePath : "";
  const operation =
    ui.operation === "create" ||
    ui.operation === "write" ||
    ui.operation === "edit"
      ? ui.operation
      : undefined;
  const additions = typeof ui.additions === "number" ? ui.additions : undefined;
  const removals = typeof ui.removals === "number" ? ui.removals : undefined;
  const replacements =
    typeof ui.replacements === "number" ? ui.replacements : undefined;
  if (
    !filePath ||
    operation === undefined ||
    additions === undefined ||
    removals === undefined
  ) {
    return null;
  }
  return {
    filePath,
    operation,
    additions,
    removals,
    ...(replacements !== undefined ? { replacements } : {}),
  };
}

function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarizeFileMutation(summary: FileMutationSummary): string {
  if (summary.operation === "create") {
    return summary.additions > 0
      ? `Added ${pluralize(summary.additions, "line")}`
      : "Created file";
  }
  const parts: string[] = [];
  if (summary.additions > 0) {
    parts.push(`Added ${pluralize(summary.additions, "line")}`);
  }
  if (summary.removals > 0) {
    parts.push(
      `${parts.length === 0 ? "Removed" : "removed"} ${pluralize(
        summary.removals,
        "line",
      )}`,
    );
  }
  if (parts.length > 0) return parts.join(", ");
  if (summary.replacements !== undefined) {
    return pluralize(summary.replacements, "replacement");
  }
  return "Updated file";
}

function compactToolErrorResult(family: ToolFamily, value: string): string {
  if (value.includes("File has not been read yet")) {
    return "File must be read first";
  }
  if (
    value.includes("File does not exist") ||
    value.includes("ENOENT") ||
    value.startsWith("File not found")
  ) {
    return "File not found";
  }
  if (family === "edit") return "Error editing file";
  if (family === "write") return "Error writing file";
  return value;
}

function renderIndentedText(
  content: string,
  preserveLines: boolean,
  color?: string,
): React.ReactElement[] {
  const normalized = preserveLines ? content : collapseOutput(content, 4, 2);
  // Mirror AgenC's `MessageResponse` two-column flex layout
  // (components/MessageResponse.tsx): one row, the `⎿  ` prefix rendered
  // ONCE in a `flexShrink={0}` column, the entire content rendered as a
  // single `<Text>` inside a `flexGrow={1}` column. Yoga places wrap
  // continuation rows at the content column's `getComputedLeft()` (≈ col
  // 5), so a long source line that wraps inherits the cell indent
  // automatically — no per-line re-indent needed.
  return [
    <Box key="tool-result" flexDirection="row">
      <Box flexShrink={0}>
        <Text dim>{"  ⎿  "}</Text>
      </Box>
      <Box flexShrink={1} flexGrow={1}>
        <Text {...(color ? { color } : {})} dim>
          {normalized.length > 0 ? normalized : " "}
        </Text>
      </Box>
    </Box>,
  ];
}

function toolTitle(
  toolName: string | undefined,
  family: ToolFamily,
  isComplete: boolean,
  isError: boolean,
  shellWriteBlocked: boolean,
): string {
  if (shellWriteBlocked) return "Blocked";
  switch (family) {
    case "read":
      if (isError) return "Read Failed";
      return isComplete ? "Read" : "Reading";
    case "list":
      if (isError) return "List Failed";
      return isComplete ? "List" : "Listing";
    case "write":
      if (isError) return "Write Failed";
      return isComplete ? "Write" : "Writing";
    case "edit":
      if (isError) return "Edit Failed";
      return isComplete ? "Edit" : "Editing";
    case "mcp":
      return isError ? "MCP Failed" : "MCP";
    case "search":
      if (isError) return "Search Failed";
      return isComplete ? "Search" : "Searching";
    case "exec":
      return isError ? "Bash Failed" : "Bash";
    case "generic":
      if (isError) return toolName ? `${toolName} Failed` : "Tool Failed";
      return toolName ?? (isComplete ? "Tool" : "Running Tool");
  }
}

function resultDiffLines(value: string): ReturnType<typeof renderDiffDisplayLines> {
  return looksLikeDiffText(value) ? renderDiffDisplayLines(value) : [];
}

function diffFromEditArgs(family: ToolFamily, toolArgs: unknown): string {
  if (family !== "edit") return "";
  const beforeText = readRawStringField(toolArgs, [
    "old_string",
    "oldString",
    "old_text",
    "oldText",
    "before",
  ]);
  const afterText = readRawStringField(toolArgs, [
    "new_string",
    "newString",
    "new_text",
    "newText",
    "after",
  ]);
  if (
    beforeText === undefined ||
    afterText === undefined ||
    beforeText === afterText
  ) {
    return "";
  }
  const beforeLines = beforeText.split("\n").map((line) => `-${line}`);
  const afterLines = afterText.split("\n").map((line) => `+${line}`);
  return [
    "--- before",
    "+++ after",
    "@@ replace @@",
    ...beforeLines,
    ...afterLines,
  ].join("\n");
}

function isNoOpEditFailure(
  family: ToolFamily,
  toolArgs: unknown,
  normalizedResult: string,
  isError: boolean,
): boolean {
  if (!isError || family !== "edit") return false;
  const beforeText = readRawStringField(toolArgs, [
    "old_string",
    "oldString",
    "before",
  ]);
  const afterText = readRawStringField(toolArgs, [
    "new_string",
    "newString",
    "after",
  ]);
  if (beforeText !== undefined && beforeText === afterText) return true;
  return normalizedResult.includes(
    "No changes to make: old_string and new_string are exactly the same.",
  );
}

function isSilentReadSearchFailure(
  family: ToolFamily,
  isError: boolean,
): boolean {
  return (
    isError &&
    (family === "read" || family === "search" || family === "list")
  );
}

function readFilePathForHighlight(
  family: ToolFamily,
  target: string,
): string | null {
  if (family !== "read" || target.length === 0) return null;
  if (!/\.[A-Za-z0-9]+(?:$|[#?:])/u.test(target)) return null;
  return target;
}

function splitNumberedCodeLine(line: string): NumberedCodeLine {
  const match = /^(\s*\d+(?:→|:|\|)\s?)(.*)$/u.exec(line);
  if (!match) {
    return { prefix: "", text: line, plainText: line };
  }
  return {
    prefix: match[1] ?? "",
    text: match[2] ?? "",
    plainText: match[2] ?? "",
  };
}

function useHighlightedNumberedCode(
  content: string,
  filePath: string | null,
): readonly NumberedCodeLine[] | null {
  const [highlighted, setHighlighted] = useState<readonly NumberedCodeLine[] | null>(null);

  useEffect(() => {
    if (filePath === null || content.length === 0 || content.length > 50_000) {
      setHighlighted(null);
      return undefined;
    }
    let cancelled = false;
    const parsed = content.split("\n").map(splitNumberedCodeLine);
    const code = parsed.map((line) => line.plainText).join("\n");
    void renderHighlightedCodeLines({
      code,
      filePath,
      width: 10_000,
    }).then((lines: readonly HighlightedCodeLine[] | null) => {
      if (cancelled) return;
      if (lines === null || lines.length !== parsed.length) {
        setHighlighted(null);
        return;
      }
      setHighlighted(
        lines.map((line, index) => ({
          prefix: parsed[index]?.prefix ?? "",
          text: line.text,
          plainText: line.plainText,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [content, filePath]);

  return highlighted;
}

export const ToolCell: React.FC<ToolCellProps> = ({
  toolName,
  toolArgs,
  isComplete = false,
  isError = false,
  result,
  metadata,
  progress,
}) => {
  const rendererPresentation = useMemo(
    () =>
      renderToolPresentation({
        toolName,
        toolArgs,
        result,
        progress,
        metadata,
        isComplete,
        isError,
      }),
    [isComplete, isError, metadata, progress, result, toolArgs, toolName],
  );
  const presentation = useMemo(
    () => {
      const fallback = buildPresentation(toolName, toolArgs);
      const toneFamily = familyFromTone(rendererPresentation?.tone);
      return {
        family: toneFamily ?? fallback.family,
        target: rendererPresentation?.target ?? fallback.target,
        argsSummary: fallback.argsSummary,
        preserveResultLines:
          rendererPresentation?.preserveResultLines ??
          fallback.preserveResultLines,
      };
    },
    [rendererPresentation, toolName, toolArgs],
  );
  const normalizedResult = useMemo(
    () => normalizeResult(toolName, presentation.family, result),
    [toolName, presentation.family, result],
  );
  const normalizedProgress = useMemo(
    () => sanitizeTranscriptText(progress ?? "").trimEnd(),
    [progress],
  );
  const shellWriteBlock = useMemo(
    () =>
      recoverableFailureKind(metadata) === "shell_workspace_write_policy"
        ? null
        : summarizeShellWriteBlock(result),
    [metadata, result],
  );
  const recoverableFailureDetail = useMemo(
    () => compactRecoverableToolFailureMessage(metadata),
    [metadata],
  );
  const fileMutationSummary = useMemo(
    () => readFileMutationSummary(metadata),
    [metadata],
  );
  const diffDetailLines = useMemo(
    () =>
      shellWriteBlock === null && !isError && isComplete
        ? resultDiffLines(
            normalizedResult.length > 0
              ? normalizedResult
              : diffFromEditArgs(presentation.family, toolArgs),
          )
        : [],
    [
      isComplete,
      isError,
      normalizedResult,
      presentation.family,
      shellWriteBlock,
      toolArgs,
    ],
  );
  const highlightedReadFilePath = readFilePathForHighlight(
    presentation.family,
    presentation.target,
  );
  const highlightedReadLines = useHighlightedNumberedCode(
    normalizedResult,
    highlightedReadFilePath,
  );
  const suppressCell =
    rendererPresentation?.hide === true ||
    isNoOpEditFailure(
      presentation.family,
      toolArgs,
      normalizedResult,
      isError,
    ) || isSilentReadSearchFailure(presentation.family, isError);
  if (suppressCell) return null;

  const statusColor = isError
    ? theme.colors.error
    : isComplete
      ? theme.colors.success
      : theme.colors.dim;
  const glyph = BLACK_CIRCLE;
  const title = toolTitle(
    toolName,
    presentation.family,
    isComplete,
    isError,
    shellWriteBlock !== null,
  );
  let detail = "";
  if (recoverableFailureDetail !== null) {
    detail = recoverableFailureDetail;
  } else if (shellWriteBlock) {
    detail = shellWriteBlock.detail;
  } else if (isError && normalizedResult.length > 0) {
    detail = compactToolErrorResult(presentation.family, normalizedResult);
  } else if (fileMutationSummary !== null) {
    detail = summarizeFileMutation(fileMutationSummary);
  } else if (rendererPresentation?.detail !== undefined) {
    detail = sanitizeTranscriptText(rendererPresentation.detail).trimEnd();
  } else if (
    normalizedResult.length > 0 &&
    !(presentation.family === "write" && !isError)
  ) {
    detail = normalizedResult;
  } else if (normalizedProgress.length > 0) {
    detail = normalizedProgress;
  }
  const showArgs =
    shellWriteBlock === null &&
    rendererPresentation === null &&
    presentation.family === "generic" &&
    presentation.argsSummary.length > 0 &&
    presentation.argsSummary !== "{}";
  const target = shellWriteBlock?.target ?? presentation.target;
  const effectiveTitle =
    shellWriteBlock !== null ? title : rendererPresentation?.title ?? title;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor} dim={!isComplete && !isError}>{glyph}</Text>
        <Text> </Text>
        <Text bold>{effectiveTitle}</Text>
        {target.length > 0 ? <Text dim>{`(${target})`}</Text> : null}
        {showArgs ? <Text dim>{` ${presentation.argsSummary}`}</Text> : null}
      </Box>
      {diffDetailLines.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          <DisplayLineBlock lines={diffDetailLines} />
        </Box>
      ) : highlightedReadLines !== null ? (
        <Box flexDirection="column">
          {highlightedReadLines.map((line, index) => (
            <Box key={`read-code-${index}`} flexDirection="row">
              <Text dim>{index === 0 ? "  ⎿  " : "     "}</Text>
              {line.prefix.length > 0 ? <Text dim>{line.prefix}</Text> : null}
              <Ansi>{line.text}</Ansi>
            </Box>
          ))}
        </Box>
      ) : detail.length > 0
        ? renderIndentedText(
            detail,
            presentation.preserveResultLines,
            isError ? theme.colors.error : undefined,
          )
        : null}
    </Box>
  );
};

export default ToolCell;
