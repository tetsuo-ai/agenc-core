// @ts-nocheck
// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.
import * as React from 'react';
import { PermissionRuleList } from '../../tui/components/permissions/rules/PermissionRuleList.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { createPermissionRetryMessage } from '../../utils/messages.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <PermissionRuleList onExit={onDone} onRetryDenials={commands => {
    context.setMessages(prev => [...prev, createPermissionRetryMessage(commands)]);
  }} />;
};
