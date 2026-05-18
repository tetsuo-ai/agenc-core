// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ContextUsageModal } from '../../tui/components/v2/ContextUsageModal.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import {
  buildFallbackContextUsageText,
  contextCommand,
} from '../session-compact.js';

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const session = context.session;
  if (!session || typeof session !== 'object') {
    onDone('Session not initialised', { display: 'system' });
    return null;
  }

  const result = await contextCommand.execute({
    session,
    argsRaw: args,
    cwd: typeof context.cwd === 'string' ? context.cwd : process.cwd(),
    home: typeof context.home === 'string' ? context.home : process.env.HOME ?? process.cwd(),
    ...(typeof context.agencHome === 'string' ? { agencHome: context.agencHome } : {}),
    appState: {
      getAppState: typeof context.getAppState === 'function'
        ? () => context.getAppState()
        : undefined,
    },
  });
  if (result.kind === 'text') {
    return (
      <ContextUsageModal
        text={result.text}
        onDone={() => onDone(undefined, { display: 'skip' })}
      />
    );
  }
  if (result.kind === 'error') {
    const text = await buildFallbackContextUsageText(
      {
        session,
        argsRaw: args,
        cwd: typeof context.cwd === 'string' ? context.cwd : process.cwd(),
        home: typeof context.home === 'string' ? context.home : process.env.HOME ?? process.cwd(),
      },
      result.message,
    );
    return (
      <ContextUsageModal
        text={text}
        onDone={() => onDone(undefined, { display: 'skip' })}
      />
    );
  }
  onDone(undefined, { display: 'skip' });
  return null;
}
