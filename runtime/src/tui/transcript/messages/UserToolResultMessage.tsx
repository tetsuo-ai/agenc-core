import React from "react";

import { ToolCell } from "../ToolCell.js";

export interface UserToolResultMessageProps {
  readonly content: string;
  readonly toolUseId?: string;
  readonly isError?: boolean;
}

export function UserToolResultMessage({
  content,
  toolUseId,
  isError,
}: UserToolResultMessageProps): React.ReactElement {
  return (
    <ToolCell
      toolName={toolUseId ? `tool result ${toolUseId}` : "tool result"}
      isComplete
      isError={isError === true}
      result={content}
    />
  );
}

export default UserToolResultMessage;
