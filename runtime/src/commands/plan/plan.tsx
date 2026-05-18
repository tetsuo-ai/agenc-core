// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import planCommand, {
  getPlan,
  getPlanFilePath,
  type PlanFileContext,
} from '../plan.js';
import {
  createPlanDashboardSnapshot,
  PlanDashboardView,
} from '../plan-menu.js';

function planFileContext(context: LocalJSXCommandContext): PlanFileContext {
  const session = context.session as { conversationId?: string } | undefined;
  return {
    ...(typeof context.agencHome === 'string' ? { agencHome: context.agencHome } : {}),
    ...(typeof context.home === 'string' ? { home: context.home } : {}),
    sessionId: session?.conversationId,
  };
}

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

  const appState = typeof context.getAppState === 'function'
    ? context.getAppState()
    : undefined;
  const currentMode = appState?.toolPermissionContext?.mode;
  const trimmed = args.trim();
  if (currentMode !== 'plan' || trimmed.length > 0) {
    const result = await planCommand.execute({
      session,
      argsRaw: args,
      cwd: typeof context.cwd === 'string' ? context.cwd : process.cwd(),
      home: typeof context.home === 'string' ? context.home : process.env.HOME ?? process.cwd(),
      ...(typeof context.agencHome === 'string' ? { agencHome: context.agencHome } : {}),
    });
    if (result.kind === 'text') onDone(result.text);
    else if (result.kind === 'error') onDone(result.message, { display: 'system' });
    else if (result.kind === 'prompt') onDone('Enabled plan mode', { shouldQuery: true });
    else onDone(undefined, { display: 'skip' });
    return null;
  }

  const fileCtx = planFileContext(context);
  const planText = getPlan(fileCtx);
  const snapshot = createPlanDashboardSnapshot({
    mode: 'plan',
    previousMode: appState?.toolPermissionContext?.prePlanMode,
    planPath: getPlanFilePath(fileCtx),
    planText,
  });
  return (
    <PlanDashboardView
      snapshot={snapshot}
      onDone={() => onDone(undefined, { display: 'skip' })}
    />
  );
}
