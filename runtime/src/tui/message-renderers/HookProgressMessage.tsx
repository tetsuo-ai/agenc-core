import * as React from 'react';
import type { HookEvent } from '../../entrypoints/agentSdkTypes.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import { Box, Text } from '../ink.js';
import { MessageResponse } from '../components/MessageResponse';
type Props = {
  hookEvent: HookEvent;
  lookups: ReturnType<typeof buildMessageLookups>;
  toolUseID: string;
  verbose: boolean;
  isTranscriptMode?: boolean;
};
export function getHookProgressRunningLabel(
  inProgressHookCount: number,
  env: { readonly AGENC_TUI_GLYPHS?: string } = process.env,
): string {
  const ellipsis = selectAgenCTuiGlyphs(env).ellipsis;
  return inProgressHookCount === 1 ? ` hook${ellipsis}` : ` hooks${ellipsis}`;
}
export function getHookProgressTranscriptRunningLabel(inProgressHookCount: number): string {
  return inProgressHookCount === 1 ? ' hook running' : ' hooks running';
}

function HookProgressRow({
  hookEvent,
  suffix,
}: {
  hookEvent: HookEvent;
  suffix: string;
}): React.ReactElement {
  return (
    <MessageResponse>
      <Box flexDirection="row">
        <Text dimColor={true}>Running </Text>
        <Text dimColor={true} bold={true}>{hookEvent}</Text>
        <Text dimColor={true}>{suffix}</Text>
      </Box>
    </MessageResponse>
  );
}

export function HookProgressMessage({
  hookEvent,
  lookups,
  toolUseID,
  isTranscriptMode,
}: Props): React.ReactElement | null {
  const inProgressHookCount =
    lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;

  if (inProgressHookCount <= 0) {
    return null;
  }

  if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') {
    if (isTranscriptMode) {
      return (
        <MessageResponse>
          <Box flexDirection="row">
            <Text dimColor={true}>{inProgressHookCount} </Text>
            <Text dimColor={true} bold={true}>{hookEvent}</Text>
            <Text dimColor={true}>
              {getHookProgressTranscriptRunningLabel(inProgressHookCount)}
            </Text>
          </Box>
        </MessageResponse>
      );
    }

    return (
      <HookProgressRow
        hookEvent={hookEvent}
        suffix={getHookProgressRunningLabel(inProgressHookCount)}
      />
    );
  }

  const resolvedHookCount =
    lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0;
  if (resolvedHookCount >= inProgressHookCount) {
    return null;
  }

  return (
    <HookProgressRow
      hookEvent={hookEvent}
      suffix={getHookProgressRunningLabel(inProgressHookCount)}
    />
  );
}
