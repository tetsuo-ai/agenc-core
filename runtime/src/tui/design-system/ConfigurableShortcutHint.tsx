import React from 'react'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { KeyboardShortcutHint } from './KeyboardShortcutHint.js'

type Props = {
  /** Action name. Either an openclaude `BindingCommand` literal (e.g.
   *  `'history:search'`) or an upstream-style label whose AgenC equivalent
   *  is unknown — in which case `fallback` is used. */
  action: string
  /** Keybinding context. Accepts both AgenC casing (`'global'`) and
   *  upstream casing (`'Global'`). */
  context: string
  /** Default shortcut display text if the action is not bound. */
  fallback: string
  /** Action description text shown after the shortcut (e.g. `'expand'`). */
  description: string
  /** Whether to wrap in parentheses. */
  parens?: boolean
  /** Whether to render the shortcut in bold. */
  bold?: boolean
}

/**
 * `KeyboardShortcutHint` variant that resolves the displayed shortcut by
 * looking up the configured key binding. Falls back to the literal
 * `fallback` prop when the action isn't bound in the registry.
 *
 * @example
 * <ConfigurableShortcutHint
 *   action="app:toggleTranscript"
 *   context="Global"
 *   fallback="ctrl+o"
 *   description="expand"
 * />
 */
export function ConfigurableShortcutHint({
  action,
  context,
  fallback,
  description,
  parens,
  bold,
}: Props): React.ReactElement {
  const shortcut = getShortcutDisplay(action, context, fallback)
  return (
    <KeyboardShortcutHint
      shortcut={shortcut}
      action={description}
      parens={parens}
      bold={bold}
    />
  )
}
