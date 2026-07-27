import { feature } from 'bun:bundle';
import * as React from 'react';
import type { AutoUpdaterResult } from '../../utils/autoUpdater.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { isAutoUpdaterDisabled } from '../../utils/config.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from '../../utils/log.js';
import {
  findActiveGeneratedWrapper,
  getCurrentInstallationType,
  isRunningFromPrivateNodeRuntime,
} from '../../utils/doctorDiagnostic.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { MINIMUM_PRIVATE_NODE_RUNTIME_VERSION } from '../../utils/runtime-release-contract.js';
import { gte } from '../../utils/semver.js';
import { VERSION } from '../../version.js';
import { AutoUpdater } from './AutoUpdater.js';
import { NativeAutoUpdater } from './NativeAutoUpdater.js';
import { PackageManagerAutoUpdater } from './PackageManagerAutoUpdater.js';

type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};

export function AutoUpdaterWrapper({
  isUpdating,
  onChangeIsUpdating,
  onAutoUpdaterResult,
  autoUpdaterResult,
  showSuccessMessage,
  verbose
}: Props): React.ReactNode {
  const [useNativeInstaller, setUseNativeInstaller] = React.useState<boolean | null>(null);
  const [isPackageManager, setIsPackageManager] = React.useState<boolean | null>(null);
  const [skipLegacyAutoUpdaters, setSkipLegacyAutoUpdaters] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    const checkInstallation = async () => {
      if (feature("SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED") && isAutoUpdaterDisabled()) {
        logForDebugging("AutoUpdaterWrapper: Skipping detection, auto-updates disabled");
        return;
      }
      const activeGeneratedWrapper = await findActiveGeneratedWrapper();
      if (!mounted) {
        return;
      }
      if (activeGeneratedWrapper !== null) {
        // Generated wrappers activate content-addressed runtime + private-Node
        // trees through `agenc update`. NativeAutoUpdater installs an unrelated
        // legacy single-binary layout and must never be allowed to rewrite one.
        logForDebugging(
          "AutoUpdaterWrapper: Standalone wrappers update only through `agenc update`; skipping legacy native auto-updater",
        );
        setSkipLegacyAutoUpdaters(true);
        setUseNativeInstaller(false);
        setIsPackageManager(false);
        return;
      }
      const installationType = await getCurrentInstallationType({
        activeGeneratedWrapper,
      });
      logForDebugging(`AutoUpdaterWrapper: Installation type: ${installationType}`);
      if (!mounted) {
        return;
      }
      if (
        installationType !== "package-manager" &&
        (
          isRunningFromPrivateNodeRuntime() ||
          (
            installationType === "native" &&
            gte(VERSION, MINIMUM_PRIVATE_NODE_RUNTIME_VERSION)
          )
        )
      ) {
        logForDebugging(
          "AutoUpdaterWrapper: Private-Node runtimes update only through `agenc update`; skipping legacy auto-updaters",
        );
        setSkipLegacyAutoUpdaters(true);
        setUseNativeInstaller(false);
        setIsPackageManager(false);
        return;
      }
      setUseNativeInstaller(installationType === "native");
      setIsPackageManager(installationType === "package-manager");
    };
    void checkInstallation().catch(error => {
      logError(error);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (useNativeInstaller === null || isPackageManager === null) {
    return null;
  }
  if (skipLegacyAutoUpdaters) {
    return null;
  }
  if (isPackageManager) {
    return <PackageManagerAutoUpdater verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} isUpdating={isUpdating} onChangeIsUpdating={onChangeIsUpdating} showSuccessMessage={showSuccessMessage} />;
  }
  const Updater = useNativeInstaller ? NativeAutoUpdater : AutoUpdater;
  return <Updater verbose={verbose} onAutoUpdaterResult={onAutoUpdaterResult} autoUpdaterResult={autoUpdaterResult} isUpdating={isUpdating} onChangeIsUpdating={onChangeIsUpdating} showSuccessMessage={showSuccessMessage} />;
}
