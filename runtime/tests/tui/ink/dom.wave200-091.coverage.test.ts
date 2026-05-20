import { expect, test, vi } from 'vitest'

import {
  appendChildNode,
  createNode,
  createTextNode,
  findOwnerChainAtRow,
  insertBeforeNode,
  removeChildNode,
  scheduleRenderFrom,
  setAttribute,
  setStyle,
  setTextNodeValue,
  setTextStyles,
  type DOMElement,
  type TextNode,
} from './dom.ts'
import {
  consumeAbsoluteRemovedFlag,
  nodeCache,
  pendingClears,
} from './node-cache.ts'
import applyStyles, { type Styles } from './styles.ts'

function applyNodeStyle(node: DOMElement, style: Styles): void {
  setStyle(node, style)
  if (node.yogaNode) applyStyles(node.yogaNode, style, node.style)
}

function appendTextNode(parent: DOMElement, text: string): TextNode {
  const textNode = createTextNode(text)
  appendChildNode(parent, textNode as unknown as DOMElement)
  return textNode
}

test('keeps DOM layout bookkeeping consistent across mutations', () => {
  consumeAbsoluteRemovedFlag()

  const root = createNode('ink-root')
  applyNodeStyle(root, {
    alignItems: 'flex-start',
    flexDirection: 'column',
    height: 8,
    width: 20,
  })

  const firstParent = createNode('ink-box')
  applyNodeStyle(firstParent, { height: 1, width: 5 })
  const secondParent = createNode('ink-box')
  applyNodeStyle(secondParent, { height: 1, width: 5 })
  const reparented = createNode('ink-box')
  applyNodeStyle(reparented, { height: 1, width: 5 })

  appendChildNode(firstParent, reparented)
  appendChildNode(secondParent, reparented)

  expect(firstParent.childNodes).toEqual([])
  expect(secondParent.childNodes).toEqual([reparented])
  expect(reparented.parentNode).toBe(secondParent)

  const detachedParent = createNode('ink-box')
  const moved = createNode('ink-box')
  appendChildNode(detachedParent, moved)
  insertBeforeNode(secondParent, moved, createNode('ink-box'))

  expect(detachedParent.childNodes).toEqual([])
  expect(secondParent.childNodes.at(-1)).toBe(moved)
  expect(moved.parentNode).toBe(secondParent)

  const raw = createNode('ink-raw-ansi')
  setAttribute(raw, 'rawWidth', 7)
  setAttribute(raw, 'rawHeight', 2)
  appendChildNode(root, secondParent)
  appendChildNode(root, raw)
  root.yogaNode?.calculateLayout(20, 8)

  expect(raw.yogaNode?.getComputedWidth()).toBe(7)
  expect(raw.yogaNode?.getComputedHeight()).toBe(2)

  raw.dirty = false
  setAttribute(raw, 'children', 'ignored')
  expect(raw.attributes.children).toBeUndefined()
  expect(raw.dirty).toBe(false)

  setAttribute(raw, 'rawWidth', 7)
  expect(raw.dirty).toBe(false)

  setStyle(raw, raw.style)
  expect(raw.dirty).toBe(false)

  setTextStyles(raw, { color: 'ansi:red' })
  expect(raw.dirty).toBe(true)
  raw.dirty = false
  setTextStyles(raw, { color: 'ansi:red' })
  expect(raw.dirty).toBe(false)

  const onRender = vi.fn()
  root.onRender = onRender
  const textNode = appendTextNode(root, 'same')
  scheduleRenderFrom(textNode)
  scheduleRenderFrom(createTextNode('orphan'))
  expect(onRender).toHaveBeenCalledTimes(1)

  setTextNodeValue(textNode, 42 as unknown as string)
  expect(textNode.nodeValue).toBe('42')

  const overlay = createNode('ink-box')
  applyNodeStyle(overlay, {
    height: 1,
    position: 'absolute',
    width: 3,
  })
  const overlayChild = createNode('ink-box')
  appendChildNode(overlay, overlayChild)
  appendChildNode(root, overlay)

  nodeCache.set(overlay, { height: 1, width: 3, x: 1, y: 2 })
  nodeCache.set(overlayChild, { height: 1, width: 1, x: 1, y: 2 })
  removeChildNode(root, overlay)

  expect(nodeCache.has(overlay)).toBe(false)
  expect(nodeCache.has(overlayChild)).toBe(false)
  expect(pendingClears.get(root)).toEqual([
    { height: 1, width: 3, x: 1, y: 2 },
    { height: 1, width: 1, x: 1, y: 2 },
  ])
  expect(consumeAbsoluteRemovedFlag()).toBe(true)
  expect(consumeAbsoluteRemovedFlag()).toBe(false)

  const ownerRoot = createNode('ink-root')
  applyNodeStyle(ownerRoot, { flexDirection: 'column', height: 5, width: 10 })

  const hidden = createNode('ink-box')
  hidden.debugOwnerChain = ['hidden']
  applyNodeStyle(hidden, { display: 'none', height: 2, width: 10 })

  const first = createNode('ink-box')
  first.debugOwnerChain = ['first']
  applyNodeStyle(first, { height: 1, width: 10 })

  const nestedParent = createNode('ink-box')
  nestedParent.debugOwnerChain = ['parent']
  applyNodeStyle(nestedParent, { height: 2, width: 10 })

  const nested = createNode('ink-box')
  nested.debugOwnerChain = ['child']
  applyNodeStyle(nested, { height: 1, width: 10 })

  appendTextNode(nestedParent, 'ignored')
  appendChildNode(nestedParent, nested)
  appendChildNode(ownerRoot, hidden)
  appendChildNode(ownerRoot, first)
  appendChildNode(ownerRoot, nestedParent)
  ownerRoot.yogaNode?.calculateLayout(10, 5)

  expect(findOwnerChainAtRow(ownerRoot, 0)).toEqual(['first'])
  expect(findOwnerChainAtRow(ownerRoot, 1)).toEqual(['child'])
  expect(findOwnerChainAtRow(ownerRoot, 4)).toEqual([])
})
