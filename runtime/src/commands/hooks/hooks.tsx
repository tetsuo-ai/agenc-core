// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import { HooksRuntimeUnavailableModal } from '../hooks-menu.js';
import { logEvent } from '../../services/analytics/index.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  logEvent('tengu_hooks_command', {});
  return <HooksRuntimeUnavailableModal onDone={onDone} />;
};
