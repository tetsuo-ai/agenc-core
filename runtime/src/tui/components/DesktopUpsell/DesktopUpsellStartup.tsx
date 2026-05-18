import { type ReactNode, useEffect, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js';
import { logEvent } from '../../../services/analytics/index.js';
import {
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '../../../utils/config.js';
import { Select } from '../CustomSelect/select.js';
import { DesktopHandoff } from '../DesktopHandoff.js';
import { PermissionDialog } from '../v2/permissionPrimitives.js';

type DesktopUpsellConfig = {
  enable_shortcut_tip: boolean;
  enable_startup_dialog: boolean;
};

const DESKTOP_UPSELL_DEFAULT: DesktopUpsellConfig = {
  enable_shortcut_tip: false,
  enable_startup_dialog: false,
};

const DESKTOP_UPSELL_CONFIG_NAME = 'agenc_desktop_upsell';
const DESKTOP_UPSELL_SHOWN_EVENT = 'agenc_desktop_upsell_shown';
const MAX_DESKTOP_UPSELL_IMPRESSIONS = 3;

export function getDesktopUpsellConfig(): DesktopUpsellConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<DesktopUpsellConfig>(
    DESKTOP_UPSELL_CONFIG_NAME,
    DESKTOP_UPSELL_DEFAULT,
  );
}

function isSupportedPlatform(): boolean {
  return process.platform === 'darwin'
    || (process.platform === 'win32' && process.arch === 'x64');
}

export function shouldShowDesktopUpsellStartup(): boolean {
  if (!isSupportedPlatform()) return false;
  if (!getDesktopUpsellConfig().enable_startup_dialog) return false;

  const config = getGlobalConfig();
  if (config.desktopUpsellDismissed) return false;
  return (config.desktopUpsellSeenCount ?? 0) < MAX_DESKTOP_UPSELL_IMPRESSIONS;
}

type DesktopUpsellSelection = 'try' | 'not-now' | 'never';

type Props = {
  onDone: () => void;
};

const desktopUpsellOptions = [
  {
    label: 'Open in AgenC desktop app',
    value: 'try',
  },
  {
    label: 'Not now',
    value: 'not-now',
  },
  {
    label: "Don't ask again",
    value: 'never',
  },
] satisfies Array<{ label: string; value: DesktopUpsellSelection }>;

export function DesktopUpsellStartup({ onDone }: Props): ReactNode {
  const [showHandoff, setShowHandoff] = useState(false);

  useEffect(() => {
    recordDesktopUpsellShown();
  }, []);

  if (showHandoff) {
    return <DesktopHandoff onDone={onDone} />;
  }

  const handleSelect = (value: DesktopUpsellSelection) => {
    switch (value) {
      case 'try':
        setShowHandoff(true);
        return;
      case 'never':
        saveGlobalConfig(markDesktopUpsellDismissed);
        onDone();
        return;
      case 'not-now':
        onDone();
        return;
    }
  };

  return (
    <PermissionDialog title="Try the AgenC desktop app">
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text>
            Use AgenC in the AgenC desktop app for visual diffs, live app
            preview, parallel sessions, and more.
          </Text>
        </Box>
        <Select
          options={desktopUpsellOptions}
          onChange={handleSelect}
          onCancel={() => handleSelect('not-now')}
        />
      </Box>
    </PermissionDialog>
  );
}

function markDesktopUpsellDismissed(prev: GlobalConfig): GlobalConfig {
  if (prev.desktopUpsellDismissed) {
    return prev;
  }

  return {
    ...prev,
    desktopUpsellDismissed: true,
  };
}

function recordDesktopUpsellShown(): void {
  const newCount = (getGlobalConfig().desktopUpsellSeenCount ?? 0) + 1;

  saveGlobalConfig(prev => {
    if ((prev.desktopUpsellSeenCount ?? 0) >= newCount) {
      return prev;
    }

    return {
      ...prev,
      desktopUpsellSeenCount: newCount,
    };
  });

  logEvent(DESKTOP_UPSELL_SHOWN_EVENT, {
    seen_count: newCount,
  });
}
