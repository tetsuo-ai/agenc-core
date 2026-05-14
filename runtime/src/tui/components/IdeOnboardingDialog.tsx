import { type ReactNode, useEffect, useMemo } from 'react';
import { envDynamic } from '../../utils/envDynamic.js';
import { Box, Text } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import {
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../utils/config.js';
import { env } from '../../utils/env.js';
import {
  getTerminalIdeType,
  type IDEExtensionInstallationStatus,
  isJetBrainsIde,
  toIDEDisplayName,
} from '../../utils/ide.js';
import { selectAgenCTuiGlyphs } from '../glyphs.js';
import { Dialog } from './design-system/Dialog.js';

interface Props {
  onDone: () => void;
  installationStatus: IDEExtensionInstallationStatus | null;
}

export function IdeOnboardingDialog({
  onDone,
  installationStatus,
}: Props): ReactNode {
  useEffect(() => {
    markDialogAsShown();
  }, []);

  const confirmationHandlers = useMemo(
    () => ({
      'confirm:yes': onDone,
      'confirm:no': onDone,
    }),
    [onDone],
  );

  useKeybindings(confirmationHandlers, { context: 'Confirmation' });

  const ideType = installationStatus?.ideType ?? getTerminalIdeType();
  const isJetBrains = isJetBrainsIde(ideType);
  const ideName = toIDEDisplayName(ideType);
  const installedVersion = installationStatus?.installedVersion;
  const pluginOrExtension = isJetBrains ? 'plugin' : 'extension';
  const subtitle = installedVersion
    ? `installed ${pluginOrExtension} v${installedVersion}`
    : undefined;
  const mentionShortcut = env.platform === 'darwin'
    ? 'Cmd+Option+K'
    : 'Ctrl+Alt+K';
  const glyphs = selectAgenCTuiGlyphs();
  const titlePrefix = glyphs.titleStaticPrefix
    ? `${glyphs.titleStaticPrefix} `
    : '';
  const bullet = glyphs.statusDot;

  return (
    <>
      <Dialog
        title={(
          <>
            <Text color="cyan_FOR_SUBAGENTS_ONLY">{titlePrefix}</Text>
            <Text>Welcome to AgenC for {ideName}</Text>
          </>
        )}
        subtitle={subtitle}
        color="ide"
        onCancel={onDone}
        hideInputGuide
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            {bullet} AgenC has context of{' '}
            <Text color="suggestion">open files</Text>
            {' '}and <Text color="suggestion">selected lines</Text>
          </Text>
          <Text>
            {bullet} Review AgenC&apos;s changes{' '}
            <Text color="diffAddedWord">+11</Text>
            {' '}
            <Text color="diffRemovedWord">-22</Text>
            {' '}in the comfort of your IDE
          </Text>
          <Text>
            {bullet} Cmd+Esc
            <Text dimColor> for Quick Launch</Text>
          </Text>
          <Text>
            {bullet} {mentionShortcut}
            <Text dimColor> to reference files or lines in your input</Text>
          </Text>
        </Box>
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor italic>
          Press Enter to continue
        </Text>
      </Box>
    </>
  );
}

export function hasIdeOnboardingDialogBeenShown(): boolean {
  const config = getGlobalConfig();
  const terminal = getIdeOnboardingTerminalKey();
  return config.hasIdeOnboardingBeenShown?.[terminal] === true;
}

function markDialogAsShown(): void {
  const terminal = getIdeOnboardingTerminalKey();

  saveGlobalConfig((current: GlobalConfig) => {
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
