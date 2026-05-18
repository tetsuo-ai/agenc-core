// @ts-nocheck
import { isInBundledMode } from '../../../utils/bundledMode.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getCurrentInstallationType } from '../../../utils/doctorDiagnostic.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { isEnvTruthy } from 'src/utils/envUtils.js';
import { useStartupNotification } from './useStartupNotification';
const NPM_DEPRECATION_MESSAGE = 'AgenC has switched from npm to the native installer. Run `agenc install` or see https://github.com/Gitlawb/agenc#quick-start for more options.';
export function useNpmDeprecationNotification() {
  useStartupNotification(_temp);
}
async function _temp() {
  if (isInBundledMode() || isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    return null;
  }
  const installationType = await getCurrentInstallationType();
  if (installationType === "development") {
    return null;
  }
  return {
    timeoutMs: 15000,
    key: "npm-deprecation-warning",
    text: NPM_DEPRECATION_MESSAGE,
    color: "warning",
    priority: "high"
  };
}
