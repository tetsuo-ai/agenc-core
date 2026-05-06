import * as React from 'react';
import { HooksConfigMenu } from '../../../../tui/components/hooks/HooksConfigMenu';
import { logEvent } from '../../services/analytics/index.js';
import { getTools } from '../../tools.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  logEvent('tengu_hooks_command', {});
  const appState = context.getAppState();
  const permissionContext = appState.toolPermissionContext;
  const toolNames = getTools(permissionContext).map(tool => tool.name);
  return <HooksConfigMenu toolNames={toolNames} onExit={onDone} />;
};
