/**
 * Queued-command notice shown below the composer while a turn is
 * streaming and the user has submitted one or more queued prompts that
 * will run after the active turn drains.
 *
 * Ported from upstream's `PromptInputQueuedCommands`. The upstream
 * widget renders the full queued message previews via its own
 * `Message` and `QueuedMessageProvider` machinery — AgenC has no
 * equivalent, so the AgenC version surfaces a one-line summary
 * sourced from the composer session.
 *
 * I-69 invariant: this component reads the session's `hasPendingInput`
 * / `pendingInputCount` accessors only; it does not consume the paste
 * store or interpose on submit. The composer remains the sole owner
 * of the paste-Enter buffering pipeline.
 */
import React, { useEffect, useState } from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";

export interface QueuedCommandsSession {
  hasPendingInput?(): boolean;
  /**
   * Optional accessor returning the current pending-input count.
   * When provided the count is rendered alongside the notice; when
   * absent the notice falls back to "Message queued for the next
   * turn".
   */
  pendingInputCount?(): number;
}

export interface QueuedCommandsProps {
  readonly session: QueuedCommandsSession;
  readonly isStreaming?: boolean;
}

interface QueuedState {
  readonly hasPending: boolean;
  readonly count: number;
}

const EMPTY_STATE: QueuedState = { hasPending: false, count: 0 };

export const QueuedCommands: React.FC<QueuedCommandsProps> = ({
  session,
  isStreaming = false,
}) => {
  const [queueState, setQueueState] = useState<QueuedState>(EMPTY_STATE);

  useEffect(() => {
    const check = (): void => {
      try {
        const hasPending = session.hasPendingInput?.() === true;
        const count =
          typeof session.pendingInputCount === "function"
            ? Math.max(0, Math.floor(session.pendingInputCount() ?? 0))
            : 0;
        setQueueState({ hasPending, count });
      } catch {
        setQueueState(EMPTY_STATE);
      }
    };
    check();
    if (!isStreaming) return undefined;
    const timer = setInterval(check, 750);
    return () => {
      clearInterval(timer);
    };
  }, [isStreaming, session]);

  if (!queueState.hasPending) return null;

  const text =
    queueState.count > 1
      ? `${queueState.count} messages queued for the next turn`
      : "Message queued for the next turn";

  return (
    <Box
      flexDirection="row"
      width="100%"
      backgroundColor={theme.colors.surface as Color}
    >
      <Text>{"  "}</Text>
      <Text color={theme.colors.secondary as Color}>{"• "}</Text>
      <Text color={theme.colors.secondary as Color}>{text}</Text>
    </Box>
  );
};

export default QueuedCommands;
