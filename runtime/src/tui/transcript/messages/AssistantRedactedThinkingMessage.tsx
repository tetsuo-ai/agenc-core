/**
 * AssistantRedactedThinkingMessage — minimal "thinking redacted" indicator.
 *
 * Adapted from upstream's `components/messages/AssistantRedactedThinkingMessage.tsx`.
 *
 * Renders a single dim row noting that the model returned a redacted
 * thinking block. Optional `reason` text is shown after the marker when
 * provided by the upstream event payload.
 *
 * @module
 */

import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";

export interface AssistantRedactedThinkingMessageProps {
  readonly addMargin?: boolean;
  /** Optional human-readable reason text. */
  readonly reason?: string;
}

export function AssistantRedactedThinkingMessage({
  addMargin = false,
  reason,
}: AssistantRedactedThinkingMessageProps): React.ReactElement {
  const marginTop = addMargin ? 1 : 0;
  return (
    <Box marginTop={marginTop} flexDirection="row">
      <Text color={theme.colors.dim} italic>
        {"✻ Thinking redacted"}
        {reason && reason.length > 0 ? ` · ${reason}` : ""}
      </Text>
    </Box>
  );
}

export default AssistantRedactedThinkingMessage;
