import * as React from 'react';
import { Text } from '../../ink.js';
import type { Tools } from '../../../tools/Tool';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message';
import type { AgenCToolResultBlockParam } from '../../../types/message.js';
import { type buildMessageLookups, CANCEL_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE } from '../../../utils/messages.js';
import { isPermissionDeniedToolResult, PERMISSION_DENIED_TOOL_RESULT_MESSAGE } from '../../tool-result-denial.js';
import { UserToolCanceledMessage } from '../../components/v2/messagePrimitives.js';
import { UserToolErrorMessage } from './UserToolErrorMessage';
import { UserToolRejectMessage } from './UserToolRejectMessage';
import { UserToolSuccessMessage } from './UserToolSuccessMessage';
import { getTextToolResultContent, useGetToolFromMessages } from './utils';
type Props = {
  param: AgenCToolResultBlockParam;
  message: NormalizedUserMessage;
  lookups: ReturnType<typeof buildMessageLookups>;
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tools: Tools;
  verbose: boolean;
  width: number | string;
  isTranscriptMode?: boolean;
};

export function formatOrphanToolResultContent(content: AgenCToolResultBlockParam["content"]): string {
  if (isPermissionDeniedToolResult(content)) return PERMISSION_DENIED_TOOL_RESULT_MESSAGE;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return content == null ? "" : String(content);
}

export function UserToolResultMessage({
  param,
  message,
  lookups,
  progressMessagesForMessage,
  style,
  tools,
  verbose,
  width,
  isTranscriptMode,
}: Props): React.ReactNode {
  const toolUse = useGetToolFromMessages(param.tool_use_id, tools, lookups);
  if (!toolUse) {
    if (param.is_error) {
      return <UserToolErrorMessage progressMessagesForMessage={progressMessagesForMessage} tool={undefined} tools={tools} param={param} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
    }
    return <Text dimColor={true}>Tool result recovered without matching tool call: {formatOrphanToolResultContent(param.content)}</Text>;
  }

  const textContent = getTextToolResultContent(param.content);
  if (textContent?.startsWith(CANCEL_MESSAGE)) {
    return <UserToolCanceledMessage />;
  }

  if (
    textContent?.startsWith(REJECT_MESSAGE) ||
    textContent === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    const input = toolUse.toolUse.input as {
      [key: string]: unknown;
    };
    return <UserToolRejectMessage input={input} progressMessagesForMessage={progressMessagesForMessage} tool={toolUse.tool} tools={tools} lookups={lookups} style={style} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
  }

  if (param.is_error) {
    return <UserToolErrorMessage progressMessagesForMessage={progressMessagesForMessage} tool={toolUse.tool} tools={tools} param={param} verbose={verbose} isTranscriptMode={isTranscriptMode} />;
  }

  return <UserToolSuccessMessage message={message} lookups={lookups} toolUseID={toolUse.toolUse.id} progressMessagesForMessage={progressMessagesForMessage} style={style} tool={toolUse.tool} tools={tools} verbose={verbose} width={width} isTranscriptMode={isTranscriptMode} />;
}
