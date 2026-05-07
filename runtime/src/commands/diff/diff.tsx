// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const {
    DiffDialog
  } = await import('../../tui/components/diff/DiffDialog.js');
  return <DiffDialog messages={context.messages} onDone={onDone} />;
};
