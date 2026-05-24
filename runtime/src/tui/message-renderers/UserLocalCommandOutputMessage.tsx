import * as React from 'react';
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js';
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js';
import { LOCAL_COMMAND_STDERR_TAG, LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js';
import { Box, Text } from '../ink.js';
import { extractTag } from '../../utils/messages.js';
import { Markdown } from '../components/markdown/Markdown.js';
import FullWidthRow from '../components/design-system/FullWidthRow';
import { MessageResponse } from '../components/MessageResponse';

type Props = {
  content: string;
};

type IndentedContentProps = {
  children: string;
};

const tagMatcherCache = new Map<string, RegExp>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function closedTagMatcher(tagName: string): RegExp {
  const cached = tagMatcherCache.get(tagName);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }

  const escapedTag = escapeRegExp(tagName);
  const matcher = new RegExp(
    `<${escapedTag}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>`,
    'i',
  );
  tagMatcherCache.set(tagName, matcher);
  return matcher;
}

function extractLocalCommandTag(content: string, tagName: string): string | null {
  const extracted = extractTag(content, tagName);
  if (extracted !== null) {
    return extracted;
  }

  return closedTagMatcher(tagName).test(content) ? '' : null;
}

export function UserLocalCommandOutputMessage({
  content,
}: Props): React.ReactNode {
  const stdout = extractLocalCommandTag(content, LOCAL_COMMAND_STDOUT_TAG);
  const stderr = extractLocalCommandTag(content, LOCAL_COMMAND_STDERR_TAG);

  if (stdout === null && stderr === null) {
    return (
      <MessageResponse>
        <Text dimColor={true}>{NO_CONTENT_MESSAGE}</Text>
      </MessageResponse>
    );
  }

  const lines: React.ReactNode[] = [];
  if (stdout?.trim()) {
    lines.push(<IndentedContent key="stdout">{stdout.trim()}</IndentedContent>);
  }
  if (stderr?.trim()) {
    lines.push(<IndentedContent key="stderr">{stderr.trim()}</IndentedContent>);
  }
  return lines;
}

function IndentedContent({ children }: IndentedContentProps): React.ReactElement {
  if (children.startsWith(`${DIAMOND_OPEN} `) || children.startsWith(`${DIAMOND_FILLED} `)) {
    return <CloudLaunchContent>{children}</CloudLaunchContent>;
  }

  return (
    <FullWidthRow>
      <Text dimColor={true}>{'  ⎿  '}</Text>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown>{children}</Markdown>
      </Box>
    </FullWidthRow>
  );
}

function CloudLaunchContent({
  children,
}: IndentedContentProps): React.ReactElement {
  const diamond = children[0];
  const newlineIndex = children.indexOf('\n');
  const header = newlineIndex === -1 ? children.slice(2) : children.slice(2, newlineIndex);
  const rest = newlineIndex === -1 ? '' : children.slice(newlineIndex + 1).trim();
  const separatorIndex = header.indexOf(' · ');
  const label = separatorIndex === -1 ? header : header.slice(0, separatorIndex);
  const suffix = separatorIndex === -1 ? '' : header.slice(separatorIndex);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="background">{diamond} </Text>
        <Text bold={true}>{label}</Text>
        {suffix && <Text dimColor={true}>{suffix}</Text>}
      </Text>
      {rest && (
        <FullWidthRow>
          <Text dimColor={true}>{'  ⎿  '}</Text>
          <Text dimColor={true}>{rest}</Text>
        </FullWidthRow>
      )}
    </Box>
  );
}
