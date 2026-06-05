// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js';
import { getGlobalConfig } from '../../utils/config.js';
import { logError } from '../../utils/log.js';
import { buildMemoryDiagnostics } from '../../utils/status.js';
import { Box } from '../ink.js';
import ThemedBox from '../components/design-system/ThemedBox.js';
import ThemedText from '../components/design-system/ThemedText.js';
import { getActiveNotices, type StatusNoticeContext, type StatusNoticeDefinition, type StatusNoticeType } from './statusNoticeDefinitions.js';
type Props = {
  agentDefinitions?: AgentDefinitionsResult;
};

let cachedMemoryDiagnostics: string[] = [];
let memoryDiagnosticsPromise: Promise<void> | null = null;

async function loadMemoryDiagnostics(): Promise<void> {
  if (memoryDiagnosticsPromise) {
    return memoryDiagnosticsPromise;
  }
  memoryDiagnosticsPromise = buildMemoryDiagnostics().then(diagnostics => {
    cachedMemoryDiagnostics = diagnostics.map(diagnostic => String(diagnostic));
  }).catch(error => {
    logError(error);
    cachedMemoryDiagnostics = [];
  }).finally(() => {
    memoryDiagnosticsPromise = null;
  });
  return memoryDiagnosticsPromise;
}

function isDaemonAutostartDisabled(): boolean {
  const value = process.env.AGENC_DAEMON_AUTOSTART?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

const noticeChrome: Record<StatusNoticeType, {
  readonly backgroundColor: 'agencWash' | 'workerWash' | 'successWash' | 'errorWash';
  readonly color: 'agenc' | 'worker';
  readonly glyph: string;
}> = {
  warning: {
    backgroundColor: 'workerWash',
    color: 'worker',
    glyph: '⚠',
  },
  error: {
    backgroundColor: 'errorWash',
    color: 'agenc',
    glyph: '✕',
  },
  success: {
    backgroundColor: 'successWash',
    color: 'agenc',
    glyph: '●',
  },
  info: {
    backgroundColor: 'agencWash',
    color: 'agenc',
    glyph: '◇',
  },
};

function NoticeBody({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  if (typeof children === 'string' || typeof children === 'number') {
    return (
      <ThemedText color="text2" wrap="wrap">
        {children}
      </ThemedText>
    );
  }
  return <Box flexDirection="row" flexWrap="wrap">{children}</Box>;
}

function NoticeRow({
  context,
  notice,
}: {
  readonly context: StatusNoticeContext;
  readonly notice: StatusNoticeDefinition;
}): React.ReactNode {
  const chrome = noticeChrome[notice.type];
  return (
    <ThemedBox
      key={notice.id}
      flexDirection="row"
      width="100%"
      backgroundColor={chrome.backgroundColor}
      paddingX={1}
    >
      <ThemedText color={chrome.color}>{chrome.glyph}</ThemedText>
      <ThemedText color="muted3"> </ThemedText>
      <Box flexDirection="row" flexShrink={1} flexWrap="wrap">
        <NoticeBody>{notice.render(context)}</NoticeBody>
      </Box>
    </ThemedBox>
  );
}

/**
 * StatusNotices contains the information displayed to users at startup. We have
 * moved neutral or positive status to the /status surface instead.
 */
export function StatusNotices(t0: Props = {}) {
  const {
    agentDefinitions
  } = t0 === undefined ? {} : t0;
  const [memoryDiagnostics, setMemoryDiagnostics] = React.useState(cachedMemoryDiagnostics);
  React.useEffect(() => {
    if (cachedMemoryDiagnostics.length > 0) {
      setMemoryDiagnostics(cachedMemoryDiagnostics);
      return;
    }
    void loadMemoryDiagnostics().then(() => {
      setMemoryDiagnostics(cachedMemoryDiagnostics);
    });
  }, []);
  const t2 = getGlobalConfig();
  const context = {
    config: t2,
    agentDefinitions,
    memoryDiagnostics,
    daemonStatus: {
      autostartDisabled: isDaemonAutostartDisabled()
    }
  };
  const activeNotices = getActiveNotices(context);
  if (activeNotices.length === 0) {
    return null;
  }
  return (
    <Box flexDirection="column" gap={1} width="100%">
      {activeNotices.map(notice => (
        <NoticeRow key={notice.id} context={context} notice={notice} />
      ))}
    </Box>
  );
}
