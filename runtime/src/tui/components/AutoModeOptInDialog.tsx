import React from 'react';
import { Box, Link, Text } from '../ink.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import { Select } from './CustomSelect/select';
import { Dialog } from './design-system/Dialog';

// NOTE: This copy is legally reviewed — do not modify without Legal team approval.
export const AUTO_MODE_DESCRIPTION = "Auto mode lets AgenC handle permission prompts automatically — AgenC checks each tool call for risky actions and prompt injection before executing. Actions AgenC identifies as safe are executed, while actions AgenC identifies as risky are blocked and AgenC may try a different approach. Ideal for long-running tasks. Sessions are slightly more expensive. AgenC can make mistakes that allow harmful commands to run, it's recommended to only use in isolated environments. Shift+Tab to change mode.";
type Props = {
  onAccept(): void;
  onDecline(): void;
  // Startup gate: decline exits the process, so relabel accordingly.
  declineExits?: boolean;
};

type AutoModeDecision = 'accept' | 'accept-default' | 'decline';

const ACCEPT_DEFAULT_OPTION = {
  label: 'Yes, and make it my default mode',
  value: 'accept-default',
} as const;

const ACCEPT_OPTION = {
  label: 'Yes, enable auto mode',
  value: 'accept',
} as const;

export function AutoModeOptInDialog({
  onAccept,
  onDecline,
  declineExits,
}: Props) {
  const handleDecline = React.useCallback(() => {
    onDecline();
  }, [onDecline]);

  const handleChange = React.useCallback(
    (value: AutoModeDecision) => {
      switch (value) {
        case 'accept':
          updateSettingsForSource('userSettings', {
            skipAutoPermissionPrompt: true,
          });
          onAccept();
          return;
        case 'accept-default':
          updateSettingsForSource('userSettings', {
            skipAutoPermissionPrompt: true,
            permissions: {
              defaultMode: 'auto',
            },
          });
          onAccept();
          return;
        case 'decline':
          handleDecline();
          return;
      }
    },
    [handleDecline, onAccept],
  );

  const options = [
    ACCEPT_DEFAULT_OPTION,
    ACCEPT_OPTION,
    {
      label: declineExits ? 'No, exit' : 'No, go back',
      value: 'decline',
    } as const,
  ];

  return (
    <Dialog title="Enable auto mode?" color="warning" onCancel={handleDecline}>
      <Box flexDirection="column" gap={1}>
        <Text>{AUTO_MODE_DESCRIPTION}</Text>
        <Link url="https://agenc.tech/docs/en/security" />
      </Box>
      <Select<AutoModeDecision>
        options={options}
        onChange={handleChange}
        onCancel={handleDecline}
      />
    </Dialog>
  );
}
