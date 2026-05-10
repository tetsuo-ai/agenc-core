// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandContext } from '../../commands.js';

import type { LocalJSXCommandOnDone } from '../../types/command.js';

// ---- donor-purge stubs ----
// These symbols used to come from modules deleted in the api.anthropic.com
// purge. They are stubbed here as no-ops so the surrounding moved-source
// code paths degrade silently. Real implementations land when AgenC ships
// the equivalent backend.
const BackgroundTasksDialog = (_props: unknown): null => null;
// ---- end donor-purge stubs ----
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <BackgroundTasksDialog toolUseContext={context} onDone={onDone} />;
}
