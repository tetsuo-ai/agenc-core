import { userFacingResultContent } from '../../user-facing-tool-text.js';
import * as React from 'react';
import { Text } from '../../ink.js';
import type { Tools } from '../../../tools/Tool.js';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message.js';
import type { AgenCToolResultBlockParam } from '../../../types/message.js';
import { type buildMessageLookups, CANCEL_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, REJECT_MESSAGE } from '../../../utils/messages.js';
import { isPermissionDeniedToolResult, PERMISSION_DENIED_DISPLAY_TEXT } from '../../tool-result-denial.js';
import { UserToolCanceledMessage } from '../../components/v2/messagePrimitives.js';
import { UserToolErrorMessage } from './UserToolErrorMessage.js';
import { UserToolRejectMessage } from './UserToolRejectMessage.js';
import { UserToolSuccessMessage } from './UserToolSuccessMessage.js';
import { getTextToolResultContent, useGetToolFromMessages } from './utils.js';
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
  if (isPermissionDeniedToolResult(content)) return PERMISSION_DENIED_DISPLAY_TEXT;
  // No call row names the tool, so the runtime's own texts are recognized
  // by their wording; non-text blocks are named, never dumped as JSON.
  return userFacingResultContent(content) ?? "";
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
    return <Text dimColor={true}>Recovered a tool result: {formatOrphanToolResultContent(param.content)}</Text>;
  }

  const textContent = getTextToolResultContent(param.content);
  // Compact mode already names this cancellation on the failed call row.
  if (param.is_error && !verbose) return null;
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
