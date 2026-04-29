import React from "react";

import { AssistantThinkingMessage } from "./AssistantThinkingMessage.js";

export interface AssistantRedactedThinkingMessageProps {
  readonly text?: string;
  readonly addMargin?: boolean;
}

export function AssistantRedactedThinkingMessage({
  text,
  addMargin,
}: AssistantRedactedThinkingMessageProps): React.ReactElement {
  return (
    <AssistantThinkingMessage
      text={text ?? ""}
      addMargin={addMargin}
      isHidden={!text}
    />
  );
}

export default AssistantRedactedThinkingMessage;
