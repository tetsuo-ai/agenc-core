import { feature } from 'bun:bundle';
import * as React from 'react';
import { TuiErrorBoundary } from '../../components/TuiErrorBoundary.js';
import { Box, Text, useTheme } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { filterToolProgressMessages, type Tool, type Tools } from '../../../tools/Tool';
import type { NormalizedUserMessage, ProgressMessage } from '../../../types/message';
import { deleteClassifierApproval, getClassifierApproval, getYoloClassifierApproval } from '../../../utils/classifierApprovals.js';
import { extractTag, type buildMessageLookups } from '../../../utils/messages.js';
import { MessageResponse } from '../../components/MessageResponse';
import { HookProgressMessage } from '../HookProgressMessage';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
type Props = {
  message: NormalizedUserMessage;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  progressMessagesForMessage: ProgressMessage[];
  style?: 'condensed';
  tool?: Tool;
  tools: Tools;
  verbose: boolean;
  width: number | string;
  isTranscriptMode?: boolean;
};

export function isToolUseResultMissing(toolUseResult: unknown): boolean {
  return toolUseResult === undefined || toolUseResult === null;
}

function formatRecoveredToolResultContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return extractTag(content, 'persisted-output') ?? content;
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
        return block.text;
      }
      return JSON.stringify(block);
    }).join('\n');
  }
  if (content === undefined || content === null) {
    return null;
  }
  return String(content);
}

export function getToolResultFallbackContent(messageContent: unknown, toolUseID?: string): string | null {
  if (!Array.isArray(messageContent)) return null;
  const toolResultBlock = messageContent.find(block => {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'tool_result') {
      return false;
    }
    return toolUseID === undefined || ('tool_use_id' in block && block.tool_use_id === toolUseID);
  });
  if (!toolResultBlock || !('content' in toolResultBlock)) {
    return null;
  }
  return formatRecoveredToolResultContent(toolResultBlock.content);
}

export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode
}: Props): React.ReactNode {
  const [theme] = useTheme();
  const glyphs = selectAgenCTuiGlyphs();
  // Hook stays inside feature() ternary so external builds don't pay a
  // per-scrollback-message store subscription — same pattern as
  // UserPromptMessage.tsx.
  const isBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ?
  // biome-ignore lint/correctness/useHookAtTopLevel: feature() is a compile-time constant
  useAppState(s => s.isBriefOnly) : false;

  // Capture classifier approval once on mount, then delete from Map to prevent linear growth.
  // useState lazy initializer ensures the value persists across re-renders.
  const [classifierRule] = React.useState(() => getClassifierApproval(toolUseID));
  const [yoloReason] = React.useState(() => getYoloClassifierApproval(toolUseID));
  React.useEffect(() => {
    deleteClassifierApproval(toolUseID);
  }, [toolUseID]);

  const fallbackContent = React.useMemo(() => getToolResultFallbackContent(message.message.content, toolUseID), [message.message.content, toolUseID]);
  if (isToolUseResultMissing(message.toolUseResult) || !tool) {
    return fallbackContent !== null ? <Box flexDirection="column">
          <Box flexDirection="column" width={width}>
            <Text>{fallbackContent}</Text>
            {feature('BASH_CLASSIFIER') ? classifierRule && <MessageResponse height={1}>
                    <Text dimColor>
                      <Text color="success">{glyphs.statusSuccess}</Text>
                      {` Auto-approved ${glyphs.separator} matched `}
                      {`"${classifierRule}"`}
                    </Text>
                  </MessageResponse> : null}
            {feature('TRANSCRIPT_CLASSIFIER') ? yoloReason && <MessageResponse height={1}>
                    <Text dimColor>Allowed by auto mode classifier</Text>
                  </MessageResponse> : null}
          </Box>
          <TuiErrorBoundary>
            <HookProgressMessage hookEvent="PostToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
          </TuiErrorBoundary>
        </Box> : null;
  }

  // Resumed transcripts deserialize toolUseResult via raw JSON.parse with no
  // validation (parseJSONL). A partial/corrupt/old-format result crashes
  // renderToolResultMessage on first field access (anthropics/agenc-code#39817).
  // Validate against outputSchema before rendering — mirrors CollapsedReadSearchContent.
  const parsedOutput = tool.outputSchema?.safeParse(message.toolUseResult);
  if (parsedOutput && !parsedOutput.success) {
    return fallbackContent !== null ? <Box flexDirection="column">
          <Box flexDirection="column" width={width}>
            <Text>{fallbackContent}</Text>
            {feature('BASH_CLASSIFIER') ? classifierRule && <MessageResponse height={1}>
                    <Text dimColor>
                      <Text color="success">{glyphs.statusSuccess}</Text>
                      {` Auto-approved ${glyphs.separator} matched `}
                      {`"${classifierRule}"`}
                    </Text>
                  </MessageResponse> : null}
            {feature('TRANSCRIPT_CLASSIFIER') ? yoloReason && <MessageResponse height={1}>
                    <Text dimColor>Allowed by auto mode classifier</Text>
                  </MessageResponse> : null}
          </Box>
          <TuiErrorBoundary>
            <HookProgressMessage hookEvent="PostToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
          </TuiErrorBoundary>
        </Box> : null;
  }
  const toolResult = parsedOutput?.data ?? message.toolUseResult;
  // The capped per-tool RESULT preview ("Read N lines", capped stdout, "Found N
  // matches", compact edit diff) is produced HERE — once — by the thin-client
  // tool's renderToolResultMessage (see tool-rendering.tsx). This detached body
  // sits directly under the "● Tool(...)" call row, so it reads as the call's
  // result without any inline-on-call-row duplication. The call row itself
  // renders no success preview (only failed-row reasons live there).
  const renderedMessage = tool.renderToolResultMessage?.(toolResult as never, filterToolProgressMessages(progressMessagesForMessage), {
    style,
    theme,
    tools,
    verbose,
    isTranscriptMode,
    isBriefOnly,
    input: lookups.toolUseByToolUseID.get(toolUseID)?.input
  }) ?? null;

  // Don't render anything if the tool result message is null.
  if (renderedMessage === null) {
    return null;
  }

  // Tools that return '' from userFacingName opt out of tool chrome and
  // render like plain assistant text. Skip the tool-result width constraint
  // so MarkdownTable's SAFETY_MARGIN=4 (tuned for the assistant-text 2-col
  // dot gutter) holds — otherwise tables wrap their box-drawing chars.
  const rendersAsAssistantText = tool.userFacingName(undefined) === '';
  return <Box flexDirection="column">
      <Box flexDirection="column" width={rendersAsAssistantText ? undefined : width}>
        {renderedMessage}
        {feature('BASH_CLASSIFIER') ? classifierRule && <MessageResponse height={1}>
                <Text dimColor>
                  <Text color="success">{glyphs.statusSuccess}</Text>
                  {` Auto-approved ${glyphs.separator} matched `}
                  {`"${classifierRule}"`}
                </Text>
              </MessageResponse> : null}
        {feature('TRANSCRIPT_CLASSIFIER') ? yoloReason && <MessageResponse height={1}>
                <Text dimColor>Allowed by auto mode classifier</Text>
              </MessageResponse> : null}
      </Box>
      <TuiErrorBoundary>
        <HookProgressMessage hookEvent="PostToolUse" lookups={lookups} toolUseID={toolUseID} verbose={verbose} isTranscriptMode={isTranscriptMode} />
      </TuiErrorBoundary>
    </Box>;
}
