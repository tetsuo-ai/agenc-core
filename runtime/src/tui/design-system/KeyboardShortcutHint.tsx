import React from 'react'
import Text from '../ink/components/Text.js'

type Props = {
  /** The key or chord to display (e.g., "ctrl+o", "Enter", "↑/↓") */
  shortcut: string
  /** The action the key performs (e.g., "expand", "select", "navigate") */
  action: string
  /** Whether to wrap the hint in parentheses. Default: false */
  parens?: boolean
  /** Whether to render the shortcut in bold. Default: false */
  bold?: boolean
}

/**
 * Renders a keyboard shortcut hint like "ctrl+o to expand" or "(tab to toggle)".
 *
 * Wrap in `<ThemedText dimColor>` for the common dim styling.
 *
 * @example
 * // Simple hint wrapped in dim ThemedText
 * <ThemedText dimColor><KeyboardShortcutHint shortcut="esc" action="cancel" /></ThemedText>
 *
 * @example
 * // With parentheses: "(ctrl+o to expand)"
 * <ThemedText dimColor><KeyboardShortcutHint shortcut="ctrl+o" action="expand" parens /></ThemedText>
 *
 * @example
 * // With bold shortcut: "Enter to confirm" (Enter is bold)
 * <ThemedText dimColor><KeyboardShortcutHint shortcut="Enter" action="confirm" bold /></ThemedText>
 *
 * @example
 * // Multiple hints with middot separator — use Byline
 * <ThemedText dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </ThemedText>
 */
export function KeyboardShortcutHint({
  shortcut,
  action,
  parens = false,
  bold = false,
}: Props) {
  const shortcutText = bold ? <Text bold={true}>{shortcut}</Text> : shortcut
  if (parens) {
    return (
      <Text>
        ({shortcutText} to {action})
      </Text>
    )
  }
  return (
    <Text>
      {shortcutText} to {action}
    </Text>
  )
}
