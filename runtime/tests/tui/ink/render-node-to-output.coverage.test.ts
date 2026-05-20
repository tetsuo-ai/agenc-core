import { describe, expect, test } from 'vitest'

import {
  appendChildNode,
  createNode,
  createTextNode,
  type DOMElement,
} from './dom.ts'
import Output from './output.ts'
import {
  applyStylesToWrappedText,
  buildCharToSegmentMap,
  consumeFollowScroll,
  getScrollDrainNode,
  getScrollHint,
  resetScrollDrainNode,
  resetScrollHint,
} from './render-node-to-output.ts'
import renderNodeToOutput from './render-node-to-output.ts'
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
} from './screen.ts'
import type { StyledSegment } from './squash-text-nodes.ts'
import applyStyles, { type Styles } from './styles.ts'

const OSC = '\u001B]'
const BEL = '\u0007'

function link(text: string, url: string): string {
  return `${OSC}8;;${url}${BEL}${text}${OSC}8;;${BEL}`
}

function mapFor(segments: StyledSegment[]): number[] {
  return buildCharToSegmentMap(segments)
}

function applyNodeStyle(node: DOMElement, style: Styles): void {
  node.style = { ...node.style, ...style }
  if (node.yogaNode) applyStyles(node.yogaNode, style, style)
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

function createScrollableTree(options: {
  pendingScrollDelta?: number
  scrollTop?: number
  stickyScroll?: boolean
}): { root: DOMElement; scrollBox: DOMElement } {
  const root = createNode('ink-root')
  applyNodeStyle(root, {
    flexDirection: 'column',
    height: 4,
    width: 10,
  })

  const scrollBox = createNode('ink-box')
  applyNodeStyle(scrollBox, {
    flexDirection: 'column',
    height: 3,
    overflowY: 'scroll',
    width: 10,
  })
  scrollBox.scrollTop = options.scrollTop
  scrollBox.pendingScrollDelta = options.pendingScrollDelta
  scrollBox.stickyScroll = options.stickyScroll

  const content = createNode('ink-box')
  applyNodeStyle(content, {
    flexDirection: 'column',
    flexShrink: 0,
    width: 10,
  })

  for (let i = 0; i < 12; i += 1) {
    const line = createNode('ink-text')
    appendText(line, `line-${i}`)
    appendChildNode(content, line)
  }

  appendChildNode(scrollBox, content)
  appendChildNode(root, scrollBox)
  root.yogaNode?.calculateLayout(10, 4)

  return { root, scrollBox }
}

describe('render-node-to-output coverage', () => {
  test('maps trim-wrapped text back to linked segments after skipped whitespace', () => {
    const softWrappedSegments: StyledSegment[] = [
      {
        hyperlink: 'https://example.test/first',
        styles: {},
        text: 'AB   ',
      },
      {
        hyperlink: 'https://example.test/second',
        styles: {},
        text: '\tD\n ',
      },
      {
        hyperlink: 'https://example.test/third',
        styles: {},
        text: 'EF',
      },
    ]

    expect(
      applyStylesToWrappedText(
        'AB\n\tD\nEF',
        softWrappedSegments,
        mapFor(softWrappedSegments),
        softWrappedSegments.map(segment => segment.text).join(''),
        true,
      ),
    ).toBe(
      [
        link('AB', 'https://example.test/first'),
        link('\tD', 'https://example.test/second'),
        link('EF', 'https://example.test/third'),
      ].join('\n'),
    )

    const leadingTrimSegments: StyledSegment[] = [
      { styles: {}, text: '  ' },
      {
        hyperlink: 'https://example.test/leading',
        styles: {},
        text: 'AB',
      },
    ]

    expect(
      applyStylesToWrappedText(
        'AB',
        leadingTrimSegments,
        mapFor(leadingTrimSegments),
        leadingTrimSegments.map(segment => segment.text).join(''),
        true,
      ),
    ).toBe(link('AB', 'https://example.test/leading'))
  })

  test('xterm scroll drain snaps excess and leaves a drain node for the next frame', () => {
    const previousTermProgram = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'vscode'
    resetScrollHint()
    resetScrollDrainNode()

    try {
      const { root, scrollBox } = createScrollableTree({
        pendingScrollDelta: 40,
        scrollTop: 0,
      })

      renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

      expect(scrollBox.scrollTop).toBe(2)
      expect(scrollBox.pendingScrollDelta).toBe(38)
      expect(getScrollDrainNode()).toBe(scrollBox)
      expect(getScrollHint()).toBeNull()
    } finally {
      if (previousTermProgram === undefined) {
        delete process.env.TERM_PROGRAM
      } else {
        process.env.TERM_PROGRAM = previousTermProgram
      }
      resetScrollHint()
      resetScrollDrainNode()
    }
  })

  test('small scroll drain clears completed deltas and records follow-scroll movement', () => {
    const previousTermProgram = process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM
    resetScrollHint()
    resetScrollDrainNode()

    try {
      const { root, scrollBox } = createScrollableTree({
        pendingScrollDelta: 2,
        scrollTop: 0,
      })

      renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

      expect(scrollBox.scrollTop).toBe(2)
      expect(scrollBox.pendingScrollDelta).toBeUndefined()
      expect(getScrollDrainNode()).toBeNull()
      expect(consumeFollowScroll()).toBeNull()

      const followTree = createScrollableTree({
        scrollTop: 0,
        stickyScroll: true,
      })
      renderNodeToOutput(followTree.root, createOutput(10, 4), {
        prevScreen: undefined,
      })

      expect(followTree.scrollBox.scrollTop).toBe(9)
      expect(consumeFollowScroll()).toEqual({
        delta: 9,
        viewportBottom: 2,
        viewportTop: 0,
      })
    } finally {
      if (previousTermProgram === undefined) {
        delete process.env.TERM_PROGRAM
      } else {
        process.env.TERM_PROGRAM = previousTermProgram
      }
      resetScrollHint()
      resetScrollDrainNode()
      consumeFollowScroll()
    }
  })
})
