import figures from 'figures';
import * as React from 'react';
import { useContext } from 'react';

import { useQueuedMessage } from '../context/QueuedMessageContext';
import { Box, Text } from '../ink.js';
import { formatBriefTimestamp } from '../../utils/formatBriefTimestamp.js';
import {
  findThinkingTriggerPositions,
  getRainbowColor,
  isUltrathinkEnabled,
} from '../../utils/thinking.js';
import { MessageActionsSelectedContext } from '../components/messageActions';

type Props = {
  text: string;
  useBriefLayout?: boolean;
  timestamp?: string;
  showPointer?: boolean;
};

function ThinkingTextParts({ text }: { readonly text: string }): React.ReactNode {
  const triggers = isUltrathinkEnabled() ? findThinkingTriggerPositions(text) : [];
  if (triggers.length === 0) return <Text color="text">{text}</Text>;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const trigger of triggers) {
    if (trigger.start > cursor) {
      parts.push(
        <Text key={`plain-${cursor}`} color="text">
          {text.slice(cursor, trigger.start)}
        </Text>,
      );
    }
    for (let i = trigger.start; i < trigger.end; i++) {
      parts.push(
        <Text key={`rb-${i}`} color={getRainbowColor(i - trigger.start)}>
          {text[i]}
        </Text>,
      );
    }
    cursor = trigger.end;
  }
  if (cursor < text.length) {
    parts.push(
      <Text key={`plain-${cursor}`} color="text">
        {text.slice(cursor)}
      </Text>,
    );
  }
  return <Text>{parts}</Text>;
}

export function HighlightedThinkingText({
  text,
  useBriefLayout,
  timestamp,
  showPointer = true,
}: Props): React.ReactNode {
  const isQueued = useQueuedMessage()?.isQueued ?? false;
  const isSelected = useContext(MessageActionsSelectedContext);
  const pointerColor = isSelected ? 'suggestion' : 'subtle';

  // Queued previews render inside QueuedMessageProvider's paddingX box; with the
  // default no-trim wrap, the word-boundary space lands at the START of each
  // wrapped continuation line, indenting it one column past the first body line.
  // `wrap-trim` strips that leading boundary space so the queued body
  // left-aligns like every other (non-queued) message. Non-queued messages keep
  // the default wrap untouched.
  const wrapMode = isQueued ? 'wrap-trim' : undefined;

  if (useBriefLayout) {
    const ts = timestamp ? formatBriefTimestamp(timestamp) : '';
    const labelColor = isQueued ? 'subtle' : 'briefLabelYou';
    const textColor = isQueued ? 'subtle' : 'text';
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Box flexDirection="row">
          <Text color={labelColor}>You</Text>
          {ts ? <Text dimColor> {ts}</Text> : null}
        </Box>
        <Text color={textColor} wrap={wrapMode}>{text}</Text>
      </Box>
    );
  }

  return (
    <Text wrap={wrapMode}>
      {showPointer ? <Text color={pointerColor}>{figures.pointer} </Text> : null}
      <ThinkingTextParts text={text} />
    </Text>
  );
}
