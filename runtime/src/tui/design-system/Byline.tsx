import React, { Children, isValidElement } from 'react'
import ThemedText from './ThemedText.js'

type Props = {
  /** The items to join with a middot separator */
  children: React.ReactNode
}

/**
 * Joins children with a middot separator (" · ") for inline metadata
 * display.
 *
 * Named after the publishing term "byline" — the line of metadata
 * typically shown below a title (e.g., "John Doe · 5 min read · Mar 12").
 *
 * Automatically filters out null/undefined/false children and only
 * renders separators between valid elements.
 *
 * @example
 * // Basic usage: "Enter to confirm · Esc to cancel"
 * <ThemedText dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </ThemedText>
 *
 * @example
 * // With conditional children: "Esc to cancel" (only one item shown)
 * <ThemedText dimColor>
 *   <Byline>
 *     {showEnter && <KeyboardShortcutHint shortcut="Enter" action="confirm" />}
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </ThemedText>
 */
export function Byline({ children }: Props) {
  const validChildren = Children.toArray(children)
  if (validChildren.length === 0) {
    return null
  }
  return (
    <>
      {validChildren.map((child, index) => (
        <React.Fragment
          key={isValidElement(child) ? child.key ?? index : index}
        >
          {index > 0 && <ThemedText dimColor={true}> · </ThemedText>}
          {child}
        </React.Fragment>
      ))}
    </>
  )
}
