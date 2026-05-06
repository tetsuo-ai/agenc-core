import * as React from 'react';
import { AgentsMenu } from '../../tui/components/agents/AgentsMenu.js';
import type { ToolUseContext } from '../../tools/Tool.js';
import { getTools } from '../../tools.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext): Promise<React.ReactNode> {
  const appState = context.getAppState();
  const permissionContext = appState.toolPermissionContext;
  const tools = getTools(permissionContext);
  return <AgentsMenu tools={tools} onExit={onDone} />;
}
