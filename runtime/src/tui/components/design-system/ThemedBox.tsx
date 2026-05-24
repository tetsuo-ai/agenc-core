// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import React, { type PropsWithChildren } from 'react';
import Box from '../../ink/components/Box.js';
import type { DOMElement } from '../../ink/dom.js';
import type { ClickEvent } from '../../ink/events/click-event.js';
import type { FocusEvent } from '../../ink/events/focus-event.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import type { Styles } from '../../ink/styles.js';
import { getTheme } from '../../../utils/theme.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { useTheme } from './ThemeProvider.js';
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
function ThemedBoxInner(
  {
    borderColor,
    borderTopColor,
    borderBottomColor,
    borderLeftColor,
    borderRightColor,
    backgroundColor,
    children,
    ...rest
  }: PropsWithChildren<Props>,
  ref: React.ForwardedRef<DOMElement>,
): React.ReactElement {
  const [themeName] = useTheme();
  const theme = getTheme(themeName);

  return (
    <Box
      ref={ref}
      borderColor={resolveThemedColor(borderColor, theme)}
      borderTopColor={resolveThemedColor(borderTopColor, theme)}
      borderBottomColor={resolveThemedColor(borderBottomColor, theme)}
      borderLeftColor={resolveThemedColor(borderLeftColor, theme)}
      borderRightColor={resolveThemedColor(borderRightColor, theme)}
      backgroundColor={resolveThemedColor(backgroundColor, theme)}
      {...rest}
    >
      {children}
    </Box>
  );
}
const ThemedBox = React.forwardRef<DOMElement, PropsWithChildren<Props>>(ThemedBoxInner);
ThemedBox.displayName = 'ThemedBox';
export default ThemedBox;
