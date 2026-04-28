import React from 'react'
import {
  type ExitState,
  useExitOnCtrlCDWithKeybindings,
} from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink-public.js'
import { useKeybinding } from '../keybindings/KeybindingContext.js'
import type { Theme } from '../theme.js'
import { Byline } from './Byline.js'
import FullWidthRow from './FullWidthRow.js'
import { KeyboardShortcutHint } from './KeyboardShortcutHint.js'
import { Pane } from './Pane.js'

type DialogProps = {
  title: React.ReactNode
  subtitle?: React.ReactNode
  children: React.ReactNode
  onCancel: () => void
  color?: keyof Theme['colors']
  hideInputGuide?: boolean
  hideBorder?: boolean
  /** Custom input guide content. Receives exitState for Ctrl+C/D pending display. */
  inputGuide?: (exitState: ExitState) => React.ReactNode
  /**
   * Controls whether Dialog's built-in cancel (Esc) and app:exit/interrupt
   * (Ctrl-C/D) keybindings are active. Set to `false` while an embedded text
   * field is being edited so those keys reach the field instead of being
   * consumed by Dialog. Defaults to `true`.
   */
  isCancelActive?: boolean
}

export function Dialog({
  title,
  subtitle,
  children,
  onCancel,
  color = 'accent',
  hideInputGuide,
  hideBorder,
  inputGuide,
  isCancelActive = true,
}: DialogProps): React.ReactElement {
  const exitState = useExitOnCtrlCDWithKeybindings(
    undefined,
    undefined,
    isCancelActive,
  )

  // AgenC's `useKeybinding` doesn't accept an `isActive` flag, so wrap the
  // handler and gate on the prop directly.
  useKeybinding(
    'modal:cancel',
    () => {
      if (isCancelActive) onCancel()
    },
    'modal',
  )

  const defaultInputGuide = exitState.pending ? (
    <Text>Press {exitState.keyName} again to exit</Text>
  ) : (
    <Byline>
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <KeyboardShortcutHint shortcut="Esc" action="cancel" />
    </Byline>
  )

  const header = (
    <Box flexDirection="column">
      <Text bold={true} color={color}>
        {title}
      </Text>
      {subtitle && <Text dimColor={true}>{subtitle}</Text>}
    </Box>
  )

  const body = (
    <Box flexDirection="column" gap={1}>
      {header}
      {children}
    </Box>
  )

  const guide = !hideInputGuide && (
    <Box marginTop={1}>
      <FullWidthRow>
        <Text dimColor={true} italic={true}>
          {inputGuide ? inputGuide(exitState) : defaultInputGuide}
        </Text>
      </FullWidthRow>
    </Box>
  )

  const content = (
    <>
      {body}
      {guide}
    </>
  )

  if (hideBorder) {
    return content
  }

  return <Pane color={color}>{content}</Pane>
}
