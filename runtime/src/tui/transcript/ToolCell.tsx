/**
 * Semantic tool-call history cell.
 *
 * AgenC keeps the transcript chrome branded, but the behavior follows the
 * upstream Codex/OpenClaude shape: one semantic cell per tool invocation,
 * tool-family aware labels, in-place progress, and compact result previews.
 */

import React, { useMemo } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";

import { collapseOutput } from "./ExecCell.js";
import { sanitizeTranscriptText } from "./sanitize.js";

type ToolFamily = "read" | "write" | "edit" | "mcp" | "search" | "generic";
const TOOL_ARGS_MAX = 100;

export interface ToolCellProps {
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly isComplete?: boolean;
  readonly isError?: boolean;
  readonly result?: string;
  readonly progress?: string;
}

interface ToolPresentation {
  readonly family: ToolFamily;
  readonly runningVerb: string;
  readonly doneVerb: string;
  readonly target: string;
  readonly argsSummary: string;
  readonly preserveResultLines: boolean;
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
  if (toolName === "system.readFile") return "read";
  if (toolName === "system.writeFile" || toolName === "system.appendFile") return "write";
  if (toolName === "system.editFile") return "edit";
  if (toolName === "system.grep" || toolName === "system.glob" || toolName === "system.listDir") {
    return "search";
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
  if (family === "generic" && toolName) return toolName;
  const path = readStringField(toolArgs, ["path", "file_path", "cwd"]);
  if (path) return path;
  const command = readStringField(toolArgs, ["command", "cmd"]);
  if (command) return command;
  const query = readStringField(toolArgs, ["pattern", "query", "q"]);
  if (query) return query;
  return toolName ?? "tool";
}

function buildPresentation(
  toolName: string | undefined,
  toolArgs: unknown,
): ToolPresentation {
  const family = classifyTool(toolName);
  const target = toolTarget(family, toolName, toolArgs);
  const argsSummary = compactJson(toolArgs);
  switch (family) {
    case "read":
      return {
        family,
        runningVerb: "Reading",
        doneVerb: "Read",
        target,
        argsSummary,
        preserveResultLines: true,
      };
    case "write":
      return {
        family,
        runningVerb: "Writing",
        doneVerb: "Wrote",
        target,
        argsSummary,
        preserveResultLines: false,
      };
    case "edit":
      return {
        family,
        runningVerb: "Editing",
        doneVerb: "Edited",
        target,
        argsSummary,
        preserveResultLines: false,
      };
    case "mcp":
      return {
        family,
        runningVerb: "Calling",
        doneVerb: "Called",
        target,
        argsSummary,
        preserveResultLines: false,
      };
    case "search":
      return {
        family,
        runningVerb: "Searching",
        doneVerb: "Searched",
        target,
        argsSummary,
        preserveResultLines: false,
      };
    case "generic":
      return {
        family,
        runningVerb: "Calling",
        doneVerb: "Called",
        target,
        argsSummary,
        preserveResultLines: false,
      };
  }
}

function stripMcpEnvelope(input: string): string {
  return input.replace(/^Wall time: [^\n]*\nOutput:\n?/u, "").trimEnd();
}

function normalizeResult(family: ToolFamily, value: string | undefined): string {
  if (!value) return "";
  const sanitized = sanitizeTranscriptText(value);
  if (family === "mcp") return stripMcpEnvelope(sanitized);
  return sanitized.trimEnd();
}

function renderIndentedText(
  content: string,
  preserveLines: boolean,
  color?: string,
): React.ReactElement[] {
  const normalized = preserveLines ? content : collapseOutput(content, 4, 2);
  return normalized.split("\n").map((line, index) => (
    <Box key={`line-${index}`} flexDirection="row">
      <Text dim>{index === 0 ? "  └ " : "    "}</Text>
      <Text {...(color ? { color } : {})} dim>
        {line.length > 0 ? line : " "}
      </Text>
    </Box>
  ));
}

export const ToolCell: React.FC<ToolCellProps> = ({
  toolName,
  toolArgs,
  isComplete = false,
  isError = false,
  result,
  progress,
}) => {
  const presentation = useMemo(
    () => buildPresentation(toolName, toolArgs),
    [toolName, toolArgs],
  );
  const normalizedResult = useMemo(
    () => normalizeResult(presentation.family, result),
    [presentation.family, result],
  );
  const normalizedProgress = useMemo(
    () => sanitizeTranscriptText(progress ?? "").trimEnd(),
    [progress],
  );

  const statusColor = isError
    ? theme.colors.error
    : isComplete
      ? theme.colors.success
      : theme.colors.dim;
  const glyph = isError ? "✗" : isComplete ? "✓" : "·";
  const verb = isComplete ? presentation.doneVerb : presentation.runningVerb;
  const detail =
    normalizedResult.length > 0
      ? normalizedResult
      : normalizedProgress.length > 0
        ? normalizedProgress
        : "";
  const showArgs =
    presentation.family === "generic" &&
    presentation.argsSummary.length > 0 &&
    presentation.argsSummary !== "{}";

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor}>{glyph}</Text>
        <Text> </Text>
        <Text bold>{verb}</Text>
        <Text> </Text>
        <Text>{presentation.target}</Text>
        {showArgs ? <Text dim>{` ${presentation.argsSummary}`}</Text> : null}
      </Box>
      {detail.length > 0
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
