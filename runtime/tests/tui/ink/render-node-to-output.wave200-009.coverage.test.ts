import { expect, test } from 'vitest'

import {
  appendChildNode,
  createNode,
  createTextNode,
  setAttribute,
  setStyle,
  type DOMElement,
} from './dom.ts'
import Output from './output.ts'
import renderNodeToOutput from './render-node-to-output.ts'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  charInCellAt,
  createScreen,
} from './screen.ts'
import applyStyles, { type Styles } from './styles.ts'

function applyNodeStyle(node: DOMElement, style: Styles): void {
  setStyle(node, style)
  if (node.yogaNode) applyStyles(node.yogaNode, style, style)
}

function appendText(parent: DOMElement, text: string): void {
  appendChildNode(parent, createTextNode(text) as unknown as DOMElement)
}

test('renders a top-clamped absolute overlay without selecting its gutter row', () => {
  const root = createNode('ink-root')
  applyNodeStyle(root, {
    flexDirection: 'column',
    height: 3,
    width: 8,
  })

  const gutter = createNode('ink-box')
  applyNodeStyle(gutter, {
    height: 1,
    marginLeft: 2,
    noSelect: 'from-left-edge',
    width: 4,
  })

  const gutterText = createNode('ink-text')
  appendText(gutterText, 'SIDE')
  appendChildNode(gutter, gutterText)

  const raw = createNode('ink-raw-ansi')
  setAttribute(raw, 'rawText', '\u001B[31mRAW\u001B[0m')
  setAttribute(raw, 'rawWidth', 3)
  setAttribute(raw, 'rawHeight', 1)

  const overlay = createNode('ink-box')
  applyNodeStyle(overlay, {
    height: 1,
    left: 1,
    opaque: true,
    position: 'absolute',
    top: -1,
    width: 5,
  })

  const overlayText = createNode('ink-text')
  appendText(overlayText, 'TOP')
  appendChildNode(overlay, overlayText)

  appendChildNode(root, gutter)
  appendChildNode(root, raw)
  appendChildNode(root, overlay)
  root.yogaNode?.calculateLayout(8, 3)

  const stylePool = new StylePool()
  const screen = createScreen(
    8,
    3,
    stylePool,
    new CharPool(),
    new HyperlinkPool(),
  )
  const output = new Output({
    height: 3,
    screen,
    stylePool,
    width: 8,
  })

  renderNodeToOutput(root, output, { prevScreen: undefined })
  const rendered = output.get()

  expect(charInCellAt(rendered, 1, 0)).toBe('T')
  expect(charInCellAt(rendered, 2, 0)).toBe('O')
  expect(charInCellAt(rendered, 3, 0)).toBe('P')
  expect(charInCellAt(rendered, 4, 0)).toBe(' ')
  expect(charInCellAt(rendered, 0, 1)).toBe('R')
  expect(charInCellAt(rendered, 1, 1)).toBe('A')
  expect(charInCellAt(rendered, 2, 1)).toBe('W')
  expect([...rendered.noSelect.slice(0, 8)]).toEqual([1, 1, 1, 1, 1, 1, 0, 0])
})
