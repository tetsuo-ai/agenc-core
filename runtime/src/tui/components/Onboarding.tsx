import { c as _c } from "react-compiler-runtime";
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../services/analytics/index.js';
import { setupTerminal, shouldOfferTerminalSetup } from '../../commands/terminalSetup/terminalSetup';
import { useExitOnCtrlCDWithKeybindings } from 'src/tui/hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Link, Newline, Text, useTheme } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { isAnthropicAuthEnabled } from '../../agenc/upstream/utils/auth'; // upstream-import: keep target is owned by another Z-PURGE item
import { normalizeApiKeyForConfig } from '../../agenc/upstream/utils/authPortable'; // upstream-import: keep target is owned by another Z-PURGE item
import { getCustomApiKeyStatus } from '../../agenc/upstream/utils/config'; // upstream-import: keep target is owned by another Z-PURGE item
import { env } from '../../agenc/upstream/utils/env'; // upstream-import: keep target is owned by another Z-PURGE item
import { isRunningOnHomespace } from '../../utils/envUtils';
import { PreflightStep } from '../../agenc/upstream/utils/preflightChecks'; // upstream-import: keep target is owned by another Z-PURGE item
import type { ThemeSetting } from '../../agenc/upstream/utils/theme'; // upstream-import: keep target is owned by another Z-PURGE item
import { ApproveApiKey } from './ApproveApiKey';
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow';
import { Select } from './CustomSelect/select';
import { WelcomeV2 } from './LogoV2/WelcomeV2';
import { PressEnterToContinue } from './PressEnterToContinue';
import { ThemePicker } from './ThemePicker';
import { OrderedList } from './ui/OrderedList';
type StepId = 'preflight' | 'theme' | 'oauth' | 'api-key' | 'security' | 'terminal-setup';
interface OnboardingStep {
  id: StepId;
  component: React.ReactNode;
}
type Props = {
  onDone(): void;
};
export function Onboarding({
  onDone
}: Props): React.ReactNode {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [skipOAuth, setSkipOAuth] = useState(false);
  const [oauthEnabled] = useState(() => isAnthropicAuthEnabled());
  const [theme, setTheme] = useTheme();
  useEffect(() => {
    logEvent('tengu_began_setup', {
      oauthEnabled
    });
  }, [oauthEnabled]);
  function goToNextStep() {
    if (currentStepIndex < steps.length - 1) {
      const nextIndex = currentStepIndex + 1;
      setCurrentStepIndex(nextIndex);
      logEvent('tengu_onboarding_step', {
        oauthEnabled,
        stepId: steps[nextIndex]?.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    } else {
      onDone();
    }
  }
  function handleThemeSelection(newTheme: ThemeSetting) {
    setTheme(newTheme);
    goToNextStep();
  }
  const exitState = useExitOnCtrlCDWithKeybindings();

  // Define all onboarding steps
  const themeStep = <Box marginX={1}>
      <ThemePicker onThemeSelect={handleThemeSelection} showIntroText={true} helpText="To change this later, run /theme" hideEscToCancel={true} skipExitHandling={true} // Skip exit handling as Onboarding already handles it
    />
    </Box>;
  const securityStep = <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Security notes:</Text>
      <Box flexDirection="column" width={70}>
        {/**
         * OrderedList misnumbers items when rendering conditionally,
         * so put all items in the if/else
         */}
        <OrderedList>
          <OrderedList.Item>
            <Text>AgenC can make mistakes</Text>
            <Text dimColor wrap="wrap">
              You should always review AgenC&apos;s responses, especially when
              <Newline />
              running code.
              <Newline />
            </Text>
          </OrderedList.Item>
          <OrderedList.Item>
            <Text>
              Due to prompt injection risks, only use it with code you trust
            </Text>
            <Text dimColor wrap="wrap">
              For more details see:
              <Newline />
              <Link url="https://code.agenc.com/docs/en/security" />
            </Text>
          </OrderedList.Item>
        </OrderedList>
      </Box>
      <PressEnterToContinue />
    </Box>;
  const preflightStep = <PreflightStep onSuccess={goToNextStep} />;
  // Create the steps array - determine which steps to include based on reAuth and oauthEnabled
  const apiKeyNeedingApproval = useMemo(() => {
    // Add API key step if needed
    // On homespace, ANTHROPIC_API_KEY is preserved in process.env for child
    // processes but ignored by AgenC itself (see auth.ts).
    if (!process.env.ANTHROPIC_API_KEY || isRunningOnHomespace() || !isAnthropicAuthEnabled()) {
      return '';
    }
    const customApiKeyTruncated = normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY);
    if (getCustomApiKeyStatus(customApiKeyTruncated) === 'new') {
      return customApiKeyTruncated;
    }
  }, []);
  function handleApiKeyDone(approved: boolean) {
    if (approved) {
      setSkipOAuth(true);
    }
    goToNextStep();
  }
  const steps: OnboardingStep[] = [];
  if (oauthEnabled) {
    steps.push({
      id: 'preflight',
      component: preflightStep
    });
  }
  steps.push({
    id: 'theme',
    component: themeStep
  });
  if (apiKeyNeedingApproval) {
    steps.push({
      id: 'api-key',
      component: <ApproveApiKey customApiKeyTruncated={apiKeyNeedingApproval} onDone={handleApiKeyDone} />
    });
  }
  if (oauthEnabled) {
    steps.push({
      id: 'oauth',
      component: <SkippableStep skip={skipOAuth} onSkip={goToNextStep}>
          <ConsoleOAuthFlow onDone={goToNextStep} />
        </SkippableStep>
    });
  }
  steps.push({
    id: 'security',
    component: securityStep
  });
  if (shouldOfferTerminalSetup()) {
    steps.push({
      id: 'terminal-setup',
      component: <Box flexDirection="column" gap={1} paddingLeft={1}>
          <Text bold>Use AgenC&apos;s terminal setup?</Text>
          <Box flexDirection="column" width={70} gap={1}>
            <Text>
              For the optimal coding experience, enable the recommended settings
              <Newline />
              for your terminal:{' '}
              {env.terminal === 'Apple_Terminal' ? 'Option+Enter for newlines and visual bell' : 'Shift+Enter for newlines'}
            </Text>
            <Select options={[{
            label: 'Yes, use recommended settings',
            value: 'install'
          }, {
            label: 'No, maybe later with /terminal-setup',
            value: 'no'
          }]} onChange={value => {
            if (value === 'install') {
              // Errors already logged in setupTerminal, just swallow and proceed
              void setupTerminal(theme).catch(() => {}).finally(goToNextStep);
            } else {
              goToNextStep();
            }
          }} onCancel={() => goToNextStep()} />
            <Text dimColor>
              {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Enter to confirm · Esc to skip</>}
            </Text>
          </Box>
        </Box>
    });
  }
  const currentStep = steps[currentStepIndex];

  // Handle Enter on security step and Escape on terminal-setup step
  // Dependencies match what goToNextStep uses internally
  const handleSecurityContinue = useCallback(() => {
    if (currentStepIndex === steps.length - 1) {
      onDone();
    } else {
      goToNextStep();
    }
  }, [currentStepIndex, steps.length, oauthEnabled, onDone]);
  const handleTerminalSetupSkip = useCallback(() => {
    goToNextStep();
  }, [currentStepIndex, steps.length, oauthEnabled, onDone]);
  useKeybindings({
    'confirm:yes': handleSecurityContinue
  }, {
    context: 'Confirmation',
    isActive: currentStep?.id === 'security'
  });
  useKeybindings({
    'confirm:no': handleTerminalSetupSkip
  }, {
    context: 'Confirmation',
    isActive: currentStep?.id === 'terminal-setup'
  });
  return <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        {currentStep?.component}
        {exitState.pending && <Box padding={1}>
            <Text dimColor>Press {exitState.keyName} again to exit</Text>
          </Box>}
      </Box>
    </Box>;
}
export function SkippableStep(t0) {
  const $ = _c(4);
  const {
    skip,
    onSkip,
    children
  } = t0;
  let t1;
  let t2;
  if ($[0] !== onSkip || $[1] !== skip) {
    t1 = () => {
      if (skip) {
        onSkip();
      }
    };
    t2 = [skip, onSkip];
    $[0] = onSkip;
    $[1] = skip;
    $[2] = t1;
    $[3] = t2;
  } else {
    t1 = $[2];
    t2 = $[3];
  }
  useEffect(t1, t2);
  if (skip) {
    return null;
  }
  return children;
}
