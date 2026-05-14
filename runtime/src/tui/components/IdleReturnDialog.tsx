import { type ReactNode } from 'react';
import { Box, Text } from '../ink.js';
import { formatTokens } from '../../utils/format.js';
import { Select } from './CustomSelect/select.js';
import { Dialog } from './design-system/Dialog.js';

type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never';

type Props = {
  idleMinutes: number;
  totalInputTokens: number;
  onDone: (action: IdleReturnAction) => void;
};

const idleReturnOptions = [
  {
    value: 'continue',
    label: 'Continue this conversation',
  },
  {
    value: 'clear',
    label: 'Send message as a new conversation',
  },
  {
    value: 'never',
    label: "Don't ask me again",
  },
] satisfies Array<{ value: IdleReturnAction; label: string }>;

export function IdleReturnDialog({
  idleMinutes,
  totalInputTokens,
  onDone,
}: Props): ReactNode {
  const formattedIdle = formatIdleDuration(idleMinutes);
  const formattedTokens = formatTokens(totalInputTokens);
  const title = `You've been away ${formattedIdle} and this conversation is ${formattedTokens} tokens.`;

  return (
    <Dialog title={title} onCancel={() => onDone('dismiss')}>
      <Box flexDirection="column">
        <Text>
          If this is a new task, clearing context will save usage and be faster.
        </Text>
      </Box>
      <Select options={idleReturnOptions} onChange={onDone} />
    </Dialog>
  );
}

function formatIdleDuration(minutes: number): string {
  if (minutes < 1) {
    return '< 1m';
  }

  if (minutes < 60) {
    return `${Math.floor(minutes)}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.floor(minutes % 60);
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}
