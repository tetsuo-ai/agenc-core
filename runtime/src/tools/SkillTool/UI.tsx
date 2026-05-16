// @ts-nocheck -- moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { SubAgentProvider } from 'src/tui/components/CtrlOToExpand.js';
import { FallbackToolUseErrorMessage } from 'src/tui/components/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from 'src/tui/components/FallbackToolUseRejectedMessage.js';
import type { z } from 'zod/v4';
import type { Command } from '../../commands.js';
import { Byline } from '../../tui/components/design-system/Byline.js';
import { Message as MessageComponent } from '../../tui/components/Message.js';
import { MessageResponse } from '../../tui/components/MessageResponse.js';
import { Box, Text } from '../../tui/ink.js';
import type { Tools } from '../Tool.js';
import type { ProgressMessage } from '../../types/message.js';
import { buildSubagentLookups, EMPTY_LOOKUPS } from '../../utils/messages.js';
import { plural } from '../../utils/stringUtils.js';
import type { inputSchema, Output, Progress } from './SkillTool.js';
type Input = z.infer<ReturnType<typeof inputSchema>>;
const MAX_PROGRESS_MESSAGES_TO_SHOW = 3;
const INITIALIZING_TEXT = 'Initializing…';
const MAX_ARGS_PREVIEW = 72;

function compactSkillPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_ARGS_PREVIEW) {
    return compact;
  }
  return `${compact.slice(0, MAX_ARGS_PREVIEW - 1).trimEnd()}…`;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeSkillInput(input: Partial<Input>): {
  skill?: string;
  args?: string;
} {
  const rawSkill = input.skill;
  if (typeof rawSkill !== 'string') {
    return {
      args: input.args
    };
  }
  const parsedSkill = parseJsonObject(rawSkill);
  if (parsedSkill) {
    const nestedSkill = typeof parsedSkill.skill === 'string' ? parsedSkill.skill : rawSkill;
    const nestedArgs = typeof parsedSkill.args === 'string' ? parsedSkill.args : input.args;
    return {
      skill: nestedSkill,
      args: nestedArgs
    };
  }
  return {
    skill: rawSkill,
    args: input.args
  };
}

function summarizeSkillArgs(args: string | undefined): string | null {
  if (!args || args.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonObject(args);
  if (parsed) {
    const parts = Object.entries(parsed).flatMap(([key, value]) => {
      if (value === undefined || value === null) {
        return [];
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return [`${key} ${String(value)}`];
      }
      return [`${key} ${JSON.stringify(value)}`];
    });
    if (parts.length > 0) {
      return compactSkillPreview(parts.join(', '));
    }
  }
  return compactSkillPreview(args);
}

function formatDollarSkillName(skill: string): string {
  if (skill.startsWith('$')) {
    return skill;
  }
  return `$${skill.replace(/^\/+/, '')}`;
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  // Handle forked skill result
  if ('status' in output && output.status === 'forked') {
    return <MessageResponse height={1}>
        <Text>
          <Byline>{['Done']}</Byline>
        </Text>
      </MessageResponse>;
  }
  const parts: string[] = ['Successfully loaded skill'];
  // Show tools count (only for inline skills)
  if ('allowedTools' in output && output.allowedTools && output.allowedTools.length > 0) {
    const count = output.allowedTools.length;
    parts.push(`${count} ${plural(count, 'tool')} allowed`);
  }
  // Show model if non-default (only for inline skills)
  if ('model' in output && output.model) {
    parts.push(output.model);
  }
  return <MessageResponse height={1}>
      <Text>
        <Byline>{parts}</Byline>
      </Text>
    </MessageResponse>;
}
export function renderToolUseMessage({
  skill,
  args
}: Partial<Input>, {
  commands
}: {
  commands?: Command[];
}): React.ReactNode {
  const normalized = normalizeSkillInput({
    skill,
    args
  });
  if (!normalized.skill) {
    return null;
  }
  // Only compatibility /commands_DEPRECATED entries need the command lookup so we can
  // preserve command-style display. Plugin skills already carry the
  // invoked skill name in `skill`, so transcript/history rendering does not
  // need plugin command metadata.
  const command = commands?.find(c => c.name === normalized.skill);
  const displayName =
    command?.loadedFrom === 'commands_DEPRECATED'
      ? `/${normalized.skill.replace(/^\/+/, '')}`
      : formatDollarSkillName(normalized.skill);
  const argsPreview = summarizeSkillArgs(normalized.args);
  return argsPreview ? `${displayName} · ${argsPreview}` : displayName;
}
export function renderToolUseProgressMessage(progressMessages: ProgressMessage<Progress>[], {
  tools,
  verbose
}: {
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  if (!progressMessages.length) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }
  // Take only the last few messages for display in non-verbose mode
  const displayedMessages = verbose ? progressMessages : progressMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW);
  const hiddenCount = progressMessages.length - displayedMessages.length;
  const {
    inProgressToolUseIDs
  } = buildSubagentLookups(progressMessages.map(pm => pm.data));
  return <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {displayedMessages.map(progressMessage => <Box key={progressMessage.uuid} height={1} overflow="hidden">
              <MessageComponent message={progressMessage.data.message} lookups={EMPTY_LOOKUPS} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} style="condensed" isTranscriptMode={false} isStatic={true} />
            </Box>)}
        </SubAgentProvider>
        {hiddenCount > 0 && <Text dimColor>
            +{hiddenCount} more tool {plural(hiddenCount, 'use')}
          </Text>}
      </Box>
    </MessageResponse>;
}
export function renderToolUseRejectedMessage(_input: Input, {
  progressMessagesForMessage,
  tools,
  verbose
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose
    })}
      <FallbackToolUseRejectedMessage />
    </>;
}
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  progressMessagesForMessage,
  tools,
  verbose
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose
    })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>;
}
