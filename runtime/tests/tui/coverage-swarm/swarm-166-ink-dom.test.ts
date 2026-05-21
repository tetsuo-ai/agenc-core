import { describe, expect, test } from 'vitest'

import {
  appendChildNode,
  clearYogaNodeReferences,
  createNode,
  createTextNode,
  findOwnerChainAtRow,
  insertBeforeNode,
  removeChildNode,
  setStyle,
  setTextStyles,
  type DOMElement,
  type DOMNode,
} from '../../../src/tui/ink/dom.ts'
import applyStyles, { type Styles } from '../../../src/tui/ink/styles.ts'

function applyNodeStyle(node: DOMElement, style: Styles): void {
  setStyle(node, style)
  if (node.yogaNode) applyStyles(node.yogaNode, style, node.style)
}

function appendText(parent: DOMElement, text: string): void {
  appendChildNode(parent, createTextNode(text) as unknown as DOMElement)
}

describe('ink DOM coverage swarm row 166', () => {
  test('inserts layout children before a layout sibling after non-layout nodes', () => {
    const parent = createNode('ink-box')
    applyNodeStyle(parent, {
      flexDirection: 'row',
      height: 1,
      width: 20,
    })

    const virtualText = createNode('ink-virtual-text')
    const link = createNode('ink-link')
    const progress = createNode('ink-progress')
    const firstLayout = createNode('ink-box')
    const insertedLayout = createNode('ink-box')

    applyNodeStyle(firstLayout, { height: 1, width: 4 })
    applyNodeStyle(insertedLayout, { height: 1, width: 3 })

    expect(virtualText.yogaNode).toBeUndefined()
    expect(link.yogaNode).toBeUndefined()
    expect(progress.yogaNode).toBeUndefined()

    appendChildNode(parent, virtualText)
    appendChildNode(parent, link)
    appendChildNode(parent, progress)
    appendChildNode(parent, firstLayout)
    insertBeforeNode(parent, insertedLayout, firstLayout)

    expect(parent.childNodes).toEqual([
      virtualText,
      link,
      progress,
      insertedLayout,
      firstLayout,
    ])
    expect(parent.yogaNode?.getChildCount()).toBe(2)

    parent.yogaNode?.calculateLayout(20, 1)

    expect(insertedLayout.yogaNode?.getComputedLeft()).toBe(0)
    expect(firstLayout.yogaNode?.getComputedLeft()).toBe(3)
  })

  test('measures text in intrinsic, constrained, and sub-column layouts', () => {
    const intrinsicText = createNode('ink-text')
    appendText(intrinsicText, 'abcdef\nx')

    intrinsicText.yogaNode?.calculateLayout()

    expect(intrinsicText.yogaNode?.getComputedWidth()).toBe(6)
    expect(intrinsicText.yogaNode?.getComputedHeight()).toBe(2)

    const wrappedText = createNode('ink-text')
    appendText(wrappedText, 'abcdef')

    wrappedText.yogaNode?.calculateLayout(3)

    expect(wrappedText.yogaNode?.getComputedWidth()).toBe(3)
    expect(wrappedText.yogaNode?.getComputedHeight()).toBe(2)

    const tooNarrowText = createNode('ink-text')
    appendText(tooNarrowText, 'abcd')

    tooNarrowText.yogaNode?.calculateLayout(0.5)

    expect(tooNarrowText.yogaNode?.getComputedWidth()).toBe(1)
    expect(tooNarrowText.yogaNode?.getComputedHeight()).toBe(1)
  })

  test('keeps style dirty flags stable for shallow-equal updates', () => {
    const node = createNode('ink-box')

    setStyle(node, undefined)
    expect(node.dirty).toBe(false)

    setStyle(node, { height: 1, width: 2 })
    expect(node.dirty).toBe(true)

    node.dirty = false
    setStyle(node, { height: 1, width: 2 })
    expect(node.dirty).toBe(false)

    setStyle(node, { height: 1 })
    expect(node.dirty).toBe(true)

    node.dirty = false
    setTextStyles(node, { bold: true })
    expect(node.dirty).toBe(true)

    node.dirty = false
    setTextStyles(node, { bold: false })
    expect(node.dirty).toBe(true)
  })

  test('handles orphan removals and non-element owner lookups', () => {
    const parent = createNode('ink-box')
    const child = createNode('ink-box')
    const text = createTextNode('loose')

    removeChildNode(parent, child)
    removeChildNode(parent, text as DOMNode)

    expect(parent.childNodes).toEqual([])
    expect(child.parentNode).toBeUndefined()
    expect(text.parentNode).toBeUndefined()
    expect(parent.dirty).toBe(true)
    expect(findOwnerChainAtRow(createNode('ink-link'), 0)).toEqual([])
  })

  test('clears yoga references across element and text descendants', () => {
    const root = createNode('ink-root')
    const box = createNode('ink-box')
    const text = createTextNode('text')

    appendChildNode(box, text as unknown as DOMElement)
    appendChildNode(root, box)

    expect(root.yogaNode).toBeDefined()
    expect(box.yogaNode).toBeDefined()

    clearYogaNodeReferences(root)

    expect(root.yogaNode).toBeUndefined()
    expect(box.yogaNode).toBeUndefined()
    expect(text.yogaNode).toBeUndefined()
  })
})
