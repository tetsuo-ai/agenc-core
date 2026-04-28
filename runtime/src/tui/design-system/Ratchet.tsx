import React, { useLayoutEffect, useRef, useState } from 'react'
import Box from '../ink/components/Box.js'
import type { DOMElement } from '../ink/dom.js'
import { useTerminalViewport } from '../ink/hooks/use-terminal-viewport.js'
import measureElement from '../ink/measure-element.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'

type Props = {
  children: React.ReactNode
  /**
   * `'always'` (default): once the inner content reaches a height, the
   * outer Box never shrinks below it.
   * `'offscreen'`: only ratchets the height while the element is offscreen
   * (e.g. inside a virtualized list); when scrolled into view, the box can
   * shrink again.
   */
  lock?: 'always' | 'offscreen'
}

/**
 * Container that ratchets its height upward — never shrinks once it has
 * grown. Used inside virtualized transcripts and animated panels to
 * prevent the surrounding layout from shifting when the inner content
 * temporarily collapses.
 */
export function Ratchet({ children, lock = 'always' }: Props) {
  const [viewportRef, { isVisible }] = useTerminalViewport()
  const { rows } = useTerminalSize()
  const innerRef = useRef<DOMElement | null>(null)
  const maxHeight = useRef(0)
  const [minHeight, setMinHeight] = useState(0)

  const outerRef = (el: DOMElement | null) => {
    viewportRef(el)
  }

  const engaged = lock === 'always' || !isVisible

  useLayoutEffect(() => {
    if (!innerRef.current) return
    const { height } = measureElement(innerRef.current)
    if (height > maxHeight.current) {
      maxHeight.current = Math.min(height, rows)
      setMinHeight(maxHeight.current)
    }
  })

  return (
    <Box minHeight={engaged ? minHeight : undefined} ref={outerRef}>
      <Box ref={innerRef} flexDirection="column">
        {children}
      </Box>
    </Box>
  )
}
