/**
 * CtrlOToExpand
 *
 * Ported from upstream. Renders the "(ctrl+o to expand)" hint that
 * appears under collapsed transcript regions. The widget can be
 * suppressed inside subagent output (avoids hint spam in nested calls)
 * via the optional `inSubAgent` prop, mirroring the upstream context
 * stack.
 *
 * The shortcut display is read from AgenC's keybinding service when the
 * caller does not pass an explicit `shortcut` — `app:toggleTranscript`
 * is the corresponding binding.
 */

import React, { createContext, useContext } from 'react'

import { Text } from '../ink-public.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { getDisplayForCommand } from '../keybindings/shortcutFormat.js'

const SubAgentContext = createContext(false)

export interface SubAgentProviderProps {
  readonly children: React.ReactNode
}

export function SubAgentProvider({
  children,
}: SubAgentProviderProps): React.ReactElement {
  return (
    <SubAgentContext.Provider value={true}>{children}</SubAgentContext.Provider>
  )
}

export interface CtrlOToExpandProps {
  /**
   * Override the resolved shortcut display string. When unset, the
   * widget reads `app:toggleTranscript` from `getDisplayForCommand` and
   * falls back to `ctrl+o`.
   */
  readonly shortcut?: string
  /**
   * Suppress the hint when the widget is rendering inside a virtual
   * scroll list region. The transcript view already provides scroll
   * affordances, so the hint would be redundant.
   */
  readonly inVirtualList?: boolean
  /**
   * When `true`, suppresses the hint outright. Useful for callers that
   * want to bypass the SubAgent context but still hide the hint.
   */
  readonly hidden?: boolean
}

function resolveShortcut(override: string | undefined): string {
  if (override && override.trim().length > 0) return override
  const display = getDisplayForCommand('app:toggleTranscript', 'global')
  if (display && display.trim().length > 0) return display
  return 'ctrl+o'
}

export function CtrlOToExpand({
  shortcut,
  inVirtualList = false,
  hidden = false,
}: CtrlOToExpandProps): React.ReactElement | null {
  const isInSubAgent = useContext(SubAgentContext)
  if (hidden || isInSubAgent || inVirtualList) {
    return null
  }
  const display = resolveShortcut(shortcut)
  return (
    <Text dimColor={true}>
      <KeyboardShortcutHint
        shortcut={display}
        action="expand"
        parens={true}
      />
    </Text>
  )
}

/**
 * Plain-string variant useful for non-React surfaces (e.g. status-line
 * formatters). Returns the display in dimmed parens form.
 */
export function ctrlOToExpand(shortcut?: string): string {
  return `(${resolveShortcut(shortcut)} to expand)`
}

export default CtrlOToExpand
