// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { collectDiffSnapshot } from '../diff.js';
import { DiffMenuView } from '../diff-menu.js';

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const cwd = typeof context.cwd === 'string' ? context.cwd : process.cwd();
  const snapshot = await collectDiffSnapshot(cwd);
  return (
    <DiffMenuView
      snapshot={snapshot}
      onDone={() => onDone(undefined, { display: 'skip' })}
    />
  );
};
