import * as React from 'react';
import { RemoteEnvironmentDialog } from '../../../../tui/components/RemoteEnvironmentDialog';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <RemoteEnvironmentDialog onDone={onDone} />;
}
