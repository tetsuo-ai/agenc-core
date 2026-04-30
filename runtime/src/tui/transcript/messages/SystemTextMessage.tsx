import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";
import type { TranscriptMessage } from "../MessageList.js";

export interface SystemTextMessageProps {
  readonly message: TranscriptMessage;
  readonly addMargin?: boolean;
}

export function SystemTextMessage({
  message,
  addMargin = true,
}: SystemTextMessageProps): React.ReactElement | null {
  if (message.systemSubtype === "microcompact_boundary") return null;
  const label =
    message.systemSubtype === "compact_boundary"
      ? "compact boundary"
      : message.systemSubtype === "local_command"
        ? "local command"
        : "system";
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <Text color={theme.colors.dim}>[{label}] </Text>
      <Text color={theme.colors.dim}>{message.content}</Text>
    </Box>
  );
}

export default SystemTextMessage;
