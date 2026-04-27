import React, { useEffect, useState } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";

export interface QueuedCommandsSession {
  hasPendingInput?(): boolean;
}

export interface QueuedCommandsProps {
  readonly session: QueuedCommandsSession;
  readonly isStreaming?: boolean;
}

export const QueuedCommands: React.FC<QueuedCommandsProps> = ({
  session,
  isStreaming = false,
}) => {
  const [hasQueuedInput, setHasQueuedInput] = useState(false);

  useEffect(() => {
    const check = (): void => {
      try {
        setHasQueuedInput(session.hasPendingInput?.() === true);
      } catch {
        setHasQueuedInput(false);
      }
    };
    check();
    if (!isStreaming) return undefined;
    const timer = setInterval(check, 750);
    return () => {
      clearInterval(timer);
    };
  }, [isStreaming, session]);

  if (!hasQueuedInput) return null;
  return (
    <Box
      flexDirection="row"
      width="100%"
      backgroundColor={theme.colors.surface as Color}
    >
      <Text>{"  "}</Text>
      <Text color={theme.colors.secondary as Color}>{"• "}</Text>
      <Text color={theme.colors.secondary as Color}>
        Message queued for the next turn
      </Text>
    </Box>
  );
};

export default QueuedCommands;
