// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import { HelpV2 } from '../../tui/components/HelpV2/HelpV2.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, {
  options: {
    commands
  }
}) => {
  return <HelpV2 commands={commands} onClose={onDone} />;
};
