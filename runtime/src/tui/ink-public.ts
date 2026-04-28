/**
 * AgenC public Ink barrel.
 *
 * Mirrors openclaude's `src/ink.ts` shape so consumers (design-system
 * widgets, message renderers, dialogs ported from openclaude) can write
 * `import { Box, Text, useTheme } from '../ink-public.js'` and get the
 * theme-aware Box/Text plus the public Ink API in one place.
 *
 * - `Box` / `Text` are the **theme-aware** wrappers from
 *   `design-system/ThemedBox` and `design-system/ThemedText`. They accept
 *   AgenC theme color keys (`'primary'`, `'accent'`, `'error'`, …) as
 *   well as raw color literals.
 * - `BaseBox` / `BaseText` are the **raw Ink primitives** from
 *   `ink/components/Box` and `ink/components/Text`. Use these when you
 *   need to bypass the theme key resolution.
 *
 * Named `ink-public.ts` (not `ink.ts`) to avoid collision with the
 * existing `tui/ink/` directory.
 */

export { color } from './design-system/color.js'
export type { Props as BoxProps } from './design-system/ThemedBox.js'
export { default as Box } from './design-system/ThemedBox.js'
export type { Props as TextProps } from './design-system/ThemedText.js'
export { default as Text } from './design-system/ThemedText.js'
export { ThemeProvider, useTheme } from './design-system/ThemeProvider.js'

export { Ansi } from './ink/Ansi.js'
export type { Props as BaseBoxProps } from './ink/components/Box.js'
export { default as BaseBox } from './ink/components/Box.js'
export type {
  ButtonState,
  Props as ButtonProps,
} from './ink/components/Button.js'
export { default as Button } from './ink/components/Button.js'
export type { Props as LinkProps } from './ink/components/Link.js'
export { default as Link } from './ink/components/Link.js'
export type { Props as NewlineProps } from './ink/components/Newline.js'
export { default as Newline } from './ink/components/Newline.js'
export { NoSelect } from './ink/components/NoSelect.js'
export { RawAnsi } from './ink/components/RawAnsi.js'
export { default as Spacer } from './ink/components/Spacer.js'
export type { Props as BaseTextProps } from './ink/components/Text.js'
export { default as BaseText } from './ink/components/Text.js'
export type { DOMElement } from './ink/dom.js'
export { ClickEvent } from './ink/events/click-event.js'
export { EventEmitter } from './ink/events/emitter.js'
export { Event } from './ink/events/event.js'
export type { Key } from './ink/events/input-event.js'
export { InputEvent } from './ink/events/input-event.js'
export type { TerminalFocusEventType } from './ink/events/terminal-focus-event.js'
export { TerminalFocusEvent } from './ink/events/terminal-focus-event.js'
export { FocusManager } from './ink/focus.js'
export type { FlickerReason } from './ink/frame.js'

export { useAnimationFrame } from './ink/hooks/use-animation-frame.js'
export { default as useApp } from './ink/hooks/use-app.js'
export { default as useInput } from './ink/hooks/use-input.js'
export { useAnimationTimer, useInterval } from './ink/hooks/use-interval.js'
export { useSelection, useHasSelection } from './ink/hooks/use-selection.js'
export { default as useStdin } from './ink/hooks/use-stdin.js'
export { useTabStatus } from './ink/hooks/use-tab-status.js'
export { useTerminalFocus } from './ink/hooks/use-terminal-focus.js'
export { useTerminalTitle } from './ink/hooks/use-terminal-title.js'
export { useTerminalViewport } from './ink/hooks/use-terminal-viewport.js'
export { useSearchHighlight } from './ink/hooks/use-search-highlight.js'
export { default as measureElement } from './ink/measure-element.js'
export { supportsTabStatus } from './ink/termio/osc.js'
export { default as wrapText } from './ink/wrap-text.js'
