import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { useUpdateNotification } from '../hooks/useUpdateNotification.js';
import { Box, Text } from '../ink.js';
import { type AutoUpdaterResult, getLatestVersion, getMaxVersion, type InstallStatus, installGlobalPackage, shouldSkipVersion } from '../../utils/autoUpdater.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getGlobalConfig, isAutoUpdaterDisabled } from '../../utils/config.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from '../../utils/log.js';
import { getCurrentInstallationType } from '../../utils/doctorDiagnostic.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { installOrUpdateAgenCPackage, localInstallationExists } from '../../utils/localInstaller.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { removeInstalledSymlink } from '../../utils/nativeInstaller/installer.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { gt, gte } from '../../utils/semver.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { selectAgenCTuiGlyphs } from '../glyphs.js';
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function AutoUpdater({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [versions, setVersions] = useState<{
    global?: string | null;
    latest?: string | null;
  }>({});
  const [hasLocalInstall, setHasLocalInstall] = useState(false);
  const updateSemver = useUpdateNotification(autoUpdaterResult?.version);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    void localInstallationExists().then(exists => {
      if (mountedRef.current) {
        setHasLocalInstall(exists);
      }
    }, (error: unknown) => {
      logError(error);
    });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Track latest isUpdating value in a ref so the memoized checkForUpdates
  // callback always sees the current value. Without this, the 30-minute
  // interval fires with a stale closure where isUpdating is false, allowing
  // a concurrent installGlobalPackage() to run while one is already in
  // progress.
  const isUpdatingRef = useRef(isUpdating);
  isUpdatingRef.current = isUpdating;
  const checkForUpdates = React.useCallback(async () => {
    let didStartUpdating = false;
    const finishStartedUpdate = () => {
      if (didStartUpdating) {
        onChangeIsUpdating(false);
        didStartUpdating = false;
      }
    };
    try {
      if (isUpdatingRef.current) {
        return;
      }
      if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') {
        logForDebugging('AutoUpdater: Skipping update check in test/dev environment');
        return;
      }
      const currentVersion = MACRO.VERSION;
      const channel = getExecutionAuthoritySettings()?.autoUpdatesChannel ?? 'latest';
      let latestVersion = await getLatestVersion(channel);
      const isDisabled = isAutoUpdaterDisabled();
      if (!mountedRef.current || isUpdatingRef.current) {
        return;
      }

      // Check if max version is set (server-side kill switch for auto-updates)
      const maxVersion = await getMaxVersion();
      if (!mountedRef.current || isUpdatingRef.current) {
        return;
      }
      if (maxVersion && latestVersion && gt(latestVersion, maxVersion)) {
        logForDebugging(`AutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latestVersion} to ${maxVersion}`);
        if (gte(currentVersion, maxVersion)) {
          logForDebugging(`AutoUpdater: current version ${currentVersion} is already at or above maxVersion ${maxVersion}, skipping update`);
          setVersions({
            global: currentVersion,
            latest: latestVersion
          });
          return;
        }
        latestVersion = maxVersion;
      }
      setVersions({
        global: currentVersion,
        latest: latestVersion
      });

      // Check if update needed and perform update
      if (!isDisabled && currentVersion && latestVersion && !gte(currentVersion, latestVersion) && !shouldSkipVersion(latestVersion)) {
        onChangeIsUpdating(true);
        didStartUpdating = true;

        // Remove native installer symlink since we're using JS-based updates
        // But only if user hasn't migrated to native installation
        const config = getGlobalConfig();
        if (config.installMethod !== 'native') {
          await removeInstalledSymlink();
        }
        if (!mountedRef.current) {
          finishStartedUpdate();
          return;
        }

        // Detect actual running installation type
        const installationType = await getCurrentInstallationType();
        if (!mountedRef.current) {
          finishStartedUpdate();
          return;
        }
        logForDebugging(`AutoUpdater: Detected installation type: ${installationType}`);

        // Skip update for development builds
        if (installationType === 'development') {
          logForDebugging('AutoUpdater: Cannot auto-update development build');
          finishStartedUpdate();
          return;
        }

        // Choose the appropriate update method based on what's actually running
        let installStatus: InstallStatus;
        if (installationType === 'npm-local') {
          // Use local update for local installations
          logForDebugging('AutoUpdater: Using local update method');
          installStatus = await installOrUpdateAgenCPackage(channel);
        } else if (installationType === 'npm-global') {
          // Use global update for global installations
          logForDebugging('AutoUpdater: Using global update method');
          installStatus = await installGlobalPackage();
        } else if (installationType === 'native') {
          // This shouldn't happen - native should use NativeAutoUpdater
          logForDebugging('AutoUpdater: Unexpected native installation in non-native updater');
          finishStartedUpdate();
          return;
        } else {
          // Fallback to config-based detection for unknown types
          logForDebugging(`AutoUpdater: Unknown installation type, falling back to config`);
          const isMigrated = config.installMethod === 'local';
          if (isMigrated) {
            installStatus = await installOrUpdateAgenCPackage(channel);
          } else {
            installStatus = await installGlobalPackage();
          }
        }
        if (!mountedRef.current) {
          finishStartedUpdate();
          return;
        }
        finishStartedUpdate();
        onAutoUpdaterResult({
          version: latestVersion,
          status: installStatus
        });
      }
    } catch (error) {
      logError(error);
      finishStartedUpdate();
    }
    // isUpdating intentionally omitted from deps; we read isUpdatingRef
    // instead so the guard is always current without changing callback
    // identity (which would re-trigger the initial-check useEffect below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: isUpdating read via ref
  }, [onAutoUpdaterResult]);

  // Initial check
  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  // Check every 30 minutes
  useInterval(checkForUpdates, 30 * 60 * 1000);
  if (!autoUpdaterResult?.version && (!versions.global || !versions.latest)) {
    return null;
  }
  if (!autoUpdaterResult?.version && !isUpdating) {
    return null;
  }
  const glyphs = selectAgenCTuiGlyphs();
  return <Box flexDirection="row" gap={1}>
      {verbose && <Text dimColor wrap="truncate">
          globalVersion: {versions.global} {glyphs.separator} latestVersion:{' '}
          {versions.latest}
        </Text>}
      {isUpdating ? <>
          <Box>
            <Text color="text" dimColor wrap="truncate">
              Auto-updating{glyphs.ellipsis}
            </Text>
          </Box>
        </> : autoUpdaterResult?.status === 'success' && showSuccessMessage && updateSemver && <Text color="success" wrap="truncate">
            {glyphs.statusSuccess} Update installed {glyphs.separator} Restart to apply
          </Text>}
      {(autoUpdaterResult?.status === 'install_failed' || autoUpdaterResult?.status === 'no_permissions') && <Text color="error" wrap="truncate">
          {glyphs.statusError} Auto-update failed {glyphs.separator} Try <Text bold>agenc doctor</Text> or{' '}
          <Text bold>
            {hasLocalInstall ? `cd ~/.agenc/local && npm update ${MACRO.PACKAGE_URL}` : `npm i -g ${MACRO.PACKAGE_URL}`}
          </Text>
        </Text>}
    </Box>;
}
