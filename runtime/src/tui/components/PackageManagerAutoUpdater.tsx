import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useRef, useState } from 'react';
import { useInterval } from 'usehooks-ts';
import { Text } from '../ink.js';
import { type AutoUpdaterResult, getLatestVersionFromGcs, getMaxVersion, shouldSkipVersion } from '../../utils/autoUpdater.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { isAutoUpdaterDisabled } from '../../utils/config.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { logForDebugging } from 'src/utils/debug.js';
import { logError } from '../../utils/log.js';
import { getPackageManager } from '../../utils/nativeInstaller/packageManagers.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { gt, gte } from '../../utils/semver.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getExecutionAuthoritySettings } from '../../utils/settings/settings.js'; // upstream-import: keep target is owned by another Z-PURGE item
type Props = {
  isUpdating: boolean;
  onChangeIsUpdating: (isUpdating: boolean) => void;
  onAutoUpdaterResult: (autoUpdaterResult: AutoUpdaterResult) => void;
  autoUpdaterResult: AutoUpdaterResult | null;
  showSuccessMessage: boolean;
  verbose: boolean;
};
export function PackageManagerAutoUpdater(t0: Props): React.ReactNode {
  const $ = _c(12);
  const {
    verbose
  } = t0;
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [packageManager, setPackageManager] = useState("unknown");
  const mountedRef = useRef(true);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = async () => {
      false || false;
      if (isAutoUpdaterDisabled()) {
        return;
      }
      const [channel, pm] = await Promise.all([Promise.resolve(getExecutionAuthoritySettings()?.autoUpdatesChannel ?? "latest"), getPackageManager()]);
      if (!mountedRef.current) {
        return;
      }
      setPackageManager(pm);
      let latest = await getLatestVersionFromGcs(channel);
      const maxVersion = await getMaxVersion();
      if (!mountedRef.current) {
        return;
      }
      if (maxVersion && latest && gt(latest, maxVersion)) {
        logForDebugging(`PackageManagerAutoUpdater: maxVersion ${maxVersion} is set, capping update from ${latest} to ${maxVersion}`);
        if (gte(MACRO.VERSION, maxVersion)) {
          logForDebugging(`PackageManagerAutoUpdater: current version ${MACRO.VERSION} is already at or above maxVersion ${maxVersion}, skipping update`);
          setUpdateAvailable(false);
          return;
        }
        latest = maxVersion;
      }
      const hasUpdate = latest && !gte(MACRO.VERSION, latest) && !shouldSkipVersion(latest);
      setUpdateAvailable(!!hasUpdate);
      if (hasUpdate) {
        logForDebugging(`PackageManagerAutoUpdater: Update available ${MACRO.VERSION} -> ${latest}`);
      }
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const checkForUpdates = t1;
  let t2;
  let t3;
  let t4;
  let t5;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = () => {
      void checkForUpdates().catch((error: unknown) => {
        logError(error);
      });
    };
    t3 = [checkForUpdates];
    $[1] = t2;
    $[2] = t3;
  } else {
    t2 = $[1];
    t3 = $[2];
  }
  const guardedCheckForUpdates = t2;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = () => {
      mountedRef.current = true;
      guardedCheckForUpdates();
      return () => {
        mountedRef.current = false;
      };
    };
    t5 = [guardedCheckForUpdates];
    $[10] = t4;
    $[11] = t5;
  } else {
    t4 = $[10];
    t5 = $[11];
  }
  React.useEffect(t4, t5);
  useInterval(guardedCheckForUpdates, 1800000);
  if (!updateAvailable) {
    return null;
  }
  const updateCommand = packageManager === "homebrew" ? "brew upgrade agenc-code" : packageManager === "winget" ? "winget upgrade AgenC.AgenCCode" : packageManager === "apk" ? "apk upgrade agenc-code" : "your package manager update command";
  let t6;
  if ($[3] !== verbose) {
    t6 = verbose && <Text dimColor={true} wrap="truncate">currentVersion: {MACRO.VERSION}</Text>;
    $[3] = verbose;
    $[4] = t6;
  } else {
    t6 = $[4];
  }
  let t7;
  if ($[5] !== updateCommand) {
    t7 = <Text color="warning" wrap="truncate">Update available! Run: <Text bold={true}>{updateCommand}</Text></Text>;
    $[5] = updateCommand;
    $[6] = t7;
  } else {
    t7 = $[6];
  }
  let t8;
  if ($[7] !== t6 || $[8] !== t7) {
    t8 = <>{t6}{t7}</>;
    $[7] = t6;
    $[8] = t7;
    $[9] = t8;
  } else {
    t8 = $[9];
  }
  return t8;
}
