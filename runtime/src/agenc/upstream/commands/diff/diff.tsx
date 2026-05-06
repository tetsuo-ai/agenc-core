import * as React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const {
    DiffDialog
  } = await import('../../../../tui/components/diff/DiffDialog');
  return <DiffDialog messages={context.messages} onDone={onDone} />;
};
