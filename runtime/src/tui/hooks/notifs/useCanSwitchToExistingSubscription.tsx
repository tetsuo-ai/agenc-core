import * as React from 'react';
import { getOauthProfileFromApiKey } from '../../../services/oauth/getOauthProfile.js';
import { isAgenCAISubscriber } from '../../../agenc/upstream/utils/auth.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { Text } from '../../ink.js';
import { logEvent } from '../../../services/analytics/index';
import { getGlobalConfig, saveGlobalConfig } from '../../../agenc/upstream/utils/config'; // upstream-import: keep target is owned by another Z-PURGE item
import { useStartupNotification } from './useStartupNotification';
const MAX_SHOW_COUNT = 3;

/**
 * Hook to check if the user has a subscription on Console but isn't logged into it.
 */
export function useCanSwitchToExistingSubscription() {
  useStartupNotification(_temp2);
}

/**
 * Checks if the user has a subscription but is not currently logged into it.
 * This helps inform users they should run /login to access their subscription.
 */
async function _temp2() {
  if ((getGlobalConfig().subscriptionNoticeCount ?? 0) >= MAX_SHOW_COUNT) {
    return null;
  }
  const subscriptionType = await getExistingAgenCSubscription();
  if (subscriptionType === null) {
    return null;
  }
  saveGlobalConfig(_temp);
  logEvent("tengu_switch_to_subscription_notice_shown", {});
  return {
    key: "switch-to-subscription",
    jsx: <Text color="suggestion">Use your existing AgenC {subscriptionType} plan with AgenC<Text color="text" dimColor={true}>{" "}· /login to activate</Text></Text>,
    priority: "low"
  };
}
function _temp(current) {
  return {
    ...current,
    subscriptionNoticeCount: (current.subscriptionNoticeCount ?? 0) + 1
  };
}
async function getExistingAgenCSubscription(): Promise<'Max' | 'Pro' | null> {
  // If already using subscription auth, there is nothing to switch to
  if (isAgenCAISubscriber()) {
    return null;
  }
  const profile = await getOauthProfileFromApiKey();
  if (!profile) {
    return null;
  }
  if (profile.account.has_claude_max) {
    return 'Max';
  }
  if (profile.account.has_claude_pro) {
    return 'Pro';
  }
  return null;
}
