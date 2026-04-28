/**
 * Multi-handler convenience wrapper around `useKeybinding`.
 *
 * Registers a map of `{ command: handler }` entries against a single
 * binding context. Hook calls happen at top-level for every registered
 * command (one `useKeybinding` per entry), so the handler map MUST have
 * a stable set of keys (in a stable order) for the lifetime of the
 * component — varying the map's key set across renders would violate
 * the Rules of Hooks.
 *
 * When `options.isActive === false` the registered handlers are wrapped
 * in a no-op so keypresses are silently absorbed but do not run any
 * action. This is used to suspend dialog-level shortcuts while an
 * embedded text field is focused.
 */
import type {
  BindingCommand,
  BindingContext,
} from './defaultBindings.js'
import { useKeybinding } from './KeybindingContext.js'

type Handlers = Partial<Record<BindingCommand, () => void>>

type Options = {
  /** Binding context the handlers should register against. Default `'chat'`. */
  context?: BindingContext
  /** When false, the handlers do not invoke their underlying callback. */
  isActive?: boolean
}

/**
 * Register multiple keybinding handlers in one call.
 *
 * @example
 * useKeybindings(
 *   {
 *     'modal:confirm': onConfirm,
 *     'modal:cancel': onCancel,
 *   },
 *   { context: 'modal' },
 * )
 */
export function useKeybindings(handlers: Handlers, options?: Options): void {
  const context: BindingContext = options?.context ?? 'chat'
  const isActive = options?.isActive ?? true

  // Iterate the handler map in a stable key order. Callers MUST keep the
  // same set of keys (and the same insertion order) across renders —
  // changing the keys between renders would violate the Rules of Hooks
  // because the per-key useKeybinding calls below are gated on those keys.
  for (const command of Object.keys(handlers) as BindingCommand[]) {
    const handler = handlers[command]
    const wrapped = () => {
      if (!isActive) return
      handler?.()
    }
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useKeybinding(command, wrapped, context)
  }
}
