import { describe, expect, test } from 'vitest'

import {
  appendChildNode,
  createNode,
  createTextNode,
  markDirty,
  removeChildNode,
  setAttribute,
  type DOMElement,
  type DOMNode,
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
  cellAt,
  CharPool,
  charInCellAt,
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

function createOutputPools(): {
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
  stylePool: StylePool
} {
  return {
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
    stylePool: new StylePool(),
  }
}

function createOutput(
  width: number,
  height: number,
  pools = createOutputPools(),
): Output {
  const { charPool, hyperlinkPool, stylePool } = pools
  return new Output({
    height,
    screen: createScreen(width, height, stylePool, charPool, hyperlinkPool),
    stylePool,
    width,
  })
}

function createScrollableTree(options: {
  pendingScrollDelta?: number
  scrollTop?: number
  stickyScroll?: boolean
}): { content: DOMElement; root: DOMElement; scrollBox: DOMElement } {
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

  return { content, root, scrollBox }
}

function appendLine(content: DOMElement, text: string): DOMElement {
  const line = createNode('ink-text')
  appendText(line, text)
  appendChildNode(content, line)
  return line
}

function render(
  root: DOMElement,
  width: number,
  height: number,
  prevScreen?: ReturnType<Output['get']>,
  pools = createOutputPools(),
): ReturnType<Output['get']> {
  root.yogaNode?.calculateLayout(width, height)
  const output = createOutput(width, height, pools)
  renderNodeToOutput(root, output, { prevScreen })
  return output.get()
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

  test('leaves text intact when wrapped segment maps contain missing entries', () => {
    const segments: StyledSegment[] = [
      {
        hyperlink: 'https://example.test/known',
        styles: {},
        text: 'AC',
      },
    ]

    expect(
      applyStylesToWrappedText('ABCD', segments, [0, 9, 0, 8], 'ABCD', false),
    ).toBe(
      [
        link('A', 'https://example.test/known'),
        'B',
        link('C', 'https://example.test/known'),
        'D',
      ].join(''),
    )
  })

  test('truncated wrapped text does not mark terminal rows as soft wraps', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 1,
      width: 3,
    })

    const text = createNode('ink-text')
    applyNodeStyle(text, {
      textWrap: 'truncate',
      width: 3,
    })
    appendText(text, 'abcdef')
    appendChildNode(root, text)

    const screen = render(root, 3, 1)

    expect(charInCellAt(screen, 0, 0)).toBe('a')
    expect(screen.softWrap[0]).toBe(0)
  })

  test('offsets nested text children and keeps soft-wrap metadata aligned', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 3,
      width: 6,
    })

    const text = createNode('ink-text')
    applyNodeStyle(text, {
      width: 2,
    })

    const nested = createNode('ink-text')
    applyNodeStyle(nested, {
      marginLeft: 2,
      marginTop: 1,
      width: 4,
    })
    appendText(nested, 'ABCD')
    appendChildNode(text, nested)
    appendChildNode(root, text)

    const screen = render(root, 6, 3)

    expect(charInCellAt(screen, 0, 0)).toBe(' ')
    expect(charInCellAt(screen, 2, 1)).toBe('A')
    expect(charInCellAt(screen, 3, 1)).toBe('B')
    expect(charInCellAt(screen, 2, 2)).toBe('C')
    expect(screen.softWrap[0]).toBe(0)
    expect(screen.softWrap[2]).toBe(4)
  })

  test('wraps a single linked segment independently on each soft-wrapped row', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 2,
      width: 2,
    })

    const text = createNode('ink-text')
    applyNodeStyle(text, {
      width: 2,
    })

    const linkNode = createNode('ink-link')
    setAttribute(linkNode, 'href', 'https://example.test/single-segment')
    appendText(linkNode, 'ABCD')
    appendChildNode(text, linkNode)
    appendChildNode(root, text)

    const screen = render(root, 2, 2)

    expect(charInCellAt(screen, 0, 0)).toBe('A')
    expect(charInCellAt(screen, 1, 1)).toBe('D')
    expect(cellAt(screen, 0, 0)?.hyperlink).toBe(
      'https://example.test/single-segment',
    )
    expect(cellAt(screen, 1, 1)?.hyperlink).toBe(
      'https://example.test/single-segment',
    )
  })

  test('keeps hyperlinks on a single unwrapped linked segment', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 1,
      width: 4,
    })

    const text = createNode('ink-text')
    const linkNode = createNode('ink-link')
    setAttribute(linkNode, 'href', 'https://example.test/unwrapped')
    appendText(linkNode, 'AB')
    appendChildNode(text, linkNode)
    appendChildNode(root, text)

    const screen = render(root, 4, 1)

    expect(charInCellAt(screen, 0, 0)).toBe('A')
    expect(cellAt(screen, 1, 0)?.hyperlink).toBe(
      'https://example.test/unwrapped',
    )
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

  test('xterm small scroll drain clears completed deltas in one frame', () => {
    const previousTermProgram = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'vscode'
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

  test('zero pending scroll deltas are cleared without an anchor', () => {
    resetScrollHint()
    resetScrollDrainNode()

    const { root, scrollBox } = createScrollableTree({
      pendingScrollDelta: 0,
      scrollTop: 1,
    })

    renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

    expect(scrollBox.scrollTop).toBe(1)
    expect(scrollBox.pendingScrollDelta).toBeUndefined()
    expect(getScrollDrainNode()).toBeNull()
  })

  test('negative pending scroll deltas clamp at the top and consume remainder', () => {
    const previousTermProgram = process.env.TERM_PROGRAM
    delete process.env.TERM_PROGRAM
    resetScrollHint()
    resetScrollDrainNode()

    try {
      const { root, scrollBox } = createScrollableTree({
        pendingScrollDelta: -4,
        scrollTop: 0,
      })

      renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

      expect(scrollBox.scrollTop).toBe(0)
      expect(scrollBox.pendingScrollDelta).toBeUndefined()
      expect(getScrollDrainNode()).toBeNull()
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

  test('xterm negative scroll deltas move upward without leaving a drain frame', () => {
    const previousTermProgram = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'vscode'
    resetScrollHint()
    resetScrollDrainNode()

    try {
      const { root, scrollBox } = createScrollableTree({
        pendingScrollDelta: -2,
        scrollTop: 4,
      })

      renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

      expect(scrollBox.scrollTop).toBe(2)
      expect(scrollBox.pendingScrollDelta).toBeUndefined()
      expect(getScrollDrainNode()).toBeNull()
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

  test('xterm medium scroll deltas drain in bounded animation steps', () => {
    const previousTermProgram = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'vscode'
    resetScrollHint()
    resetScrollDrainNode()

    try {
      const { root, scrollBox } = createScrollableTree({
        pendingScrollDelta: 8,
        scrollTop: 0,
      })

      renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

      expect(scrollBox.scrollTop).toBe(2)
      expect(scrollBox.pendingScrollDelta).toBe(6)
      expect(getScrollDrainNode()).toBe(scrollBox)
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

  test('positional bottom follow restores an explicitly broken sticky flag', () => {
    resetScrollHint()
    resetScrollDrainNode()
    consumeFollowScroll()

    const { content, root, scrollBox } = createScrollableTree({
      scrollTop: 0,
    })
    renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

    const previousMaxScroll =
      (scrollBox.scrollHeight ?? 0) - (scrollBox.scrollViewportHeight ?? 0)
    scrollBox.scrollTop = previousMaxScroll
    scrollBox.stickyScroll = false
    appendLine(content, 'line-12')
    root.yogaNode?.calculateLayout(10, 4)

    renderNodeToOutput(root, createOutput(10, 4), { prevScreen: undefined })

    const nextMaxScroll =
      (scrollBox.scrollHeight ?? 0) - (scrollBox.scrollViewportHeight ?? 0)
    expect(scrollBox.scrollTop).toBe(nextMaxScroll)
    expect(scrollBox.stickyScroll).toBe(true)
    expect(consumeFollowScroll()).toEqual({
      delta: 1,
      viewportBottom: 2,
      viewportTop: 0,
    })
  })

  test('scrolling a stable viewport emits a DECSTBM scroll hint and shifts rows', () => {
    resetScrollHint()
    resetScrollDrainNode()

    const { root, scrollBox } = createScrollableTree({
      scrollTop: 0,
    })
    const pools = createOutputPools()
    const firstScreen = render(root, 10, 4, undefined, pools)
    expect(charInCellAt(firstScreen, 5, 0)).toBe('0')

    scrollBox.scrollTop = 1
    markDirty(scrollBox)
    const secondScreen = render(root, 10, 4, firstScreen, pools)

    expect(getScrollHint()).toEqual({ bottom: 2, delta: 1, top: 0 })
    expect(charInCellAt(secondScreen, 5, 0)).toBe('1')
    expect(charInCellAt(secondScreen, 5, 2)).toBe('3')
  })

  test('bottom appends use the dirty-child scroll fast path for the new edge row', () => {
    resetScrollHint()
    resetScrollDrainNode()

    const { content, root, scrollBox } = createScrollableTree({
      scrollTop: 0,
      stickyScroll: true,
    })
    const pools = createOutputPools()
    const firstScreen = render(root, 10, 4, undefined, pools)
    expect(scrollBox.scrollTop).toBe(9)

    appendLine(content, 'line-12')
    const secondScreen = render(root, 10, 4, firstScreen, pools)

    expect(getScrollHint()).toEqual({ bottom: 2, delta: 1, top: 0 })
    expect(charInCellAt(secondScreen, 5, 2)).toBe('1')
    expect(charInCellAt(secondScreen, 6, 2)).toBe('2')
  })

  test('unsafe height changes clear scroll hints and fall back to full repaint', () => {
    resetScrollHint()
    resetScrollDrainNode()

    const { content, root, scrollBox } = createScrollableTree({
      scrollTop: 0,
    })
    const pools = createOutputPools()
    const firstScreen = render(root, 10, 4, undefined, pools)

    scrollBox.scrollTop = 1
    appendLine(content, 'line-12')
    appendLine(content, 'line-13')
    const secondScreen = render(root, 10, 4, firstScreen, pools)

    expect(getScrollHint()).toBeNull()
    expect(charInCellAt(secondScreen, 5, 0)).toBe('1')
    expect(charInCellAt(secondScreen, 5, 2)).toBe('3')
  })

  test('malformed children are skipped in normal and scrolled child paths', () => {
    resetScrollHint()
    resetScrollDrainNode()

    const { content, root } = createScrollableTree({
      scrollTop: 0,
    })
    root.childNodes.push(null as unknown as DOMNode)
    content.childNodes.unshift(null as unknown as DOMNode)
    markDirty(root)

    const screen = render(root, 10, 4)

    expect(charInCellAt(screen, 0, 0)).toBe('l')
    expect(cellAt(screen, 5, 0)?.char).toBeDefined()
  })

  test('removed children clear cached rows before siblings blit from the previous screen', () => {
    resetScrollHint()
    resetScrollDrainNode()

    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 2,
      width: 8,
    })
    const first = createNode('ink-text')
    appendText(first, 'remove')
    const second = createNode('ink-text')
    appendText(second, 'stay')
    appendChildNode(root, first)
    appendChildNode(root, second)

    const pools = createOutputPools()
    const firstScreen = render(root, 8, 2, undefined, pools)
    expect(charInCellAt(firstScreen, 0, 0)).toBe('r')

    removeChildNode(root, first)
    const secondScreen = render(root, 8, 2, firstScreen, pools)

    expect(charInCellAt(secondScreen, 0, 0)).toBe('s')
    expect(charInCellAt(secondScreen, 0, 1)).toBe(' ')
  })

  test('zero-height siblings sharing a row are skipped to avoid stale tail cells', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 1,
      width: 6,
    })

    const squeezed = createNode('ink-text')
    applyNodeStyle(squeezed, {
      height: 0,
      width: 6,
    })
    appendText(squeezed, 'false')

    const visible = createNode('ink-text')
    appendText(visible, 'true')

    appendChildNode(root, squeezed)
    appendChildNode(root, visible)

    const screen = render(root, 6, 1)

    expect(charInCellAt(screen, 0, 0)).toBe('t')
    expect(charInCellAt(screen, 3, 0)).toBe('e')
    expect(charInCellAt(screen, 4, 0)).toBe(' ')
  })

  test('zero-height absolute tail siblings also compare against previous rows', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 1,
      width: 6,
    })

    const visible = createNode('ink-text')
    appendText(visible, 'true')

    const squeezed = createNode('ink-text')
    applyNodeStyle(squeezed, {
      height: 0,
      position: 'absolute',
      top: 0,
      width: 6,
    })
    appendText(squeezed, 'false')

    appendChildNode(root, visible)
    appendChildNode(root, squeezed)

    const screen = render(root, 6, 1)

    expect(charInCellAt(screen, 0, 0)).toBe('t')
    expect(charInCellAt(screen, 4, 0)).toBe(' ')
  })

  test('hiding a cached subtree drops descendant caches recursively', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 2,
      width: 6,
    })

    const box = createNode('ink-box')
    applyNodeStyle(box, {
      flexDirection: 'column',
      height: 1,
      width: 6,
    })
    const nested = createNode('ink-text')
    appendText(nested, 'child')
    appendChildNode(box, nested)
    appendChildNode(root, box)

    const pools = createOutputPools()
    const firstScreen = render(root, 6, 2, undefined, pools)
    expect(charInCellAt(firstScreen, 0, 0)).toBe('c')

    applyNodeStyle(box, {
      display: 'none',
    })
    markDirty(box)
    const hiddenScreen = render(root, 6, 2, firstScreen, pools)
    expect(charInCellAt(hiddenScreen, 0, 0)).toBe(' ')

    applyNodeStyle(box, {
      display: 'flex',
    })
    markDirty(box)
    const restoredScreen = render(root, 6, 2, hiddenScreen, pools)
    expect(charInCellAt(restoredScreen, 0, 0)).toBe('c')
  })

  test('clean blits also restore absolute descendants that escape parent bounds', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 3,
      width: 8,
    })

    const host = createNode('ink-box')
    applyNodeStyle(host, {
      height: 1,
      marginTop: 1,
      width: 2,
    })

    const overlay = createNode('ink-box')
    applyNodeStyle(overlay, {
      height: 1,
      position: 'absolute',
      top: -1,
      width: 4,
    })
    const overlayText = createNode('ink-text')
    appendText(overlayText, 'MENU')
    appendChildNode(overlay, overlayText)
    appendChildNode(host, overlay)

    const dirtySibling = createNode('ink-text')
    appendText(dirtySibling, 'old')

    appendChildNode(root, host)
    appendChildNode(root, dirtySibling)

    const pools = createOutputPools()
    const firstScreen = render(root, 8, 3, undefined, pools)
    expect(charInCellAt(firstScreen, 0, 0)).toBe('M')

    appendText(dirtySibling, '!')
    const secondScreen = render(root, 8, 3, firstScreen, pools)

    expect(charInCellAt(secondScreen, 0, 0)).toBe('M')
    expect(charInCellAt(secondScreen, 3, 0)).toBe('U')
    expect(charInCellAt(secondScreen, 3, 2)).toBe('!')
  })

  test('clean absolute nodes are tracked when they blit their cached rectangle', () => {
    const root = createNode('ink-root')
    applyNodeStyle(root, {
      flexDirection: 'column',
      height: 2,
      width: 8,
    })

    const overlay = createNode('ink-box')
    applyNodeStyle(overlay, {
      height: 1,
      position: 'absolute',
      top: 0,
      width: 4,
    })
    const overlayText = createNode('ink-text')
    appendText(overlayText, 'ABCD')
    appendChildNode(overlay, overlayText)

    const dirtySibling = createNode('ink-text')
    appendText(dirtySibling, 'old')

    appendChildNode(root, dirtySibling)
    appendChildNode(root, overlay)

    const pools = createOutputPools()
    const firstScreen = render(root, 8, 2, undefined, pools)
    expect(charInCellAt(firstScreen, 0, 0)).toBe('A')

    appendText(dirtySibling, '!')
    const secondScreen = render(root, 8, 2, firstScreen, pools)

    expect(charInCellAt(secondScreen, 0, 0)).toBe('A')
    expect(charInCellAt(secondScreen, 3, 0)).toBe('D')
  })
})
