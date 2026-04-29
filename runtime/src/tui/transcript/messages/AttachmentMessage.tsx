import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";
import type { TranscriptAttachmentBlock } from "../content-blocks.js";
import { UserTextMessage } from "./UserTextMessage.js";

export interface AttachmentMessageProps {
  readonly attachment: TranscriptAttachmentBlock;
  readonly addMargin?: boolean;
  readonly verbose?: boolean;
  readonly isTranscriptMode?: boolean;
}

export function AttachmentMessage({
  attachment,
  addMargin = true,
  verbose = false,
  isTranscriptMode = false,
}: AttachmentMessageProps): React.ReactElement | null {
  if (attachment.isMeta && !verbose) return null;
  if (attachment.type === "queued_command" && attachment.prompt) {
    const prompt =
      typeof attachment.prompt === "string"
        ? attachment.prompt
        : attachment.prompt
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n");
    return (
      <UserTextMessage
        addMargin={addMargin}
        param={{ type: "text", text: prompt }}
        verbose={verbose}
        isTranscriptMode={isTranscriptMode}
      />
    );
  }
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text color={theme.colors.dim}>
        {attachment.label ?? attachment.type}
        {attachment.path ? ` ${attachment.path}` : ""}
      </Text>
      {attachment.content ? <Text>{attachment.content}</Text> : null}
    </Box>
  );
}

export default AttachmentMessage;
