import { feature } from 'bun:bundle';
import * as React from 'react';
import type { Command } from '../../commands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { ContentWidthProvider, useContentWidth } from '../context/contentWidthContext.js';
import { Box } from '../ink.js';
import type { Tools } from '../../tools/Tool.js';
import { isConnectorTextBlock } from '../../types/connectorText.js';
import type { AssistantMessage, AttachmentMessage as AttachmentMessageType, CollapsedReadSearchGroup as CollapsedReadSearchGroupType, GroupedToolUseMessage as GroupedToolUseMessageType, NormalizedUserMessage, ProgressMessage, SystemMessage } from '../../types/message.js';
import { isAdvisorBlock } from '../../utils/advisor.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { logError } from '../../utils/log.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import { isSnipMarkerMessage } from '../../services/compact/snipCompact.js';
import { isSnipBoundaryMessage } from '../../services/compact/snipProjection.js';
import {
  AdvisorMessage,
  AssistantRedactedThinkingMessage,
  AssistantTextMessage,
  AssistantThinkingMessage,
  AssistantToolUseMessage,
  AttachmentMessage,
  CollapsedReadSearchContent,
  CompactBoundaryMessage,
  CompactSummary,
  ExpandShellOutputProvider,
  GroupedToolUseContent,
  OffscreenFreeze,
  SystemTextMessage,
  UserImageMessage,
  UserTextMessage,
  UserToolResultMessage,
} from './Message.renderers.js';
import { SnipBoundaryMessage } from '../message-renderers/SnipBoundaryMessage.js';
import { TurnFileChangesSummary } from '../message-renderers/TurnFileChangesSummary.js';
import { deriveTurnFileChanges } from '../turn-file-changes.js';

export function getToolResultMessageWidth(columns: number): number {
  return Math.max(1, columns - 5);
}

export type Props = {
  message: NormalizedUserMessage | AssistantMessage | AttachmentMessageType | SystemMessage | GroupedToolUseMessageType | CollapsedReadSearchGroupType;
  lookups: ReturnType<typeof buildMessageLookups>;
  // Follow-up: Find a way to remove this, and leave spacing to the consumer
  /** Absolute width for the container Box. When provided, eliminates a wrapper Box in the caller. */
  containerWidth?: number;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  style?: 'condensed';
  width?: number | string;
  isTranscriptMode: boolean;
  isStatic: boolean;
  onOpenRateLimitOptions?: () => void;
  isActiveCollapsedGroup?: boolean;
  isUserContinuation?: boolean;
  /** ID of the last thinking block (uuid:index) to show, used for hiding past thinking in transcript mode */
  lastThinkingBlockId?: string | null;
  /** UUID of the latest user bash output message (for auto-expanding) */
  latestBashOutputUUID?: string | null;
};

type AssistantContentBlock = AssistantMessage['message']['content'][number];
type UserContentBlock = NormalizedUserMessage['message']['content'][number];

type UserMessageProps = {
  message: NormalizedUserMessage;
  addMargin: boolean;
  tools: Tools;
  progressMessagesForMessage: ProgressMessage[];
  param: UserContentBlock;
  style?: Props['style'];
  verbose: boolean;
  imageIndex?: number | string;
  isUserContinuation: boolean;
  lookups: ReturnType<typeof buildMessageLookups>;
  isTranscriptMode: boolean;
};

type AssistantMessageBlockProps = {
  param: AssistantContentBlock;
  addMargin: boolean;
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  inProgressToolUseIDs: Set<string>;
  progressMessagesForMessage: ProgressMessage[];
  shouldAnimate: boolean;
  shouldShowDot: boolean;
  width?: number | string;
  inProgressToolCallCount: number;
  isTranscriptMode: boolean;
  lookups: ReturnType<typeof buildMessageLookups>;
  onOpenRateLimitOptions?: () => void;
  thinkingBlockId: string;
  lastThinkingBlockId?: string | null;
  advisorModel?: string;
};

function MessageImpl({
  message,
  lookups,
  containerWidth,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  style,
  width,
  isTranscriptMode,
  onOpenRateLimitOptions,
  isActiveCollapsedGroup,
  isUserContinuation = false,
  lastThinkingBlockId,
  latestBashOutputUUID,
}: Props): React.ReactNode {
  const inheritedContentWidth = useContentWidth();
  const messageContentWidth = typeof containerWidth === 'number' ? containerWidth : inheritedContentWidth;
  switch (message.type) {
    case "attachment":
      return (
        <ContentWidthProvider width={messageContentWidth}>
          <AttachmentMessage
            addMargin={addMargin}
            attachment={message.attachment}
            verbose={verbose}
            isTranscriptMode={isTranscriptMode}
          />
        </ContentWidthProvider>
      );
    case "assistant":
      {
        // Per-turn "files changed" rollup: each Write/Edit above renders its own
        // collapsed diff card, but there is no concise summary of WHAT this turn
        // touched. Derive it from this message's OWN file-mutating tool uses
        // (scoped to the turn, no global git scan) and render one compact line
        // after the tool activity. Empty list → renders nothing.
        const turnFileChanges = deriveTurnFileChanges(message.message.content);
        return (
          <ContentWidthProvider width={messageContentWidth}>
            <Box flexDirection="column" width={containerWidth ?? "100%"}>
              {message.message.content.map((param: AssistantContentBlock, index: number) => (
                <AssistantMessageBlock
                  key={index}
                  param={param}
                  addMargin={addMargin}
                  tools={tools}
                  commands={commands}
                  verbose={verbose}
                  inProgressToolUseIDs={inProgressToolUseIDs}
                  progressMessagesForMessage={progressMessagesForMessage}
                  shouldAnimate={shouldAnimate}
                  shouldShowDot={shouldShowDot}
                  width={width}
                  inProgressToolCallCount={inProgressToolUseIDs.size}
                  isTranscriptMode={isTranscriptMode}
                  lookups={lookups}
                  onOpenRateLimitOptions={onOpenRateLimitOptions}
                  thinkingBlockId={`${message.uuid}:${index}`}
                  lastThinkingBlockId={lastThinkingBlockId}
                  advisorModel={message.advisorModel}
                />
              ))}
              <TurnFileChangesSummary changes={turnFileChanges} />
            </Box>
          </ContentWidthProvider>
        );
      }
    case "user":
      {
        if (message.isCompactSummary) {
          return (
            <ContentWidthProvider width={messageContentWidth}>
              <CompactSummary
                message={message}
                screen={isTranscriptMode ? "transcript" : "prompt"}
              />
            </ContentWidthProvider>
          );
        }

        const imageIndices: Array<number | string> = [];
        let imagePosition = 0;
        for (const param of message.message.content) {
          if (param.type === "image") {
            const id = message.imagePasteIds?.[imagePosition];
            imagePosition++;
            imageIndices.push(id ?? imagePosition);
          } else {
            imageIndices.push(imagePosition);
          }
        }

        const isLatestBashOutput = latestBashOutputUUID === message.uuid;
        const content = (
          <ContentWidthProvider width={messageContentWidth}>
            <Box flexDirection="column" width={containerWidth ?? "100%"}>
              {message.message.content.map((param: UserContentBlock, index: number) => (
                <UserMessage
                  key={index}
                  message={message}
                  addMargin={addMargin}
                  tools={tools}
                  progressMessagesForMessage={progressMessagesForMessage}
                  param={param}
                  style={style}
                  verbose={verbose}
                  imageIndex={imageIndices[index]}
                  isUserContinuation={isUserContinuation}
                  lookups={lookups}
                  isTranscriptMode={isTranscriptMode}
                />
              ))}
            </Box>
          </ContentWidthProvider>
        );

        return isLatestBashOutput ? (
          <ExpandShellOutputProvider>{content}</ExpandShellOutputProvider>
        ) : (
          content
        );
      }
    case "system":
      {
        if (message.subtype === "compact_boundary") {
          if (isFullscreenEnvEnabled()) {
            return null;
          }
          return <CompactBoundaryMessage />;
        }
        if (message.subtype === "microcompact_boundary") {
          return null;
        }
        if (feature("HISTORY_SNIP")) {
          if (isSnipBoundaryMessage(message)) {
            return <SnipBoundaryMessage message={message} />;
          }
          if (isSnipMarkerMessage(message)) {
            return null;
          }
        }
        if (message.subtype === "local_command") {
          return (
            <ContentWidthProvider width={messageContentWidth}>
              <UserTextMessage
                addMargin={addMargin}
                param={{ type: "text", text: message.content }}
                verbose={verbose}
                isTranscriptMode={isTranscriptMode}
              />
            </ContentWidthProvider>
          );
        }
        return (
          <ContentWidthProvider width={messageContentWidth}>
            <SystemTextMessage
              message={message}
              addMargin={addMargin}
              verbose={verbose}
              isTranscriptMode={isTranscriptMode}
            />
          </ContentWidthProvider>
        );
      }
    case "grouped_tool_use":
      return (
        <ContentWidthProvider width={messageContentWidth}>
          <GroupedToolUseContent
            message={message}
            tools={tools}
            lookups={lookups}
            inProgressToolUseIDs={inProgressToolUseIDs}
            shouldAnimate={shouldAnimate}
          />
        </ContentWidthProvider>
      );
    case "collapsed_read_search":
      {
        const renderVerbose = verbose || isTranscriptMode;
        return (
          <ContentWidthProvider width={messageContentWidth}>
            <OffscreenFreeze>
              <CollapsedReadSearchContent
                message={message}
                inProgressToolUseIDs={inProgressToolUseIDs}
                shouldAnimate={shouldAnimate}
                verbose={renderVerbose}
                tools={tools}
                lookups={lookups}
                isActiveGroup={isActiveCollapsedGroup}
              />
            </OffscreenFreeze>
          </ContentWidthProvider>
        );
      }
  }
  return null;
}
function UserMessage({
  message,
  addMargin,
  tools,
  progressMessagesForMessage,
  param,
  style,
  verbose,
  imageIndex,
  isUserContinuation,
  lookups,
  isTranscriptMode,
}: UserMessageProps): React.ReactNode {
  const { columns } = useTerminalSize();
  const inheritedContentWidth = useContentWidth();
  const contentColumns = inheritedContentWidth ?? columns;
  switch (param.type) {
    case "text":
      return (
        <UserTextMessage
          addMargin={addMargin}
          param={param}
          verbose={verbose}
          planContent={message.planContent}
          isTranscriptMode={isTranscriptMode}
          timestamp={message.timestamp}
        />
      );
    case "image":
      {
        const shouldAddMargin = addMargin && !isUserContinuation;
        return <UserImageMessage imageId={imageIndex} addMargin={shouldAddMargin} />;
      }
    case "tool_result":
      {
        const toolResultWidth = getToolResultMessageWidth(contentColumns);
        return (
          <UserToolResultMessage
            param={param}
            message={message}
            lookups={lookups}
            progressMessagesForMessage={progressMessagesForMessage}
            style={style}
            tools={tools}
            verbose={verbose}
            width={toolResultWidth}
            isTranscriptMode={isTranscriptMode}
          />
        );
      }
    default:
      return;
  }
}
function AssistantMessageBlock({
  param,
  addMargin,
  tools,
  commands,
  verbose,
  inProgressToolUseIDs,
  progressMessagesForMessage,
  shouldAnimate,
  shouldShowDot,
  width,
  inProgressToolCallCount,
  isTranscriptMode,
  lookups,
  onOpenRateLimitOptions,
  thinkingBlockId,
  lastThinkingBlockId,
  advisorModel,
}: AssistantMessageBlockProps): React.ReactNode {
  if (feature("CONNECTOR_TEXT") && isConnectorTextBlock(param)) {
    return (
      <AssistantTextMessage
        param={{ type: "text", text: param.connector_text }}
        addMargin={addMargin}
        shouldShowDot={shouldShowDot}
        verbose={verbose}
        width={width}
        onOpenRateLimitOptions={onOpenRateLimitOptions}
      />
    );
  }
  switch (param.type) {
    case "tool_use":
      return (
        <AssistantToolUseMessage
          param={param}
          addMargin={addMargin}
          tools={tools}
          commands={commands}
          verbose={verbose}
          inProgressToolUseIDs={inProgressToolUseIDs}
          progressMessagesForMessage={progressMessagesForMessage}
          shouldAnimate={shouldAnimate}
          shouldShowDot={shouldShowDot}
          inProgressToolCallCount={inProgressToolCallCount}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
      );
    case "text":
      return (
        <AssistantTextMessage
          param={param}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
          onOpenRateLimitOptions={onOpenRateLimitOptions}
        />
      );
    case "redacted_thinking":
      {
        if (!isTranscriptMode && !verbose) {
          return null;
        }
        return <AssistantRedactedThinkingMessage addMargin={addMargin} />;
      }
    case "thinking":
      {
        if (!isTranscriptMode && !verbose) {
          return null;
        }
        const isLastThinking = !lastThinkingBlockId || thinkingBlockId === lastThinkingBlockId;
        const hideInTranscript = isTranscriptMode && !isLastThinking;
        return (
          <AssistantThinkingMessage
            addMargin={addMargin}
            param={param}
            isTranscriptMode={isTranscriptMode}
            verbose={verbose}
            hideInTranscript={hideInTranscript}
          />
        );
      }
    case "server_tool_use":
    case "advisor_tool_result":
      {
        if (isAdvisorBlock(param)) {
          const renderVerbose = verbose || isTranscriptMode;
          return (
            <AdvisorMessage
              block={param}
              addMargin={addMargin}
              resolvedToolUseIDs={lookups.resolvedToolUseIDs}
              erroredToolUseIDs={lookups.erroredToolUseIDs}
              shouldAnimate={shouldAnimate}
              verbose={renderVerbose}
              advisorModel={advisorModel}
            />
          );
        }
        logError(new Error(`Unable to render server tool block: ${param.type}`));
        return null;
      }
    default:
      {
        logError(new Error(`Unable to render message type: ${param.type}`));
        return null;
      }
  }
}
export function hasThinkingContent(m: {
  type: string;
  message?: {
    content: Array<{
      type: string;
    }>;
  };
}): boolean {
  if (m.type !== 'assistant' || !m.message) return false;
  return m.message.content.some(b => b.type === 'thinking' || b.type === 'redacted_thinking');
}

/** Exported for testing */
export function areMessagePropsEqual(prev: Props, next: Props): boolean {
  if (prev.message.uuid !== next.message.uuid) return false;
  // Only re-render on lastThinkingBlockId change if this message actually
  // has thinking content — otherwise every message in scrollback re-renders
  // whenever streaming thinking starts/stops (CC-941).
  if (prev.lastThinkingBlockId !== next.lastThinkingBlockId && hasThinkingContent(next.message)) {
    return false;
  }
  // Verbose toggle changes thinking block visibility/expansion
  if (prev.verbose !== next.verbose) return false;
  // Only re-render if this message's "is latest bash output" status changed,
  // not when the global latestBashOutputUUID changes to a different message
  const prevIsLatest = prev.latestBashOutputUUID === prev.message.uuid;
  const nextIsLatest = next.latestBashOutputUUID === next.message.uuid;
  if (prevIsLatest !== nextIsLatest) return false;
  if (prev.isTranscriptMode !== next.isTranscriptMode) return false;
  // containerWidth is an absolute number in the no-metadata path (wrapper
  // Box is skipped). Static messages must re-render on terminal resize.
  if (prev.containerWidth !== next.containerWidth) return false;
  if (prev.isStatic && next.isStatic) return true;
  return false;
}
export const Message = React.memo(MessageImpl, areMessagePropsEqual);
