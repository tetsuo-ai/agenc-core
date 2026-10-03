import { envDynamic } from './envDynamic.js';
import {
  getRuntimeState,
  updateRuntimeState,
  type GlobalRuntimeState,
} from './config.js';

export function hasIdeOnboardingDialogBeenShown(): boolean {
  const config = getRuntimeState();
  const terminal = getIdeOnboardingTerminalKey();
  return config.hasIdeOnboardingBeenShown?.[terminal] === true;
}

export function markDialogAsShown(): void {
  const terminal = getIdeOnboardingTerminalKey();

  updateRuntimeState((current: GlobalRuntimeState) => {
    if (current.hasIdeOnboardingBeenShown?.[terminal]) {
      return current;
    }

    return {
      ...current,
      hasIdeOnboardingBeenShown: {
        ...current.hasIdeOnboardingBeenShown,
        [terminal]: true,
      },
    };
  });
}

function getIdeOnboardingTerminalKey(): string {
  return envDynamic.terminal || 'unknown';
}
