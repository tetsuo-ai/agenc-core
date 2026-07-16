import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from '../../utils/log.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { isAutoUpdaterDisabled } from '../../utils/config.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { installLatest } from '../../utils/nativeInstaller/installer.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'; // upstream-import: keep target is owned by another Z-PURGE item

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function NativeAutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    current?: string | null;
    latest?: string | null;
  }>({});
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  const channel = getExecutionAuthoritySettings()?.autoUpdatesChannel ?? 'latest';

  // Track latest isUpdating value in a ref so the memoized checkForUpdates
  // callback always sees the current value without changing callback identity
  // (which would re-trigger the initial-check useEffect below and cause
  // repeated downloads on remount — the upstream trigger for #22413).
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;
  const checkForUpdates = React.useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }
    if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
      logForDebugging('NativeAutoUpdater: Skipping update check in test/dev environment');
      return;
    }
    if (isAutoUpdaterDisabled()) {
      return;
    }
    onChangeIsUpdating(true);
    try {
      const result = await installLatest(channel);
      const currentVersion = MACRO.VERSION;

      // Handle lock contention gracefully - just return without treating as error
      if (result.lockFailed) {
        return; // Silently skip this update check, will try again later
      }

      // Update versions for display
      setVersions({
        current: currentVersion,
        latest: result.latestVersion
      });
      if (result.wasUpdated) {
        onAutoUpdaterResult({
          version: result.latestVersion,
          status: 'success'
        });
      }
    } catch (error) {
      logError(error);
      onAutoUpdaterResult({
        version: null,
        status: 'install_failed'
      });
    } finally {
      onChangeIsUpdating(false);
    }
    // isUpdating intentionally omitted from deps; we read isUpdatingRef
    // instead so the guard is always current without changing callback
    // identity (which would re-trigger the initial-check useEffect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: isUpdating read via ref
  }, [onAutoUpdaterResult, channel]);

  // Initial check
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // Check every 30 minutes
  useInterval(checkForUpdates, 30 * 60 * 1000);
  const hasUpdateResult = autoUpdaterResult?.status === 'install_failed' || !!autoUpdaterResult?.version;
  const hasVersionInfo = !!versions.current && !!versions.latest;
  // Show the component when there is an update result to display or an active
  // check has version info to show.
  const shouldRender = hasUpdateResult || isUpdating && hasVersionInfo;
  if (!shouldRender) {
    return null;
  }
  const glyphs = selectAgenCTuiGlyphs();
  return <Box flexDirection="row" gap={1}>
      {verbose && <Text dimColor wrap="truncate">
          current: {versions.current} {glyphs.separator} {channel}: {versions.latest}
        </Text>}
      {isUpdating ? <Box>
          <Text dimColor wrap="truncate">
            Checking for updates
          </Text>
        </Box> : autoUpdaterResult?.status === 'success' && showSuccessMessage && updateSemver && <Text color="success" wrap="truncate">
            {glyphs.statusSuccess} Update installed {glyphs.separator} Restart to update
          </Text>}
      {autoUpdaterResult?.status === 'install_failed' && <Text color="error" wrap="truncate">
          {glyphs.statusError} Auto-update failed {glyphs.separator} Try <Text bold>/status</Text>
        </Text>}
    </Box>;
}
