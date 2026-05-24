// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { c as _c } from "react-compiler-runtime";
import React, { type PropsWithChildren } from 'react';
import Box from '../../ink/components/Box.js';
import type { DOMElement } from '../../ink/dom.js';
import type { ClickEvent } from '../../ink/events/click-event.js';
import type { FocusEvent } from '../../ink/events/focus-event.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import type { Styles } from '../../ink/styles.js';
import { getTheme } from '../../../utils/theme.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { useTheme } from './ThemeProvider';
import { resolveThemedColor, type ThemedColor } from './resolveThemedColor.js';

// Color props that accept theme keys
type ThemedColorProps = {
  readonly borderColor?: ThemedColor;
  readonly borderTopColor?: ThemedColor;
  readonly borderBottomColor?: ThemedColor;
  readonly borderLeftColor?: ThemedColor;
  readonly borderRightColor?: ThemedColor;
  readonly backgroundColor?: ThemedColor;
};

// Base Styles without color props (they'll be overridden)
type BaseStylesWithoutColors = Omit<Styles, 'textWrap' | 'borderColor' | 'borderTopColor' | 'borderBottomColor' | 'borderLeftColor' | 'borderRightColor' | 'backgroundColor'>;
export type Props = BaseStylesWithoutColors & ThemedColorProps & {
  tabIndex?: number;
  autoFocus?: boolean;
  onClick?: (event: ClickEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onFocusCapture?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onBlurCapture?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onKeyDownCapture?: (event: KeyboardEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

/**
 * Theme-aware Box component that resolves theme color keys to raw colors.
 * This wraps the base Box component with theme resolution for border colors.
 */
function ThemedBoxInner(t0, ref: React.ForwardedRef<DOMElement>) {
  const $ = _c(33);
  let backgroundColor;
  let borderBottomColor;
  let borderColor;
  let borderLeftColor;
  let borderRightColor;
  let borderTopColor;
  let children;
  let rest;
  if ($[0] !== t0) {
    ({
      borderColor,
      borderTopColor,
      borderBottomColor,
      borderLeftColor,
      borderRightColor,
      backgroundColor,
      children,
      ...rest
    } = t0);
    $[0] = t0;
    $[1] = backgroundColor;
    $[2] = borderBottomColor;
    $[3] = borderColor;
    $[4] = borderLeftColor;
    $[5] = borderRightColor;
    $[6] = borderTopColor;
    $[7] = children;
    $[8] = rest;
  } else {
    backgroundColor = $[1];
    borderBottomColor = $[2];
    borderColor = $[3];
    borderLeftColor = $[4];
    borderRightColor = $[5];
    borderTopColor = $[6];
    children = $[7];
    rest = $[8];
  }
  const [themeName] = useTheme();
  let resolvedBorderBottomColor;
  let resolvedBorderColor;
  let resolvedBorderLeftColor;
  let resolvedBorderRightColor;
  let resolvedBorderTopColor;
  let t1;
  if ($[10] !== backgroundColor || $[11] !== borderBottomColor || $[12] !== borderColor || $[13] !== borderLeftColor || $[14] !== borderRightColor || $[15] !== borderTopColor || $[16] !== themeName) {
    const theme = getTheme(themeName);
    resolvedBorderColor = resolveThemedColor(borderColor, theme);
    resolvedBorderTopColor = resolveThemedColor(borderTopColor, theme);
    resolvedBorderBottomColor = resolveThemedColor(borderBottomColor, theme);
    resolvedBorderLeftColor = resolveThemedColor(borderLeftColor, theme);
    resolvedBorderRightColor = resolveThemedColor(borderRightColor, theme);
    t1 = resolveThemedColor(backgroundColor, theme);
    $[10] = backgroundColor;
    $[11] = borderBottomColor;
    $[12] = borderColor;
    $[13] = borderLeftColor;
    $[14] = borderRightColor;
    $[15] = borderTopColor;
    $[16] = themeName;
    $[17] = resolvedBorderBottomColor;
    $[18] = resolvedBorderColor;
    $[19] = resolvedBorderLeftColor;
    $[20] = resolvedBorderRightColor;
    $[21] = resolvedBorderTopColor;
    $[22] = t1;
  } else {
    resolvedBorderBottomColor = $[17];
    resolvedBorderColor = $[18];
    resolvedBorderLeftColor = $[19];
    resolvedBorderRightColor = $[20];
    resolvedBorderTopColor = $[21];
    t1 = $[22];
  }
  const resolvedBackgroundColor = t1;
  let t2;
  if ($[23] !== children || $[24] !== ref || $[25] !== resolvedBackgroundColor || $[26] !== resolvedBorderBottomColor || $[27] !== resolvedBorderColor || $[28] !== resolvedBorderLeftColor || $[29] !== resolvedBorderRightColor || $[30] !== resolvedBorderTopColor || $[31] !== rest) {
    t2 = <Box ref={ref} borderColor={resolvedBorderColor} borderTopColor={resolvedBorderTopColor} borderBottomColor={resolvedBorderBottomColor} borderLeftColor={resolvedBorderLeftColor} borderRightColor={resolvedBorderRightColor} backgroundColor={resolvedBackgroundColor} {...rest}>{children}</Box>;
    $[23] = children;
    $[24] = ref;
    $[25] = resolvedBackgroundColor;
    $[26] = resolvedBorderBottomColor;
    $[27] = resolvedBorderColor;
    $[28] = resolvedBorderLeftColor;
    $[29] = resolvedBorderRightColor;
    $[30] = resolvedBorderTopColor;
    $[31] = rest;
    $[32] = t2;
  } else {
    t2 = $[32];
  }
  return t2;
}
const ThemedBox = React.forwardRef<DOMElement, PropsWithChildren<Props>>(ThemedBoxInner);
ThemedBox.displayName = 'ThemedBox';
export default ThemedBox;
