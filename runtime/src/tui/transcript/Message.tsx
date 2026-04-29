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
 * Some kinds are not yet covered by the assistant-row tranche (4A) ports
 * — they fall through to a dim placeholder body with a `// TODO(tranche-4X)`
 * comment so the lead can wire the proper renderer in later tranches.
 *
 * NOTE: AgenC's existing `MessageList.tsx` keeps its in-file `MessageRow`
 * dispatcher unchanged. This new dispatcher is exported for the tranche-4
 * `VirtualMessageList` port; the lead will rewire `MessageList` to use it
 * in a follow-up integration step.
 *
 * @module
 */

import React from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";
import { ExecCell, collapseOutput } from "./ExecCell.js";
import { PlanProgress } from "./PlanProgress.js";
import { SlashResultRenderer } from "./SlashResultRenderer.js";
import { ToolCell } from "./ToolCell.js";
import type { TranscriptMessage } from "./MessageList.js";
import { AssistantTextMessage } from "./messages/AssistantTextMessage.js";
import { AssistantToolUseMessage } from "./messages/AssistantToolUseMessage.js";

export interface MessageProps {
  readonly message: TranscriptMessage;
  readonly verbose?: boolean;
  /** Render the row with a leading top margin. */
  readonly addMargin?: boolean;
  /** True when the row sits inside a transcript-focused screen. */
  readonly isTranscriptMode?: boolean;
}

const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

export function Message({
  message,
  verbose = false,
  addMargin = true,
  isTranscriptMode = false,
}: MessageProps): React.ReactElement | null {
  void isTranscriptMode; // currently unused; reserved for future tranches

  switch (message.kind) {
    case "user":
      return (
        <Box
          flexDirection="column"
          marginTop={addMargin ? 1 : 0}
          paddingX={1}
          paddingY={0}
          backgroundColor={theme.colors.surface as Color}
        >
          <Text>{message.content}</Text>
        </Box>
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
            verbose={verbose}
          />
        );
      }
      // Render the assistant-side announcement and the result cell as a
      // single column: the dot+title row sits above the detailed cell.
      return (
        <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
          <AssistantToolUseMessage
            toolName={message.toolName ?? "tool"}
            input={message.toolArgs}
            shouldShowDot
            inProgress={message.isComplete === false}
            isError={message.isError === true}
          />
          <ToolCell
            toolName={message.toolName}
            toolArgs={message.toolArgs}
            isComplete={message.isComplete !== false}
            isError={message.isError === true}
            result={message.toolResultContent}
            metadata={message.toolResultMetadata}
            progress={message.toolProgressContent ?? message.label}
          />
        </Box>
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
      // TODO(tranche-4B): wire GroupedToolUseContent renderer once ported.
      const summary =
        message.groupedTools && message.groupedTools.length > 0
          ? `${message.groupedTools.length} tool${message.groupedTools.length === 1 ? "" : "s"}`
          : message.content;
      return (
        <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
          <Text color={theme.colors.dim}>
            {BLACK_CIRCLE} {message.isComplete === false ? "Using" : "Used"}{" "}
            {summary}
          </Text>
        </Box>
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
      // we don't drop user-facing content silently. Future tranches will
      // replace this fallback with a dedicated renderer.
      const preview =
        typeof message.content === "string" && message.content.length > 0
          ? message.content.length > 80
            ? `${message.content.slice(0, 79)}…`
            : message.content
          : "(no preview)";
      // TODO(tranche-4B/4C/4D): wire renderer for kind="${message.kind}".
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
