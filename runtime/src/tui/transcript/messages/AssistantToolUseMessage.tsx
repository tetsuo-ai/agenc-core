import React from "react";

import { ToolCell } from "../ToolCell.js";

export interface AssistantToolUseMessageProps {
  readonly id?: string;
  readonly name: string;
  readonly input?: unknown;
  readonly isComplete?: boolean;
}

export function AssistantToolUseMessage({
  name,
  input,
  isComplete,
}: AssistantToolUseMessageProps): React.ReactElement {
  return (
    <ToolCell
      toolName={name}
      toolArgs={input}
      isComplete={isComplete !== false}
    />
  );
}

export default AssistantToolUseMessage;
