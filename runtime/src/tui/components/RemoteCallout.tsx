// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import React, { useCallback, useEffect, useRef } from 'react';
import { isBridgeEnabled } from '../../bridge/bridgeEnabled';
import { Box, Text } from '../ink.js';
import { getAgenCAIOAuthTokens } from '../../utils/auth.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'; // upstream-import: keep target is owned by another Z-PURGE item
import type { OptionWithDescription } from './CustomSelect/select';
import { Select } from './CustomSelect/select';
import { PermissionDialog } from './permissions/PermissionDialog';
type RemoteCalloutSelection = 'enable' | 'dismiss';
type Props = {
  onDone: (selection: RemoteCalloutSelection) => void;
};
export function RemoteCallout({
  onDone
}: Props): React.ReactNode {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const handleCancel = useCallback((): void => {
    onDoneRef.current('dismiss');
  }, []);

  // Permanently mark as seen on mount so it only shows once
  useEffect(() => {
    saveGlobalConfig(current => {
      if (current.remoteDialogSeen) return current;
      return {
        ...current,
        remoteDialogSeen: true
      };
    });
  }, []);
  const handleSelect = useCallback((value: RemoteCalloutSelection): void => {
    onDoneRef.current(value);
  }, []);
  const options: OptionWithDescription<RemoteCalloutSelection>[] = [{
    label: 'Enable Remote Control for this session',
    description: 'Opens a secure connection to agenc.ai.',
    value: 'enable'
  }, {
    label: 'Never mind',
    description: 'You can always enable it later with /remote-control.',
    value: 'dismiss'
  }];
  return <PermissionDialog title="Remote Control">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1} flexDirection="column">
          <Text>
            Remote Control lets you access this CLI session from the web
            (agenc.ai/code) or the AgenC app, so you can pick up where you
            left off on any device.
          </Text>
          <Text> </Text>
          <Text>
            You can disconnect remote access anytime by running /remote-control
            again.
          </Text>
        </Box>
        <Box>
          <Select options={options} onChange={handleSelect} onCancel={handleCancel} />
        </Box>
      </Box>
    </PermissionDialog>;
}

/**
 * Check whether to show the remote callout (first-time dialog).
 */
export function shouldShowRemoteCallout(): boolean {
  const config = getGlobalConfig();
  if (config.remoteDialogSeen) return false;
  if (!isBridgeEnabled()) return false;
  const tokens = getAgenCAIOAuthTokens();
  if (!tokens?.accessToken) return false;
  return true;
}
