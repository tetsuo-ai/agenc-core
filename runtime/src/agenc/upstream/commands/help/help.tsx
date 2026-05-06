import * as React from 'react';
import { HelpV2 } from '../../../../tui/components/HelpV2/HelpV2';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, {
  options: {
    commands
  }
}) => {
  return <HelpV2 commands={commands} onClose={onDone} />;
};
