import React from 'react'
import Box from '../ink/components/Box.js'
import type { Theme } from '../theme.js'
import { Divider } from './Divider.js'
import { useIsInsideModal } from './modal-context.js'

type PaneProps = {
  children: React.ReactNode
  /**
   * Theme color key for the top border line.
   */
  color?: keyof Theme['colors']
}

/**
 * A pane — a region of the terminal that appears below the composer,
 * bounded by a colored top line with a one-row gap above and horizontal
 * padding. Used by all slash-command screens: /config, /help, /permissions,
 * etc.
 *
 * For confirm/cancel dialogs (Esc to dismiss, Enter to confirm), use
 * `<Dialog>` instead — it registers its own keybindings.
 *
 * Submenus rendered inside a Pane should use `hideBorder` on their Dialog
 * so the Pane's border remains the single frame.
 *
 * @example
 * <Pane color="accent">
 *   <Tabs title="Sandbox:">…</Tabs>
 * </Pane>
 */
export function Pane({ children, color }: PaneProps) {
  if (useIsInsideModal()) {
    return (
      <Box flexDirection="column" paddingX={1} flexShrink={0}>
        {children}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color={color} />
      <Box flexDirection="column" paddingX={2}>
        {children}
      </Box>
    </Box>
  )
}
