/**
 * Message — message-row dispatcher for the AgenC transcript.
 *
 * Adapted from upstream's `components/Message.tsx`.
 *
 * Routing model
 * -------------
 * upstream's `Message` switched on the upstream content-block-array
 * envelope and produced one row per content block. AgenC's transcript
 * reducer (`tui/state/events-to-messages.ts`) already collapses the live
 * stream into flat `TranscriptMessage` rows keyed by `kind`. This
 * dispatcher therefore switches on `message.kind` and forwards to the
 * appropriate `messages/*` renderer.
 *
 * MessageList uses this dispatcher through `MessageRow`, keeping live,
 * replayed, and transcript-focused rows on one render path.
 *
 * @module
 */

import React from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";
import { ExecCell, collapseOutput } from "./ExecCell.js";
import { PlanProgress } from "./PlanProgress.js";
import { SlashResultRenderer } from "./SlashResultRenderer.js";
import { ToolCell } from "./ToolCell.js";
import type { TranscriptMessage } from "./MessageList.js";
import { AssistantTextMessage } from "./messages/AssistantTextMessage.js";
import {
  CollapsedReadSearchContent,
  type CollapsedReadSearchEntry,
  type CollapsedReadSearchSummary,
} from "./messages/CollapsedReadSearchContent.js";
import {
  GroupedToolUseContent,
  type GroupedToolUseEntry,
} from "./messages/GroupedToolUseContent.js";
import { UserTextMessage } from "./messages/UserTextMessage.js";
import {
  readSearchListToneForShellCommand,
  readStringField,
  toolRendererTone,
} from "./tool-renderers.js";

export interface MessageProps {
  readonly message: TranscriptMessage;
  readonly verbose?: boolean;
  /** Render the row with a leading top margin. */
  readonly addMargin?: boolean;
  /** True when the row sits inside a transcript-focused screen. */
  readonly isTranscriptMode?: boolean;
}

function truncate(input: string, max: number = 300): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

function groupedToolCounts(
  groupedTools: NonNullable<TranscriptMessage["groupedTools"]>,
): {
  readonly reads: number;
  readonly searches: number;
  readonly lists: number;
} {
  let reads = 0;
  let searches = 0;
  let lists = 0;
  for (const tool of groupedTools) {
    const baseTone = toolRendererTone(tool.toolName);
    const tone =
      tool.collapseTone ??
      (baseTone === "exec"
        ? readSearchListToneForShellCommand(
            tool.execCommand ??
              readStringField(tool.toolArgs, ["command", "cmd", "script"]) ??
              tool.target,
          )
        : baseTone);
    if (tone === "read") reads += 1;
    if (tone === "search") searches += 1;
    if (tone === "list") lists += 1;
  }
  return { reads, searches, lists };
}

function groupedToolHint(
  groupedTools: NonNullable<TranscriptMessage["groupedTools"]>,
): string | null {
  for (let index = groupedTools.length - 1; index >= 0; index -= 1) {
    const target = groupedTools[index]?.target.trim();
    if (target) return truncate(target);
  }
  return null;
}

function collapsedReadSearchSummary(
  groupedTools: NonNullable<TranscriptMessage["groupedTools"]>,
  isActive: boolean,
): CollapsedReadSearchSummary {
  const counts = groupedToolCounts(groupedTools);
  return {
    ...(counts.searches > 0 ? { searchCount: counts.searches } : {}),
    ...(counts.reads > 0 ? { readCount: counts.reads } : {}),
    ...(counts.lists > 0 ? { listCount: counts.lists } : {}),
    ...(isActive ? { latestHint: groupedToolHint(groupedTools) ?? "" } : {}),
    ...(groupedTools.some((tool) => tool.isError === true)
      ? { anyError: true }
      : {}),
  };
}

function collapsedReadSearchEntries(
  groupedTools: NonNullable<TranscriptMessage["groupedTools"]>,
): CollapsedReadSearchEntry[] {
  return groupedTools.map((tool) => ({
    id: tool.id,
    toolName: tool.toolName,
    ...(tool.toolArgs !== undefined ? { toolArgs: tool.toolArgs } : {}),
    ...(tool.toolResultContent !== undefined
      ? { result: tool.toolResultContent }
      : tool.execStdout !== undefined
        ? { result: tool.execStdout }
        : {}),
    ...(tool.toolResultMetadata !== undefined
      ? { metadata: tool.toolResultMetadata }
      : {}),
    ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
    ...(tool.isComplete !== undefined ? { isComplete: tool.isComplete } : {}),
  }));
}

function groupedToolUseEntries(
  groupedTools: NonNullable<TranscriptMessage["groupedTools"]>,
): GroupedToolUseEntry[] {
  return groupedTools.map((tool) => ({
    id: tool.id,
    toolName: tool.toolName,
    ...(tool.toolArgs !== undefined ? { toolArgs: tool.toolArgs } : {}),
    ...(tool.toolResultContent !== undefined
      ? { result: tool.toolResultContent }
      : {}),
    ...(tool.toolResultMetadata !== undefined
      ? { metadata: tool.toolResultMetadata }
      : {}),
    ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
    ...(tool.isComplete !== undefined ? { isComplete: tool.isComplete } : {}),
    ...(tool.execCommand !== undefined ? { execCommand: tool.execCommand } : {}),
    ...(tool.execStdout !== undefined ? { execStdout: tool.execStdout } : {}),
    ...(tool.execStderr !== undefined ? { execStderr: tool.execStderr } : {}),
    ...(tool.execExitCode !== undefined
      ? { execExitCode: tool.execExitCode }
      : {}),
    ...(tool.execDurationMs !== undefined
      ? { execDurationMs: tool.execDurationMs }
      : {}),
    ...(tool.execTimedOut !== undefined
      ? { execTimedOut: tool.execTimedOut }
      : {}),
    ...(tool.execTruncated !== undefined
      ? { execTruncated: tool.execTruncated }
      : {}),
    ...(tool.execCwdWasReset !== undefined
      ? { execCwdWasReset: tool.execCwdWasReset }
      : {}),
    ...(tool.execBackgroundTaskHint !== undefined
      ? { execBackgroundTaskHint: tool.execBackgroundTaskHint }
      : {}),
    ...(tool.execImagePaths !== undefined
      ? { execImagePaths: tool.execImagePaths }
      : {}),
    ...(tool.execNoOutputExpected !== undefined
      ? { execNoOutputExpected: tool.execNoOutputExpected }
      : {}),
    ...(tool.execReturnCodeInterpretation !== undefined
      ? { execReturnCodeInterpretation: tool.execReturnCodeInterpretation }
      : {}),
    ...(tool.execBackgroundTaskId !== undefined
      ? { execBackgroundTaskId: tool.execBackgroundTaskId }
      : {}),
  }));
}

export function Message({
  message,
  verbose = false,
  addMargin = true,
  isTranscriptMode = false,
}: MessageProps): React.ReactElement | null {
  void isTranscriptMode;

  switch (message.kind) {
    case "user":
      return (
        <UserTextMessage
          addMargin={addMargin}
          param={{ text: message.content, type: "text" }}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      );

    case "assistant":
      return (
        <AssistantTextMessage
          text={message.content}
          addMargin={addMargin}
          shouldShowDot
          isComplete={message.isComplete !== false}
        />
      );

    case "plan_progress":
      return <PlanProgress events={message.planEvents ?? []} />;

    case "tool_call": {
      // Shell-exec calls render through the dedicated history-cell variant.
      if (typeof message.execCommand === "string") {
        return (
          <ExecCell
            command={message.execCommand}
            stdout={message.execStdout ?? ""}
            stderr={message.execStderr ?? ""}
            {...(message.execExitCode !== undefined
              ? { exitCode: message.execExitCode }
              : {})}
            {...(message.execDurationMs !== undefined
              ? { durationMs: message.execDurationMs }
              : {})}
            {...(message.execTimedOut !== undefined
              ? { timedOut: message.execTimedOut }
              : {})}
            {...(message.execTruncated !== undefined
              ? { truncated: message.execTruncated }
              : {})}
            {...(message.execCwdWasReset !== undefined
              ? { cwdWasReset: message.execCwdWasReset }
              : {})}
            {...(message.execBackgroundTaskHint !== undefined
              ? { backgroundTaskHint: message.execBackgroundTaskHint }
              : {})}
            {...(message.execImagePaths !== undefined
              ? { imagePaths: message.execImagePaths }
              : {})}
            {...(message.execNoOutputExpected !== undefined
              ? { noOutputExpected: message.execNoOutputExpected }
              : {})}
            {...(message.execReturnCodeInterpretation !== undefined
              ? {
                  returnCodeInterpretation:
                    message.execReturnCodeInterpretation,
                }
              : {})}
            {...(message.execBackgroundTaskId !== undefined
              ? { backgroundTaskId: message.execBackgroundTaskId }
              : {})}
            verbose={verbose}
          />
        );
      }
      return (
        <ToolCell
          toolName={message.toolName}
          toolArgs={message.toolArgs}
          isComplete={message.isComplete !== false}
          isError={message.isError === true}
          result={message.toolResultContent}
          metadata={message.toolResultMetadata}
          progress={message.toolProgressContent ?? message.label}
        />
      );
    }

    case "tool_result":
      return (
        <ToolCell
          toolName={message.toolName}
          toolArgs={message.toolArgs}
          isComplete
          isError={message.isError === true}
          result={message.toolResultContent ?? message.content}
          metadata={message.toolResultMetadata}
        />
      );

    case "tool_group": {
      const groupedTools = message.groupedTools ?? [];
      const execChildren = groupedTools.filter(
        (tool) => typeof tool.execCommand === "string",
      );
      if (message.label !== "read-search" && execChildren.length > 0) {
        return (
          <GroupedToolUseContent
            toolName={message.content || "Bash"}
            entries={groupedToolUseEntries(execChildren)}
            verbose={verbose}
          />
        );
      }
      const isActive = message.isComplete === false;
      return (
        <CollapsedReadSearchContent
          summary={collapsedReadSearchSummary(groupedTools, isActive)}
          entries={collapsedReadSearchEntries(groupedTools)}
          isActiveGroup={isActive}
          addMargin={addMargin}
          verbose={verbose}
        />
      );
    }

    case "activity": {
      const color =
        message.progressStream === "stderr"
          ? theme.colors.warning
          : theme.colors.dim;
      return (
        <Box flexDirection="row">
          <Text color={theme.colors.dim}>{"· "}</Text>
          <Text color={color}>
            {message.label ? `${message.label}: ` : ""}
            {collapseOutput(message.content, 4, 2)}
          </Text>
        </Box>
      );
    }

    case "meta": {
      const color =
        message.label === "deprecated"
          ? theme.colors.warning
          : theme.colors.dim;
      return (
        <Box flexDirection="row">
          <Text color={color}>{"• "}</Text>
          <Text color={color} dim={message.label !== "deprecated"}>
            {message.content}
          </Text>
        </Box>
      );
    }

    case "warning":
      return (
        <Box flexDirection="row">
          <Text color={theme.colors.warning}>
            {"⚠ "}
            {message.content}
          </Text>
        </Box>
      );

    case "error":
      return (
        <Box flexDirection="row">
          <Text color={theme.colors.error}>
            {"✗ "}
            {message.content}
          </Text>
        </Box>
      );

    case "slash_result":
      if (message.slashInput && message.slashResult) {
        return (
          <SlashResultRenderer
            input={message.slashInput}
            result={message.slashResult}
          />
        );
      }
      return <Text color={theme.colors.dim}>{message.content}</Text>;

    default: {
      // Unknown kind — render a dim placeholder so the row is visible and
      // we don't drop user-facing content silently.
      const preview =
        typeof message.content === "string" && message.content.length > 0
          ? message.content.length > 80
            ? `${message.content.slice(0, 79)}…`
            : message.content
          : "(no preview)";
      return (
        <Box flexDirection="row">
          <Text color={theme.colors.dim}>
            [{message.kind}] {preview}
          </Text>
        </Box>
      );
    }
  }
}

export default Message;
