// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';
import { BackgroundTasksDialog } from '../../tui/components/tasks/BackgroundTasksDialog.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <BackgroundTasksDialog toolUseContext={context} onDone={onDone} />;
}
