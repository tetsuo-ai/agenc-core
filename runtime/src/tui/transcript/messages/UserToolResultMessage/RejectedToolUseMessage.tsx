/**
 * RejectedToolUseMessage — fallback row when the user rejected a tool
 * call without supplying a per-tool reject renderer.
 *
 * Ported from upstream
 * `components/messages/UserToolResultMessage/RejectedToolUseMessage.tsx`.
 *
 * @module
 */

import React from "react";

import { Box, Text } from "../../../ink-public.js";

export interface RejectedToolUseMessageProps {
  /** Optional reject reason supplied by the user. */
  readonly reason?: string;
}

export function RejectedToolUseMessage({
  reason,
}: RejectedToolUseMessageProps = {}): React.ReactElement {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return (
    <Box flexDirection="row">
      <Text color="dim">
        {"  ⎿  Tool use rejected"}
        {trimmed.length > 0 ? `: ${trimmed}` : ""}
      </Text>
    </Box>
  );
}

export default RejectedToolUseMessage;
