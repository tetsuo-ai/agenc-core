import { describe, expect, test, vi } from 'vitest'

import type { ClickEvent } from '../../../src/tui/ink/events/click-event.js'
import type { DOMElement, DOMNode } from '../../../src/tui/ink/dom.js'
import {
  dispatchClick,
  dispatchHover,
  hitTest,
} from '../../../src/tui/ink/hit-test.js'
import { nodeCache } from '../../../src/tui/ink/node-cache.js'

function element(nodeName: DOMElement['nodeName'] = 'ink-box'): DOMElement {
  return {
    attributes: {},
    childNodes: [],
    dirty: false,
    nodeName,
    parentNode: undefined,
    style: {},
  }
}

function textNode(value = 'text'): DOMNode {
  return {
    nodeName: '#text',
    nodeValue: value,
    parentNode: undefined,
    style: {},
  } as DOMNode
}

function append(parent: DOMElement, child: DOMNode): void {
  child.parentNode = parent
  parent.childNodes.push(child)
}

function cache(
  node: DOMElement,
  rect: { height: number; width: number; x: number; y: number },
): void {
  nodeCache.set(node, rect)
}

describe('hit-test coverage swarm row 176', () => {
  test('rejects uncached nodes and treats right and bottom bounds as exclusive', () => {
    const root = element('ink-root')

    expect(hitTest(root, 0, 0)).toBeNull()

    cache(root, { height: 2, width: 4, x: 2, y: 3 })

    expect(hitTest(root, 1, 3)).toBeNull()
    expect(hitTest(root, 6, 3)).toBeNull()
    expect(hitTest(root, 2, 2)).toBeNull()
    expect(hitTest(root, 2, 5)).toBeNull()
    expect(hitTest(root, 5, 4)).toBe(root)
  })

  test('prefers later siblings, skips text children, and ignores uncached subtrees', () => {
    const root = element('ink-root')
    const back = element()
    const top = element()
    const uncached = element()
    const grandchild = element()

    append(root, back)
    append(root, textNode())
    append(root, top)
    append(root, uncached)
    append(uncached, grandchild)

    cache(root, { height: 4, width: 10, x: 0, y: 0 })
    cache(back, { height: 2, width: 4, x: 1, y: 1 })
    cache(top, { height: 2, width: 4, x: 2, y: 1 })
    cache(grandchild, { height: 1, width: 1, x: 3, y: 1 })

    expect(hitTest(root, 3, 1)).toBe(top)
    expect(hitTest(root, 1, 1)).toBe(back)
    expect(hitTest(root, 8, 1)).toBe(root)
  })

  test('click dispatch focuses the nearest tabIndex ancestor and bubbles local coordinates', () => {
    const root = element('ink-root')
    const parent = element()
    const leaf = element()
    const focusManager = { handleClickFocus: vi.fn() }
    const clicks: Array<{
      blank: boolean
      col: number
      localCol: number
      localRow: number
      name: string
      row: number
    }> = []

    root.focusManager = focusManager as unknown as DOMElement['focusManager']
    parent.attributes.tabIndex = 0
    leaf._eventHandlers = {
      onClick: (event: ClickEvent) => {
        clicks.push({
          blank: event.cellIsBlank,
          col: event.col,
          localCol: event.localCol,
          localRow: event.localRow,
          name: 'leaf',
          row: event.row,
        })
      },
    }
    parent._eventHandlers = {
      onClick: (event: ClickEvent) => {
        clicks.push({
          blank: event.cellIsBlank,
          col: event.col,
          localCol: event.localCol,
          localRow: event.localRow,
          name: 'parent',
          row: event.row,
        })
      },
    }

    append(root, parent)
    append(parent, leaf)
    cache(root, { height: 10, width: 20, x: 0, y: 0 })
    cache(parent, { height: 4, width: 5, x: 4, y: 3 })
    cache(leaf, { height: 1, width: 2, x: 6, y: 5 })

    expect(dispatchClick(root, 7, 5, true)).toBe(true)

    expect(focusManager.handleClickFocus).toHaveBeenCalledWith(parent)
    expect(clicks).toEqual([
      {
        blank: true,
        col: 7,
        localCol: 1,
        localRow: 0,
        name: 'leaf',
        row: 5,
      },
      {
        blank: true,
        col: 7,
        localCol: 3,
        localRow: 2,
        name: 'parent',
        row: 5,
      },
    ])
  })

  test('click dispatch reports misses, unhandled hits, and immediate propagation stops', () => {
    const root = element('ink-root')
    const child = element()
    const rootClick = vi.fn()
    const childClick = vi.fn((event: ClickEvent) => {
      event.stopImmediatePropagation()
    })

    append(root, child)
    cache(root, { height: 4, width: 4, x: 0, y: 0 })
    cache(child, { height: 2, width: 2, x: 1, y: 1 })

    expect(dispatchClick(root, 9, 9)).toBe(false)
    expect(dispatchClick(root, 1, 1)).toBe(false)

    root._eventHandlers = { onClick: rootClick }
    child._eventHandlers = { onClick: childClick }

    expect(dispatchClick(root, 1, 1)).toBe(true)
    expect(childClick).toHaveBeenCalledTimes(1)
    expect(rootClick).not.toHaveBeenCalled()
  })

  test('hover dispatch diffs handled ancestors and skips leave on detached nodes', () => {
    const root = element('ink-root')
    const child = element()
    const leaf = element()
    const detached = element()
    const hovered = new Set<DOMElement>([detached])
    const events: string[] = []

    root._eventHandlers = {
      onMouseEnter: () => events.push('root-enter'),
      onMouseLeave: () => events.push('root-leave'),
    }
    child._eventHandlers = {
      onMouseEnter: () => events.push('child-enter'),
      onMouseLeave: () => events.push('child-leave'),
    }
    detached._eventHandlers = {
      onMouseLeave: () => events.push('detached-leave'),
    }

    append(root, child)
    append(child, leaf)
    cache(root, { height: 2, width: 5, x: 0, y: 0 })
    cache(child, { height: 1, width: 2, x: 1, y: 0 })
    cache(leaf, { height: 1, width: 1, x: 1, y: 0 })

    dispatchHover(root, 1, 0, hovered)
    dispatchHover(root, 1, 0, hovered)
    dispatchHover(root, 4, 0, hovered)
    dispatchHover(root, 9, 0, hovered)

    expect(events).toEqual(['child-enter', 'root-enter', 'child-leave'])
    expect(hovered.size).toBe(0)
  })
})
