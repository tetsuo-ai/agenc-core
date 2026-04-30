/**
 * AssistantTextMessage — renders an assistant text body row.
 *
 * Adapted from upstream's `components/messages/AssistantTextMessage.tsx`.
 *
 * Differences from upstream:
 *   - The signature accepts a flat `text` string and an `isComplete` flag
 *     instead of an Anthropic `TextBlockParam`. AgenC's transcript reducer
 *     emits `TranscriptMessage` rows where `content` is the merged text,
 *     not a content-block array.
 *   - Markdown rendering is delegated to AgenC's `MarkdownBlock` so we
 *     stream-friendly the same way the existing transcript does.
 *   - The big upstream error-text dispatch (rate limit, prompt-too-long,
 *     org-disabled, etc.) is dropped — those provider-specific surfaces
 *     are not part of AgenC's normalized event stream. Errors land in
 *     `error` rows handled by the dispatcher.
 *
 * @module
 */

import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";
import { Markdown } from "../../components/Markdown.js";
import { StreamingMessage } from "../StreamingMessage.js";

const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●";

export interface AssistantTextMessageProps {
  /** Already-merged assistant text. Empty string is allowed (renders null). */
  readonly text: string;
  /** Insert a top margin between this row and the previous one. */
  readonly addMargin?: boolean;
  /** Show the leading dot glyph next to the body. */
  readonly shouldShowDot?: boolean;
  /** Container width override for the outer Box. */
  readonly width?: number | string;
  /**
   * When false, the body is in-flight and should pass through `StreamingMessage`
   * (which renders progressive markdown). When true, the body is final and
   * goes through `MarkdownBlock` directly.
   */
  readonly isComplete?: boolean;
}

export function AssistantTextMessage({
  text,
  addMargin = false,
  shouldShowDot = true,
  width,
  isComplete = true,
}: AssistantTextMessageProps): React.ReactElement | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  const dot = shouldShowDot ? (
    <Box minWidth={2} flexShrink={0}>
      <Text color={theme.colors.ink}>{BLACK_CIRCLE}</Text>
    </Box>
  ) : null;

  const body = isComplete ? (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Markdown>{text}</Markdown>
    </Box>
  ) : (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <StreamingMessage content={text} isComplete={false} />
    </Box>
  );

  return (
    <Box
      alignItems="flex-start"
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width={width ?? "100%"}
    >
      <Box flexDirection="row" flexGrow={1} flexShrink={1}>
        {dot}
        {body}
      </Box>
    </Box>
  );
}

export default AssistantTextMessage;
