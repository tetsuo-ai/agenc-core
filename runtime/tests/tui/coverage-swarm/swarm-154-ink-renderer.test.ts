import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { DOMElement } from '../../../src/tui/ink/dom.js'
import type { Frame } from '../../../src/tui/ink/frame.js'
import { addPendingClear } from '../../../src/tui/ink/node-cache.js'
import createRenderer, {
  type RenderOptions,
} from '../../../src/tui/ink/renderer.js'
import {
  charInCellAt,
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
} from '../../../src/tui/ink/screen.js'

const mocks = vi.hoisted(() => ({
  getScrollDrainNode: vi.fn(),
  getScrollHint: vi.fn(),
  logForDebugging: vi.fn(),
  renderNodeToOutput: vi.fn(),
  resetLayoutShifted: vi.fn(),
  resetScrollDrainNode: vi.fn(),
  resetScrollHint: vi.fn(),
}))

vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: mocks.logForDebugging,
}))

vi.mock('../../../src/tui/ink/render-node-to-output.js', () => ({
  default: mocks.renderNodeToOutput,
  getScrollDrainNode: mocks.getScrollDrainNode,
  getScrollHint: mocks.getScrollHint,
  resetLayoutShifted: mocks.resetLayoutShifted,
  resetScrollDrainNode: mocks.resetScrollDrainNode,
  resetScrollHint: mocks.resetScrollHint,
}))

type Pools = {
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
  stylePool: StylePool
}

function makePools(): Pools {
  return {
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
    stylePool: new StylePool(),
  }
}

function makeFrame(
  width: number,
  height: number,
  pools: Pools = makePools(),
): Frame {
  return {
    cursor: { visible: true, x: 0, y: 0 },
    screen: createScreen(
      width,
      height,
      pools.stylePool,
      pools.charPool,
      pools.hyperlinkPool,
    ),
    viewport: { height, width },
  }
}

function makeOptions(
  pools: Pools,
  overrides: Partial<RenderOptions> = {},
): RenderOptions {
  return {
    altScreen: false,
    backFrame: makeFrame(8, 4, pools),
    frontFrame: makeFrame(8, 4, pools),
    isTTY: true,
    prevFrameContaminated: false,
    terminalRows: 4,
    terminalWidth: 8,
    ...overrides,
  }
}

function makeNode(width: number, height: number): DOMElement {
  return {
    attributes: {},
    childNodes: [],
    dirty: false,
    nodeName: 'ink-root',
    parentNode: undefined,
    style: {},
    yogaNode: {
      getComputedHeight: vi.fn(() => height),
      getComputedWidth: vi.fn(() => width),
    } as unknown as DOMElement['yogaNode'],
  }
}

function makeNodeWithoutYoga(): DOMElement {
  return {
    attributes: {},
    childNodes: [],
    dirty: false,
    nodeName: 'ink-root',
    parentNode: undefined,
    style: {},
  }
}

describe('createRenderer coverage swarm row 154', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getScrollDrainNode.mockReturnValue(null)
    mocks.getScrollHint.mockReturnValue(null)
    mocks.renderNodeToOutput.mockImplementation((_node, output) => {
      output.write(0, 0, 'A')
    })
  })

  test('returns an empty frame for missing or invalid yoga dimensions', () => {
    const pools = makePools()
    const missingYogaRenderer = createRenderer(
      makeNodeWithoutYoga(),
      pools.stylePool,
    )

    const missingYogaFrame = missingYogaRenderer(makeOptions(pools))

    expect(missingYogaFrame.screen.width).toBe(8)
    expect(missingYogaFrame.screen.height).toBe(0)
    expect(missingYogaFrame.viewport).toEqual({ width: 8, height: 4 })
    expect(missingYogaFrame.cursor).toEqual({ x: 0, y: 0, visible: true })
    expect(mocks.renderNodeToOutput).not.toHaveBeenCalled()
    expect(mocks.logForDebugging).not.toHaveBeenCalled()

    const invalidRenderer = createRenderer(
      makeNode(Number.POSITIVE_INFINITY, -1),
      pools.stylePool,
    )

    const invalidFrame = invalidRenderer(makeOptions(pools))

    expect(invalidFrame.screen.width).toBe(8)
    expect(invalidFrame.screen.height).toBe(0)
    expect(mocks.renderNodeToOutput).not.toHaveBeenCalled()
    expect(mocks.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('Invalid yoga dimensions'),
    )
  })

  test('renders a scrollback frame and reuses the output on the next frame', () => {
    const pools = makePools()
    const node = makeNode(5, 2)
    const renderer = createRenderer(node, pools.stylePool)
    const options = makeOptions(pools, {
      isTTY: false,
      terminalRows: 10,
      terminalWidth: 12,
    })

    const firstFrame = renderer(options)
    expect(firstFrame.screen.width).toBe(5)
    expect(firstFrame.screen.height).toBe(2)
    expect(charInCellAt(firstFrame.screen, 0, 0)).toBe('A')
    expect(firstFrame.viewport).toEqual({ width: 12, height: 10 })
    expect(firstFrame.cursor).toEqual({ x: 0, y: 2, visible: true })
    expect(firstFrame.scrollHint).toBeNull()
    expect(firstFrame.scrollDrainPending).toBe(false)

    mocks.renderNodeToOutput.mockImplementationOnce((_node, output) => {
      output.write(0, 0, 'B')
    })
    const secondFrame = renderer(options)

    expect(secondFrame.screen.width).toBe(5)
    expect(secondFrame.screen.height).toBe(2)
    expect(charInCellAt(secondFrame.screen, 0, 0)).toBe('B')
    expect(mocks.renderNodeToOutput).toHaveBeenCalledTimes(2)
    expect(mocks.renderNodeToOutput).toHaveBeenNthCalledWith(
      1,
      node,
      expect.anything(),
      { prevScreen: options.frontFrame.screen },
    )
    expect(mocks.resetLayoutShifted).toHaveBeenCalledTimes(2)
    expect(mocks.resetScrollHint).toHaveBeenCalledTimes(2)
    expect(mocks.resetScrollDrainNode).toHaveBeenCalledTimes(2)
  })

  test('disables previous-screen blits after contamination or absolute removals', () => {
    const pools = makePools()
    const node = makeNode(5, 2)
    const renderer = createRenderer(node, pools.stylePool)

    renderer(makeOptions(pools, { prevFrameContaminated: true }))

    expect(mocks.renderNodeToOutput).toHaveBeenLastCalledWith(
      node,
      expect.anything(),
      { prevScreen: undefined },
    )

    addPendingClear(node, { height: 1, width: 1, x: 0, y: 0 }, true)
    renderer(makeOptions(pools, { prevFrameContaminated: false }))

    expect(mocks.renderNodeToOutput).toHaveBeenLastCalledWith(
      node,
      expect.anything(),
      { prevScreen: undefined },
    )
  })

  test('clips oversized alt-screen output and marks scroll drains dirty', () => {
    const pools = makePools()
    const node = makeNode(6, 5)
    const drainNode = makeNode(1, 1)
    const scrollHint = { bottom: 3, top: 1 }
    const renderer = createRenderer(node, pools.stylePool)

    mocks.getScrollDrainNode.mockReturnValue(drainNode)
    mocks.getScrollHint.mockReturnValue(scrollHint)

    const frame = renderer(
      makeOptions(pools, {
        altScreen: true,
        terminalRows: 3,
        terminalWidth: 10,
      }),
    )

    expect(frame.screen.width).toBe(6)
    expect(frame.screen.height).toBe(3)
    expect(frame.viewport).toEqual({ width: 10, height: 4 })
    expect(frame.cursor).toEqual({ x: 0, y: 2, visible: false })
    expect(frame.scrollHint).toBe(scrollHint)
    expect(frame.scrollDrainPending).toBe(true)
    expect(drainNode.dirty).toBe(true)
    expect(mocks.logForDebugging).toHaveBeenCalledWith(
      expect.stringContaining('alt-screen: yoga height 5 > terminalRows 3'),
      { level: 'warn' },
    )
  })
})
