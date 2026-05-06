// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getAgenCAIOAuthTokens, isAgenCAISubscriber } from '../../utils/auth.js';
import { openBrowser } from '../../utils/browser.js';
import { logError } from '../../utils/log.js';
import { Login } from '../login/login.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode | null> {
  try {
    // Check if user is already on the highest Max plan (20x)
    if (isAgenCAISubscriber()) {
      const tokens = getAgenCAIOAuthTokens();
      let isMax20x = false;
      if (tokens?.subscriptionType && tokens?.rateLimitTier) {
        isMax20x = tokens.subscriptionType === 'max' && tokens.rateLimitTier === 'default_agenc_max_20x';
      } else if (tokens?.accessToken) {
        const profile = await getOauthProfileFromOauthToken(tokens.accessToken);
        isMax20x = profile?.organization?.organization_type === 'agenc_max' && profile?.organization?.rate_limit_tier === 'default_agenc_max_20x';
      }
      if (isMax20x) {
        setTimeout(onDone, 0, 'You are already on the highest Max subscription plan. For additional usage, run /login to switch to an API usage-billed account.');
        return null;
      }
    }
    const url = 'https://agenc.tech/upgrade/max';
    await openBrowser(url);
    return <Login startingMessage={'Starting new login following /upgrade. Exit with Ctrl-C to use existing account.'} onDone={success => {
      context.onChangeAPIKey();
      onDone(success ? 'Login successful' : 'Login interrupted');
    }} />;
  } catch (error) {
    logError(error as Error);
    setTimeout(onDone, 0, 'Failed to open browser. Please visit https://agenc.tech/upgrade/max to upgrade.');
  }
  return null;
}
