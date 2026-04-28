/**
 * MessageRow — per-row wrapper around a `<Message>`.
 *
 * Adapted from upstream's `components/MessageRow.tsx`.
 *
 * Differences from upstream:
 *   - upstream's MessageRow held the upstream-specific state lookup
 *     pipeline (sibling tool-use IDs, streaming-tool-use sets, lookups,
 *     classifier flags, `shouldRenderStatically`). AgenC's transcript
 *     reducer has already collapsed these into the flat `TranscriptMessage`
 *     shape, so this wrapper is a thin layout box: timestamp band on top
 *     (transcript mode only), then the row body produced by `<Message>`,
 *     then optional bottom spacing.
 *   - The `OffscreenFreeze` cache key is derived from the message id,
 *     timestamp, and completion state — same idea as the existing
 *     `MessageList.tsx` row cache, just hoisted into the new dispatcher.
 *   - Timestamp/model metadata uses AgenC's `theme.colors.dim` directly
 *     instead of upstream's per-color theme key map.
 *
 * @module
 */

import React from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { theme } from "../theme.js";
import type { TranscriptMessage } from "./MessageList.js";
import { Message } from "./Message.js";
import { OffscreenFreeze } from "./OffscreenFreeze.js";

export interface MessageRowProps {
  readonly message: TranscriptMessage;
  /** Render in transcript-focused (verbose-by-default) mode. */
  readonly isTranscriptMode?: boolean;
  /** Show every raw row without grouping/collapse. */
  readonly verbose?: boolean;
  /** Insert a top margin between rows. */
  readonly addMargin?: boolean;
  /** Width of the wrapping column. Falls through to children. */
  readonly width?: number | string;
}

function formatTimestamp(timestamp: number | undefined): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  // The reducer stores either a wall-clock ms timestamp or a sequence
  // index. Prefer ISO time when the value looks like a real timestamp,
  // otherwise leave it dropped (callers that pass seq numbers don't want
  // a fake "1970-01-01" stamp).
  if (timestamp <= 0 || timestamp < 1_000_000_000_000) return null;
  try {
    const d = new Date(timestamp);
    const hh = `${d.getHours()}`.padStart(2, "0");
    const mm = `${d.getMinutes()}`.padStart(2, "0");
    const ss = `${d.getSeconds()}`.padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return null;
  }
}

function rowCacheKey(message: TranscriptMessage): string {
  const tail = [
    message.id,
    message.kind,
    message.timestamp,
    message.isComplete === false ? "streaming" : "final",
    message.content?.length ?? 0,
    message.toolResultContent?.length ?? 0,
    message.execStdout?.length ?? 0,
    message.execStderr?.length ?? 0,
    message.execExitCode ?? "",
    message.label ?? "",
  ];
  return tail.join(":");
}

export function MessageRow({
  message,
  isTranscriptMode = false,
  verbose = false,
  addMargin = true,
  width,
}: MessageRowProps): React.ReactElement | null {
  const showMetadata = isTranscriptMode && message.kind === "assistant";
  const stamp = showMetadata ? formatTimestamp(message.timestamp) : null;

  const body = (
    <Message
      message={message}
      verbose={verbose}
      addMargin={addMargin}
      isTranscriptMode={isTranscriptMode}
    />
  );

  if (!showMetadata || stamp === null) {
    return (
      <OffscreenFreeze
        cacheKey={rowCacheKey(message)}
        freeze={message.isComplete !== false}
      >
        <Box flexDirection="column" width={width}>
          {body}
        </Box>
      </OffscreenFreeze>
    );
  }

  return (
    <OffscreenFreeze
      cacheKey={rowCacheKey(message)}
      freeze={message.isComplete !== false}
    >
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" justifyContent="flex-end" marginTop={1}>
          <Text color={theme.colors.dim}>{stamp}</Text>
        </Box>
        {body}
      </Box>
    </OffscreenFreeze>
  );
}

export default MessageRow;
