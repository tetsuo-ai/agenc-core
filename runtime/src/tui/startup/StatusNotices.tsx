import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js';
import { getGlobalConfig } from '../../utils/config.js';
import { buildMemoryDiagnostics } from '../../utils/status.js';
import { Box } from '../ink.js';
import { getActiveNotices, type StatusNoticeContext } from './statusNoticeDefinitions.js';
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
  }).finally(() => {
    memoryDiagnosticsPromise = null;
  });
  return memoryDiagnosticsPromise;
}

function isDaemonAutostartDisabled(): boolean {
  const value = process.env.AGENC_DAEMON_AUTOSTART?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off';
}

/**
 * StatusNotices contains the information displayed to users at startup. We have
 * moved neutral or positive status to the /status surface instead.
 */
export function StatusNotices(t0: Props = {}) {
  const $ = _c(8);
  const {
    agentDefinitions
  } = t0 === undefined ? {} : t0;
  const [memoryDiagnostics, setMemoryDiagnostics] = React.useState(cachedMemoryDiagnostics);
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = () => {
      if (cachedMemoryDiagnostics.length > 0) {
        setMemoryDiagnostics(cachedMemoryDiagnostics);
        return;
      }
      void loadMemoryDiagnostics().then(() => {
        setMemoryDiagnostics(cachedMemoryDiagnostics);
      });
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  React.useEffect(t1, [t1]);
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
  const T0 = Box;
  const t3 = "column";
  const t4 = 1;
  const t5 = activeNotices.map(notice => <React.Fragment key={notice.id}>{notice.render(context)}</React.Fragment>);
  let t6;
  if ($[1] !== T0 || $[2] !== t5) {
    t6 = <T0 flexDirection={t3} paddingLeft={t4}>{t5}</T0>;
    $[1] = T0;
    $[2] = t5;
    $[3] = t6;
  } else {
    t6 = $[3];
  }
  return t6;
}
