import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { collectGitStatus, collectStatus } from '../status.js';
import {
  createStatusDashboardSnapshot,
  StatusDashboardView,
} from '../status-menu.js';

export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  const session = context.session;
  if (!session || typeof session !== 'object') {
    onDone('Session not initialised', { display: 'system' });
    return null;
  }
  const cwd = typeof context.cwd === 'string' ? context.cwd : process.cwd();
  const appState = typeof context.getAppState === 'function'
    ? context.getAppState()
    : undefined;
  const snapshot = createStatusDashboardSnapshot({
    lines: collectStatus(session as never, cwd),
    git: await collectGitStatus(cwd),
    appState,
  });
  return (
    <StatusDashboardView
      snapshot={snapshot}
      onDone={() => onDone(undefined, { display: 'skip' })}
    />
  );
}
