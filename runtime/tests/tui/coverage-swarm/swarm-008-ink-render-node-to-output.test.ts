import { describe, expect, test } from 'vitest'

import {
  appendChildNode,
  createNode,
  createTextNode,
  setAttribute,
  setStyle,
  type DOMElement,
} from '../../../src/tui/ink/dom.ts'
import Output from '../../../src/tui/ink/output.ts'
import renderNodeToOutput, {
  didLayoutShift,
  resetLayoutShifted,
} from '../../../src/tui/ink/render-node-to-output.ts'
import {
  cellAt,
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  StylePool,
} from '../../../src/tui/ink/screen.ts'
import applyStyles, { type Styles } from '../../../src/tui/ink/styles.ts'

function applyNodeStyle(node: DOMElement, style: Styles): void {
  const nextStyle = { ...node.style, ...style }
  setStyle(node, nextStyle)
  if (node.yogaNode) applyStyles(node.yogaNode, style, nextStyle)
}

function appendText(parent: DOMElement, text: string): void {
  appendChildNode(parent, createTextNode(text) as unknown as DOMElement)
}

function createOutput(width: number, height: number): Output {
  const stylePool = new StylePool()
  return new Output({
    height,
    screen: createScreen(width, height, stylePool, new CharPool(), new HyperlinkPool()),
    stylePool,
    width,
  })
}

function render(
  root: DOMElement,
  width: number,
  height: number,
  prevScreen?: ReturnType<Output['get']>,
): ReturnType<Output['get']> {
  root.yogaNode?.calculateLayout(width, height)
  const output = createOutput(width, height)
  renderNodeToOutput(root, output, { prevScreen })
  return output.get()
}

function createTextRoot(width: number, height: number): DOMElement {
  const root = createNode('ink-root')
  applyNodeStyle(root, {
    flexDirection: 'column',
    height,
    width,
  })
  return root
}

function createScrollableTree(): {
  anchor: DOMElement
  root: DOMElement
  scrollBox: DOMElement
} {
  const root = createTextRoot(8, 3)

  const scrollBox = createNode('ink-box')
  applyNodeStyle(scrollBox, {
    flexDirection: 'column',
    height: 3,
    overflowY: 'scroll',
    width: 8,
  })

  const content = createNode('ink-box')
  applyNodeStyle(content, {
    flexDirection: 'column',
    flexShrink: 0,
    width: 8,
  })

  let anchor = content
  for (let i = 0; i < 6; i += 1) {
    const line = createNode('ink-text')
    appendText(line, `row-${i}`)
    appendChildNode(content, line)
    if (i === 4) anchor = line
  }

  appendChildNode(scrollBox, content)
  appendChildNode(root, scrollBox)

  return { anchor, root, scrollBox }
}

describe('renderNodeToOutput coverage swarm row 008', () => {
  test('clears a cached subtree when its layout display becomes none', () => {
    resetLayoutShifted()

    const root = createTextRoot(6, 2)
    const text = createNode('ink-text')
    appendText(text, 'hide')
    appendChildNode(root, text)

    const firstScreen = render(root, 6, 2)
    expect(charInCellAt(firstScreen, 0, 0)).toBe('h')

    applyNodeStyle(text, {
      display: 'none',
    })

    const hiddenScreen = render(root, 6, 2, firstScreen)

    expect(charInCellAt(hiddenScreen, 0, 0)).toBe(' ')
    expect(charInCellAt(hiddenScreen, 1, 0)).toBe(' ')
    expect(didLayoutShift()).toBe(true)
  })

  test('keeps hyperlink and soft-wrap metadata across wrapped text segments', () => {
    const root = createTextRoot(2, 2)
    const text = createNode('ink-text')
    applyNodeStyle(text, {
      width: 2,
    })

    const link = createNode('ink-link')
    setAttribute(link, 'href', 'https://agenc.test/row-008')
    appendText(link, 'AB')

    appendChildNode(text, link)
    appendText(text, 'CD')
    appendChildNode(root, text)

    const screen = render(root, 2, 2)

    expect(charInCellAt(screen, 0, 0)).toBe('A')
    expect(charInCellAt(screen, 1, 0)).toBe('B')
    expect(charInCellAt(screen, 0, 1)).toBe('C')
    expect(charInCellAt(screen, 1, 1)).toBe('D')
    expect(cellAt(screen, 0, 0)?.hyperlink).toBe('https://agenc.test/row-008')
    expect(cellAt(screen, 1, 0)?.hyperlink).toBe('https://agenc.test/row-008')
    expect(cellAt(screen, 0, 1)?.hyperlink).toBeUndefined()
    expect(screen.softWrap[1]).toBe(2)
  })

  test('applies scroll anchors and clears zero pending scroll deltas', () => {
    const { anchor, root, scrollBox } = createScrollableTree()
    scrollBox.scrollTop = 1
    scrollBox.pendingScrollDelta = 0
    scrollBox.scrollAnchor = {
      el: anchor,
      offset: -1,
    }

    const screen = render(root, 8, 3)

    expect(scrollBox.scrollTop).toBe(3)
    expect(scrollBox.pendingScrollDelta).toBeUndefined()
    expect(scrollBox.scrollAnchor).toBeUndefined()
    expect(scrollBox.scrollHeight).toBe(6)
    expect(scrollBox.scrollViewportHeight).toBe(3)
    expect(charInCellAt(screen, 0, 0)).toBe('r')
    expect(charInCellAt(screen, 4, 0)).toBe('3')
  })
})
