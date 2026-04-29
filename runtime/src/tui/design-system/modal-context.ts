import { createContext, type RefObject, useContext } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'

/**
 * Set by the dialog/overlay layout when rendering content inside a modal
 * slot — the absolute-positioned bottom-anchored pane for slash-command
 * dialogs and approval prompts. Consumers use this to:
 *
 * - Suppress top-level framing — `Pane` skips its full-terminal-width
 *   `Divider` (the modal layout already draws its own divider).
 * - Size paginated lists to the available rows — the modal's inner area
 *   is smaller than the terminal (rows minus transcript peek minus
 *   divider), so components that cap their visible option count from
 *   `useTerminalSize().rows` would overflow without this context.
 * - Reset scroll on tab switch — `Tabs` keys its ScrollBox by
 *   `selectedTabIndex`, remounting on tab switch so scrollTop resets to
 *   0 without scrollTo() timing games.
 *
 * `null` = not inside a modal slot.
 */
type ModalCtx = {
  rows: number
  columns: number
  scrollRef: RefObject<ScrollBoxHandle | null> | null
}

export const ModalContext = createContext<ModalCtx | null>(null)

export function useIsInsideModal(): boolean {
  return useContext(ModalContext) !== null
}

export function useModalContext(): ModalCtx | null {
  return useContext(ModalContext)
}
