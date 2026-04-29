import React from "react";

import Box from "../../ink/components/Box.js";
import Text from "../../ink/components/Text.js";
import { theme } from "../../theme.js";
import MarkdownBlock from "../MarkdownBlock.js";

export interface AssistantThinkingMessageProps {
  readonly text: string;
  readonly addMargin?: boolean;
  readonly isHidden?: boolean;
}

export function AssistantThinkingMessage({
  text,
  addMargin = true,
  isHidden = false,
}: AssistantThinkingMessageProps): React.ReactElement | null {
  if (!text.trim() && !isHidden) return null;
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Text color={theme.colors.dim}>
        {isHidden ? "✦ thinking hidden" : "✦ thinking"}
      </Text>
      {isHidden ? null : <MarkdownBlock content={text} isComplete />}
    </Box>
  );
}

export default AssistantThinkingMessage;
