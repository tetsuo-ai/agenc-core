import * as React from 'react';
import { Text } from '../ink.js';
import { isAgenCAISubscriber } from '../utils/auth.js';
import { isChromeExtensionInstalled, shouldEnableAgenCInChrome } from '../utils/claudeInChrome/setup.js';
import { isRunningOnHomespace } from '../utils/envUtils.js';
import { useStartupNotification } from './notifs/useStartupNotification.js';
function getChromeFlag(): boolean | undefined {
  if (process.argv.includes('--chrome')) {
    return true;
  }
  if (process.argv.includes('--no-chrome')) {
    return false;
  }
  return undefined;
}
export function useChromeExtensionNotification() {
  useStartupNotification(_temp);
}
async function _temp() {
  const chromeFlag = getChromeFlag();
  if (!shouldEnableAgenCInChrome(chromeFlag)) {
    return null;
  }
  if (true && !isAgenCAISubscriber()) {
    return {
      key: "chrome-requires-subscription",
      jsx: <Text color="error">AgenC in Chrome requires a agenc.ai subscription</Text>,
      priority: "immediate",
      timeoutMs: 5000
    };
  }
  const installed = await isChromeExtensionInstalled();
  if (!installed && !isRunningOnHomespace()) {
    return {
      key: "chrome-extension-not-detected",
      jsx: <Text color="warning">Chrome extension not detected · https://agenc.ai/chrome to install</Text>,
      priority: "immediate",
      timeoutMs: 3000
    };
  }
  if (chromeFlag === undefined) {
    return {
      key: "claude-in-chrome-default-enabled",
      text: "AgenC in Chrome enabled \xB7 /chrome",
      priority: "low"
    };
  }
  return null;
}
