// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../../tools/AgentTool/agentColorManager.js';
import type { PromptInputMode } from '../../../types/textInputTypes.js';
import type { PermissionMode } from '../../../permissions/types.js';
import { getTeammateColor } from '../../../utils/teammate.js';
import type { Theme } from '../../../utils/theme.js';
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js';
import { promptGlyphForPermissionMode } from './permissionModeChrome.js';
type Props = {
  mode: PromptInputMode;
  permissionMode?: PermissionMode;
  isLoading: boolean;
  viewingAgentName?: string;
  viewingAgentColor?: AgentColorName;
};

/**
 * Gets the theme color key for the teammate's assigned color.
 * Returns undefined if not a teammate or if the color is invalid.
 */
function getTeammateThemeColor(): keyof Theme | undefined {
  if (!isAgentSwarmsEnabled()) {
    return undefined;
  }
  const colorName = getTeammateColor();
  if (!colorName) {
    return undefined;
  }
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}
type PromptCharProps = {
  isLoading: boolean;
  permissionMode?: PermissionMode;
  // Dead code elimination: parameter named themeColor to avoid "teammate" string in external builds
  themeColor?: keyof Theme;
};

/**
 * Renders the prompt character (❯).
 * Teammate color overrides the default color when set.
 */
function PromptChar(t0) {
  const $ = _c(4);
  const {
    isLoading,
    permissionMode,
    themeColor
  } = t0;
  const teammateColor = themeColor;
  const color = teammateColor ?? (false ? "subtle" : undefined);
  const glyph = promptGlyphForPermissionMode(permissionMode);
  let t1;
  if ($[0] !== color || $[1] !== isLoading || $[2] !== glyph) {
    t1 = <Text color={color} dimColor={isLoading}>{glyph} </Text>;
    $[0] = color;
    $[1] = isLoading;
    $[2] = glyph;
    $[3] = t1;
  } else {
    t1 = $[3];
  }
  return t1;
}
export function PromptInputModeIndicator(t0) {
  const $ = _c(7);
  const {
    mode,
    permissionMode,
    isLoading,
    viewingAgentName,
    viewingAgentColor
  } = t0;
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getTeammateThemeColor();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const teammateColor = t1;
  const viewedTeammateThemeColor = viewingAgentColor ? AGENT_COLOR_TO_THEME_COLOR[viewingAgentColor] : undefined;
  let t2;
  if ($[1] !== isLoading || $[2] !== mode || $[3] !== permissionMode || $[4] !== viewedTeammateThemeColor || $[5] !== viewingAgentName) {
    t2 = <Box alignItems="flex-start" alignSelf="flex-start" flexWrap="nowrap" justifyContent="flex-start">{viewingAgentName ? <PromptChar isLoading={isLoading} permissionMode={permissionMode} themeColor={viewedTeammateThemeColor} /> : mode === "bash" ? <Text color="bashBorder" dimColor={isLoading}>! </Text> : <PromptChar isLoading={isLoading} permissionMode={permissionMode} themeColor={isAgentSwarmsEnabled() ? teammateColor : undefined} />}</Box>;
    $[1] = isLoading;
    $[2] = mode;
    $[3] = permissionMode;
    $[4] = viewedTeammateThemeColor;
    $[5] = viewingAgentName;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  return t2;
}
