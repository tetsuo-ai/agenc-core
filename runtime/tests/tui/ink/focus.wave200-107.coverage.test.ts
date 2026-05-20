import { expect, test } from 'vitest'

import type { DOMElement, DOMNode } from './dom.ts'
import type { FocusEvent } from './events/focus-event.ts'
import { FocusManager, getFocusManager, getRootNode } from './focus.ts'

type EventRecord = {
  target: string
  type: string
  relatedTarget: string | null
  bubbles: boolean
  cancelable: boolean
}

function makeElement(id: string, tabIndex?: number): DOMElement {
  return {
    nodeName: 'ink-box',
    attributes:
      tabIndex === undefined
        ? { id }
        : {
            id,
            tabIndex,
          },
    childNodes: [],
    parentNode: undefined,
    style: {},
    dirty: false,
  }
}

function makeTextNode(parentNode: DOMElement): DOMNode {
  return {
    nodeName: '#text',
    nodeValue: 'ignored',
    parentNode,
    style: {},
  } as DOMNode
}

function append(parent: DOMElement, child: DOMElement): DOMElement {
  child.parentNode = parent
  parent.childNodes.push(child)
  return child
}

function detach(parent: DOMElement, child: DOMElement): void {
  parent.childNodes = parent.childNodes.filter(node => node !== child)
  child.parentNode = undefined
}

function nodeId(node: DOMElement): string {
  return String(node.attributes.id)
}

test('manages focus traversal, guarded focus, subtree removal, and root lookup', () => {
  const events: EventRecord[] = []
  const manager = new FocusManager((target, event: FocusEvent) => {
    events.push({
      target: nodeId(target),
      type: event.type,
      relatedTarget: event.relatedTarget
        ? nodeId(event.relatedTarget as DOMElement)
        : null,
      bubbles: event.bubbles,
      cancelable: event.cancelable,
    })
    return true
  })

  const root = makeElement('root')
  root.focusManager = manager
  const noTabIndex = append(root, makeElement('no-tab-index'))
  const clickOnly = append(root, makeElement('click-only', -1))
  root.childNodes.push(makeTextNode(root))

  const tabbable = Array.from({ length: 35 }, (_, index) =>
    append(root, makeElement(`tab-${index}`, 0)),
  )
  const removedPanel = append(root, makeElement('removed-panel'))
  const removedLeaf = append(removedPanel, makeElement('removed-leaf', 0))

  expect(getRootNode(removedLeaf)).toBe(root)
  expect(getFocusManager(removedLeaf)).toBe(manager)
  expect(() => getRootNode(makeElement('orphan'))).toThrow(
    'Node is not in a tree with a FocusManager',
  )

  manager.blur()
  manager.disable()
  manager.handleAutoFocus(tabbable[0]!)
  manager.focusNext(root)
  expect(manager.activeElement).toBeNull()
  expect(events).toEqual([])

  manager.enable()
  manager.focusNext(makeElement('empty-root'))
  manager.handleClickFocus(noTabIndex)
  expect(manager.activeElement).toBeNull()

  manager.handleClickFocus(clickOnly)
  expect(manager.activeElement).toBe(clickOnly)
  expect(events).toEqual([
    {
      target: 'click-only',
      type: 'focus',
      relatedTarget: null,
      bubbles: true,
      cancelable: false,
    },
  ])

  manager.focus(clickOnly)
  manager.disable()
  manager.focus(tabbable[0]!)
  expect(manager.activeElement).toBe(clickOnly)
  expect(events).toHaveLength(1)

  manager.enable()
  manager.focusNext(root)
  expect(manager.activeElement).toBe(tabbable[0])

  manager.blur()
  manager.focusPrevious(root)
  expect(manager.activeElement).toBe(removedLeaf)

  manager.focusNext(root)
  expect(manager.activeElement).toBe(tabbable[0])

  manager.focusPrevious(root)
  expect(manager.activeElement).toBe(removedLeaf)

  manager.blur()
  events.length = 0

  for (const node of tabbable) {
    manager.focus(node)
  }
  manager.focus(removedLeaf)
  detach(root, removedPanel)

  manager.handleNodeRemoved(removedPanel, root)

  expect(manager.activeElement).toBe(tabbable.at(-1))
  expect(events.slice(-4)).toEqual([
    {
      target: 'tab-34',
      type: 'blur',
      relatedTarget: 'removed-leaf',
      bubbles: true,
      cancelable: false,
    },
    {
      target: 'removed-leaf',
      type: 'focus',
      relatedTarget: 'tab-34',
      bubbles: true,
      cancelable: false,
    },
    {
      target: 'removed-leaf',
      type: 'blur',
      relatedTarget: null,
      bubbles: true,
      cancelable: false,
    },
    {
      target: 'tab-34',
      type: 'focus',
      relatedTarget: 'removed-leaf',
      bubbles: true,
      cancelable: false,
    },
  ])

  const eventCountAfterRestore = events.length
  manager.handleNodeRemoved(noTabIndex, root)
  expect(manager.activeElement).toBe(tabbable.at(-1))
  expect(events).toHaveLength(eventCountAfterRestore)

  manager.blur()
  events.length = 0
  manager.handleNodeRemoved(tabbable[0]!, root)
  expect(events).toEqual([])
})
