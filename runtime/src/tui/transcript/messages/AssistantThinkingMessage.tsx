/**
 * AssistantThinkingMessage — renders the model's extended-thinking body.
 *
 * Adapted from upstream's `components/messages/AssistantThinkingMessage.tsx`.
 *
 * AgenC's reducer does not currently emit a dedicated thinking-row kind, so
 * this component is exported for the new dispatcher to call when a future
 * tranche introduces a `thinking` row. The signature accepts a flat
 * `thinking` string instead of an Anthropic `ThinkingBlockParam`.
 *
 * In condensed (non-transcript, non-verbose) mode the body collapses to a
 * one-line dim hint. In transcript or verbose mode the full thinking text
 * is rendered through AgenC's `MarkdownBlock` to keep code fences/lists
 * aligned with the rest of the transcript.
 *
 * @module
 */

import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";
import { MarkdownBlock } from "../MarkdownBlock.js";

export interface AssistantThinkingMessageProps {
  readonly thinking: string;
  readonly addMargin?: boolean;
  readonly isTranscriptMode?: boolean;
  readonly verbose?: boolean;
  /** Suppress the row entirely (used for past thinking in transcript). */
  readonly hideInTranscript?: boolean;
}

export function AssistantThinkingMessage({
  thinking,
  addMargin = false,
  isTranscriptMode = false,
  verbose = false,
  hideInTranscript = false,
}: AssistantThinkingMessageProps): React.ReactElement | null {
  if (typeof thinking !== "string" || thinking.length === 0) {
    return null;
  }
  if (hideInTranscript) {
    return null;
  }

  const showFull = isTranscriptMode || verbose;
  const marginTop = addMargin ? 1 : 0;

  if (!showFull) {
    return (
      <Box marginTop={marginTop}>
        <Text color={theme.colors.dim} italic>
          {"∴ Thinking"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1} marginTop={marginTop} width="100%">
      <Text color={theme.colors.dim} italic>
        {"∴ Thinking…"}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        <MarkdownBlock content={thinking} isComplete />
      </Box>
    </Box>
  );
}

export default AssistantThinkingMessage;
