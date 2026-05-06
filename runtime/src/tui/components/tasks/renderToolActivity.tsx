import React from 'react';
import { Text } from '../../ink.js';
import type { Tools } from '../../../agenc/upstream/Tool'; // upstream-import: keep target is owned by another Z-PURGE item
import { findToolByName } from '../../../agenc/upstream/Tool'; // upstream-import: keep target is owned by another Z-PURGE item
import type { ToolActivity } from '../../../agenc/upstream/tasks/LocalAgentTask/LocalAgentTask'; // upstream-import: keep target is owned by another Z-PURGE item
import type { ThemeName } from '../../../utils/theme.js'; // upstream-import: keep target is owned by another Z-PURGE item
export function renderToolActivity(activity: ToolActivity, tools: Tools, theme: ThemeName): React.ReactNode {
  const tool = findToolByName(tools, activity.toolName);
  if (!tool) {
    return activity.toolName;
  }
  try {
    const parsed = tool.inputSchema.safeParse(activity.input);
    const parsedInput = parsed.success ? parsed.data : {};
    const userFacingName = tool.userFacingName(parsedInput);
    if (!userFacingName) {
      return activity.toolName;
    }
    const toolArgs = tool.renderToolUseMessage(parsedInput, {
      theme,
      verbose: false
    });
    if (toolArgs) {
      return <Text>
          {userFacingName}({toolArgs})
        </Text>;
    }
    return userFacingName;
  } catch {
    return activity.toolName;
  }
}
