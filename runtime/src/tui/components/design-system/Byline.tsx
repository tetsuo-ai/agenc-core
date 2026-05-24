import React, { Children, isValidElement, type ReactElement } from 'react'

import { selectAgenCTuiGlyphs } from '../../glyphs.js'
import { Text } from '../../ink.js'

type Props = {
  /** The items to join with the active glyph-mode separator */
  children: React.ReactNode
}

/**
 * Joins children with the active glyph-mode separator for inline metadata display.
 *
 * Named after the publishing term "byline" - the line of metadata typically
 * shown below a title (for example, "John Doe / 5 min read / Mar 12").
 *
 * Automatically filters out null/undefined/false children and renders
 * separators between every visible leaf item, including children inside
 * fragments.
 *
 * @example
 * // Basic usage: "Enter to confirm / Esc to cancel"
 * <Text dimColor>
 *   <Byline>
 *     <KeyboardShortcutHint shortcut="Enter" action="confirm" />
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 *
 * @example
 * // With conditional children: "Esc to cancel" (only one item shown)
 * <Text dimColor>
 *   <Byline>
 *     {showEnter && <KeyboardShortcutHint shortcut="Enter" action="confirm" />}
 *     <KeyboardShortcutHint shortcut="Esc" action="cancel" />
 *   </Byline>
 * </Text>
 *
 */
export function Byline({ children }: Props): React.ReactNode {
  const validChildren = flattenBylineChildren(children)
  if (validChildren.length === 0) {
    return null
  }

  const separator = selectAgenCTuiGlyphs().separator
  return (
    <>
      {validChildren.map((child, index) => (
        <React.Fragment key={childKey(child, index)}>
          {index > 0 && <Text dimColor>{` ${separator} `}</Text>}
          {child}
        </React.Fragment>
      ))}
    </>
  )
}

function flattenBylineChildren(children: React.ReactNode): React.ReactNode[] {
  const result: React.ReactNode[] = []

  Children.forEach(children, child => {
    if (child === null || child === undefined || typeof child === 'boolean') {
      return
    }
    if (isFragmentElement(child)) {
      result.push(...flattenBylineChildren(child.props.children))
      return
    }
    result.push(child)
  })

  return result
}

function isFragmentElement(
  child: React.ReactNode,
): child is ReactElement<{ children?: React.ReactNode }> {
  return isValidElement(child) && child.type === React.Fragment
}

function childKey(child: React.ReactNode, index: number): React.Key {
  return isValidElement(child) && child.key !== null ? child.key : index
}
