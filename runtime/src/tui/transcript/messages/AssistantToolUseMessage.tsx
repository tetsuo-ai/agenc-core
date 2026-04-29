/**
 * AssistantToolUseMessage — renders an assistant tool-use call row.
 *
 * Adapted from upstream's `components/messages/AssistantToolUseMessage.tsx`.
 *
 * Differences from upstream:
 *   - Upstream looked up a `Tool` instance by name and routed through the
 *     tool's `renderToolUseMessage`/`renderToolUseProgressMessage` hooks
 *     (per-tool React renderers shipped from `upstream/src/tools/*`).
 *     AgenC has no such per-tool renderer registry yet — instead it has
 *     a structured `tool-renderers.ts` registry that returns a tone +
 *     title + target presentation. We use that to produce the inline
 *     summary; if no specific renderer matches we fall back to a plain
 *     `tool: <name>` body.
 *   - The tool-cell variant lives in `transcript/ToolCell.tsx`. This row
 *     is just the assistant-side announcement — the dot, the tool name
 *     (bold), and a one-line argument hint. The detailed tool result
 *     stays with `ToolCell`/`ExecCell` so we don't double-render.
 *
 * @module
 */

import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";
import {
  renderToolPresentation,
  toolRendererTone,
} from "../tool-renderers.js";

const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

export interface AssistantToolUseMessageProps {
  readonly toolName: string;
  readonly input: unknown;
  readonly addMargin?: boolean;
  readonly shouldShowDot?: boolean;
  /** True while the tool is still in flight (dim the dot). */
  readonly inProgress?: boolean;
  /** True if the tool already completed in error. */
  readonly isError?: boolean;
  /** Optional override for the bold title. Falls back to the tool name. */
  readonly userFacingToolName?: string;
}

function summarizeArgs(value: unknown, max = 80): string {
  if (typeof value === "string") {
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
  }
  if (value === undefined || value === null) return "";
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string" || json.length === 0) return "";
    return json.length <= max ? json : `${json.slice(0, max - 1)}…`;
  } catch {
    return "";
  }
}

export function AssistantToolUseMessage({
  toolName,
  input,
  addMargin = false,
  shouldShowDot = true,
  inProgress = false,
  isError = false,
  userFacingToolName,
}: AssistantToolUseMessageProps): React.ReactElement | null {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return null;
  }

  // Try the AgenC tool-renderer registry for a structured summary first;
  // the registry knows tool-specific presentation (e.g. read tool shows the
  // file path, exec tool shows the command). Falls back to a generic
  // `tool: <name>` line when no specific renderer is registered.
  const presentation = renderToolPresentation({
    toolName,
    toolArgs: input,
    isComplete: !inProgress,
    isError,
  });

  const title =
    userFacingToolName && userFacingToolName.length > 0
      ? userFacingToolName
      : presentation?.title ?? toolName;

  const target = presentation?.target ?? summarizeArgs(input);
  const tone = presentation?.tone ?? toolRendererTone(toolName);

  const dotColor = isError
    ? theme.colors.error
    : inProgress
      ? theme.colors.dim
      : theme.colors.success;

  const titleColor =
    tone === "exec"
      ? theme.colors.accent
      : tone === "agent" || tone === "task" || tone === "team"
        ? theme.colors.primary
        : undefined;

  const dot = shouldShowDot ? (
    <Box minWidth={2} flexShrink={0}>
      <Text color={dotColor}>{BLACK_CIRCLE}</Text>
    </Box>
  ) : null;

  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      {dot}
      <Box flexShrink={0}>
        <Text bold color={titleColor} wrap="truncate-end">
          {title}
        </Text>
      </Box>
      {target && target.length > 0 ? (
        <Box flexShrink={1} flexWrap="nowrap">
          <Text color={theme.colors.dim}>
            {" "}
            ({target})
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export default AssistantToolUseMessage;
