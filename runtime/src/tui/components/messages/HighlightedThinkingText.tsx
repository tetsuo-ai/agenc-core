import figures from 'figures';
import * as React from 'react';
import { useContext } from 'react';

import { useQueuedMessage } from '../../context/QueuedMessageContext';
import { Box, Text } from '../../ink.js';
import { formatBriefTimestamp } from '../../../utils/formatBriefTimestamp.js'; // upstream-import: keep target is owned by another Z-PURGE item
import {
  findThinkingTriggerPositions,
  getRainbowColor,
  isUltrathinkEnabled,
} from '../../../utils/thinking.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { MessageActionsSelectedContext } from '../messageActions';

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
        <Text color={textColor}>{text}</Text>
      </Box>
    );
  }

  return (
    <Text>
      {showPointer ? <Text color={pointerColor}>{figures.pointer} </Text> : null}
      <ThinkingTextParts text={text} />
    </Text>
  );
}
