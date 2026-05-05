import { useKeybindings } from '../../../tui/keybindings/useKeybinding.js'
import { type ExitState as BaseExitState, useExitOnCtrlCD } from './useExitOnCtrlCD.js'

export type ExitState = BaseExitState

/**
 * Convenience hook that wires up useExitOnCtrlCD with useKeybindings.
 *
 * This is the standard way to use useExitOnCtrlCD in components.
 * The separation exists to avoid import cycles - useExitOnCtrlCD.ts
 * doesn't import from the keybindings module directly.
 *
 * @param onExit - Optional custom exit handler
 * @param onInterrupt - Optional callback for features to handle interrupt (ctrl+c).
 *                      Return true if handled, false to fall through to double-press exit.
 * @param isActive - Whether the keybinding is active (default true).
 */
export function useExitOnCtrlCDWithKeybindings(
  onExit?: () => void,
  onInterrupt?: () => boolean,
  isActive?: boolean,
): ExitState {
  const keybindings = useKeybindings
  return useExitOnCtrlCD(keybindings, onInterrupt, onExit, isActive)
}
