import { feature } from 'bun:bundle';
import * as React from 'react';
import { BULLET_OPERATOR } from '../../../constants/figures.js';
import { Text } from '../../ink.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../tools/Tool';
import type { ProgressMessage } from '../../../types/message';
import type { AgenCToolResultBlockParam } from '../../../types/message.js';
import { INTERRUPT_MESSAGE_FOR_TOOL_USE, isClassifierDenial, PLAN_REJECTION_PREFIX, REJECT_MESSAGE_WITH_REASON_PREFIX } from '../../../utils/messages.js';
import { isPermissionDeniedToolResult, PERMISSION_DENIED_TOOL_RESULT_MESSAGE } from '../../tool-result-denial.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage';
import { InterruptedByUser } from '../../components/InterruptedByUser';
import { MessageResponse } from '../../components/MessageResponse';
import { RejectedPlanMessage, RejectedToolUseMessage } from '../../components/v2/messagePrimitives.js';
import { getTextToolResultContent } from './utils';
type Props = {
  progressMessagesForMessage: ProgressMessage[];
  tool?: Tool; // undefined when resuming an old conversation that uses an old tool
  tools: Tools;
  param: AgenCToolResultBlockParam;
  verbose: boolean;
  isTranscriptMode?: boolean;
};

export function UserToolErrorMessage({
  progressMessagesForMessage,
  tool,
  tools,
  param,
  verbose,
  isTranscriptMode,
}: Props): React.ReactNode {
  if (isPermissionDeniedToolResult(param.content)) {
    return <MessageResponse height={1}><Text dimColor={true}>{PERMISSION_DENIED_TOOL_RESULT_MESSAGE}</Text></MessageResponse>;
  }

  const textContent = getTextToolResultContent(param.content);
  if (textContent?.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)) {
    return <MessageResponse height={1}><InterruptedByUser /></MessageResponse>;
  }
  if (textContent?.startsWith(PLAN_REJECTION_PREFIX)) {
    const planContent = textContent.substring(PLAN_REJECTION_PREFIX.length);
    return <RejectedPlanMessage plan={planContent} />;
  }
  if (textContent?.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX)) {
    return <RejectedToolUseMessage />;
  }
  if (feature("TRANSCRIPT_CLASSIFIER") && textContent !== undefined && isClassifierDenial(textContent)) {
    return (
      <MessageResponse height={1}>
        <Text dimColor={true}>
          Denied by auto mode classifier {BULLET_OPERATOR} /feedback if incorrect
        </Text>
      </MessageResponse>
    );
  }

  return (
    tool?.renderToolUseErrorMessage?.(param.content, {
      progressMessagesForMessage: filterToolProgressMessages(progressMessagesForMessage),
      tools,
      verbose,
      isTranscriptMode
    }) ?? <FallbackToolUseErrorMessage result={param.content} verbose={verbose} />
  );
}
