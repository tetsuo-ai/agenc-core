import { PassThrough } from 'node:stream'

import chalk from 'chalk'
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type Ink from './ink.tsx'
import { drainStdin } from './ink.tsx'
import * as dom from './dom.ts'
import type { DOMElement, ElementNames } from './dom.ts'
import type { Diff, Frame } from './frame.ts'
import instances from './instances.ts'
import reconciler from './reconciler.ts'
import { createRoot, type Root } from './root.ts'
import { CURSOR_HOME, ERASE_SCREEN, cursorPosition } from './termio/csi.ts'
import {
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from './termio/dec.ts'

const fsMock = vi.hoisted(() => ({
  closeSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  writeSync: vi.fn(),
}))

const logMock = vi.hoisted(() => ({
  logError: vi.fn(),
}))

const coverageState = vi.hoisted(() => ({
  clipboardRaw: '',
  debugRepaints: false,
  extendedKeys: false,
  follow: null as null | {
    delta: number
    viewportTop: number
    viewportBottom: number
  },
  layoutShift: false,
  supportsTabStatus: false,
}))

const debugMock = vi.hoisted(() => ({
  logForDebugging: vi.fn((message: string) => {
    if (message.startsWith('[stderr]')) {
      process.stderr.write(Buffer.from('nested stderr'), 'utf8', () => {})
      process.stderr.write('nested callback stderr', () => {})
    }
  }),
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    closeSync: fsMock.closeSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    writeSync: fsMock.writeSync,
  }
})

vi.mock('../../utils/debug.js', () => ({
  logForDebugging: debugMock.logForDebugging,
}))

vi.mock('../../utils/log.js', () => ({
  logError: logMock.logError,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

vi.mock('./reconciler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reconciler.ts')>()
  return {
    ...actual,
    isDebugRepaintsEnabled: () => coverageState.debugRepaints,
  }
})

vi.mock('./render-node-to-output.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./render-node-to-output.ts')>()
  return {
    ...actual,
    consumeFollowScroll: () => coverageState.follow,
    didLayoutShift: () => coverageState.layoutShift,
  }
})

vi.mock('./terminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./terminal.ts')>()
  return {
    ...actual,
    supportsExtendedKeys: () => coverageState.extendedKeys,
  }
})

vi.mock('./termio/osc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./termio/osc.ts')>()
  return {
    ...actual,
    setClipboard: vi.fn(async () => coverageState.clipboardRaw),
    supportsTabStatus: () => coverageState.supportsTabStatus,
  }
})

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type TestStdin = PassThrough & {
  isTTY: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

type InkInternals = Ink & {
  altScreenActive: boolean
  altScreenMouseTracking: boolean
  backFrame: Frame
  charPool: unknown
  cursorDeclaration: unknown
  displayCursor: { x: number; y: number } | null
  drainTimer: ReturnType<typeof setTimeout> | null
  frontFrame: Frame
  handleResume: () => void
  hyperlinkPool: unknown
  isPaused: boolean
  isUnmounted: boolean
  lastPoolResetTime: number
  log: {
    render: (prev: Frame, next: Frame) => Diff
    reset: () => void
  }
  onRender: () => void
  prevFrameContaminated: boolean
  renderer: () => Frame
  reportRenderError: (label: string, error: unknown) => void
  rootNode: DOMElement
  setCursorDeclaration: (decl: unknown, clearIfNode?: DOMElement) => void
  stylePool: unknown
}

const RAW_TEXT_STYLE = {
  flexDirection: 'row',
  flexGrow: 0,
  flexShrink: 1,
  textWrap: 'wrap',
} as const

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalProcessStderrWrite = process.stderr.write

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function textNode(
  children: React.ReactNode,
  style: Record<string, unknown> = {},
): React.ReactElement {
  return React.createElement(
    'ink-text',
    {
      style: {
        ...RAW_TEXT_STYLE,
        ...style,
      },
    },
    children,
  )
}

function createTestStreams(
  options: {
    columns?: number
    rows?: number
    stdoutIsTTY?: boolean
    stdinIsTTY?: boolean
    stdinIsRaw?: boolean
  } = {},
): {
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
  rawModes: boolean[]
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin
  const stderr = new PassThrough()
  const stdoutWrites: string[] = []
  const rawModes: boolean[] = []

  stdout.columns = options.columns ?? 40
  stdout.rows = options.rows ?? 8
  stdout.isTTY = options.stdoutIsTTY ?? true
  stdout.on('data', (chunk) => {
    stdoutWrites.push(Buffer.from(chunk).toString('utf8'))
  })

  stdin.isTTY = options.stdinIsTTY ?? true
  stdin.isRaw = options.stdinIsRaw ?? false
  stdin.setRawMode = (mode: boolean) => {
    rawModes.push(mode)
    stdin.isRaw = mode
  }
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, stderr, stdoutWrites, rawModes }
}

function getInkInstance(stdout: PassThrough): InkInternals {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance) throw new Error('Ink instance not found')
  return instance as InkInternals
}

function findElement(
  node: DOMElement,
  nodeName: ElementNames,
): DOMElement | undefined {
  if (node.nodeName === nodeName) return node

  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    const found = findElement(child, nodeName)
    if (found) return found
  }

  return undefined
}

function requireElement(
  stdout: PassThrough,
  nodeName: ElementNames,
): DOMElement {
  const { rootNode } = getInkInstance(stdout)
  const found = findElement(rootNode, nodeName)
  if (!found) throw new Error(`Element ${nodeName} not found`)
  return found
}

async function createHarness(
  options: {
    columns?: number
    rows?: number
    stdoutIsTTY?: boolean
    stdinIsTTY?: boolean
    stdinIsRaw?: boolean
    patchConsole?: boolean
    onFrame?: (event: unknown) => void
  } = {},
): Promise<{
  root: Root
  instance: InkInternals
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
  rawModes: boolean[]
  dispose: () => Promise<void>
}> {
  const { stdout, stdin, stderr, stdoutWrites, rawModes } =
    createTestStreams(options)
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    patchConsole: options.patchConsole ?? false,
    onFrame: options.onFrame as never,
  })
  const instance = getInkInstance(stdout)

  return {
    root,
    instance,
    stdout,
    stdin,
    stderr,
    stdoutWrites,
    rawModes,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
      await sleep(25)
    },
  }
}

beforeEach(() => {
  coverageState.clipboardRaw = ''
  coverageState.debugRepaints = false
  coverageState.extendedKeys = false
  coverageState.follow = null
  coverageState.layoutShift = false
  coverageState.supportsTabStatus = false
  debugMock.logForDebugging.mockClear()
  fsMock.closeSync.mockReset()
  fsMock.openSync.mockReset()
  fsMock.readSync.mockReset()
  fsMock.writeSync.mockReset()
  logMock.logError.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  process.stderr.write = originalProcessStderrWrite
  vi.restoreAllMocks()
})

describe('Ink render branch coverage', () => {
  test('translates follow-scroll selections, schedules drain frames, and reports debug repaint attribution', async () => {
    const onFrame = vi.fn()
    const harness = await createHarness({
      columns: 24,
      rows: 5,
      onFrame,
    })

    try {
      harness.instance.setAltScreenActive(true, true)
      harness.root.render(textNode('alpha beta gamma'))
      await sleep(10)

      const selectionCallbacks: string[] = []
      const unsubscribe = harness.instance.subscribeToSelectionChange(() => {
        selectionCallbacks.push('changed')
      })

      harness.instance.selection.anchor = { col: 0, row: 2 }
      harness.instance.selection.focus = { col: 5, row: 2 }
      harness.instance.selection.isDragging = true
      coverageState.follow = {
        delta: 1,
        viewportBottom: 4,
        viewportTop: 1,
      }
      harness.instance.onRender()
      expect(harness.instance.selection.anchor?.row).toBe(1)

      harness.instance.selection.anchor = { col: 0, row: 2 }
      harness.instance.selection.focus = { col: 5, row: 2 }
      harness.instance.selection.isDragging = false
      coverageState.follow = {
        delta: 8,
        viewportBottom: 4,
        viewportTop: 1,
      }
      harness.instance.onRender()
      expect(harness.instance.hasTextSelection()).toBe(false)
      expect(selectionCallbacks).toEqual(['changed'])

      harness.instance.selection.anchor = { col: 0, row: 2 }
      harness.instance.selection.focus = { col: 0, row: 7 }
      harness.instance.selection.isDragging = false
      coverageState.follow = {
        delta: 1,
        viewportBottom: 4,
        viewportTop: 1,
      }
      harness.instance.onRender()
      expect(harness.instance.selection.anchor).toEqual({ col: 0, row: 2 })

      harness.instance.selection.anchor = { col: 0, row: 0 }
      harness.instance.selection.focus = { col: 1, row: 0 }
      coverageState.follow = {
        delta: 1,
        viewportBottom: 4,
        viewportTop: 1,
      }
      harness.instance.onRender()
      expect(harness.instance.selection.anchor).toEqual({ col: 0, row: 0 })

      coverageState.follow = null
      coverageState.layoutShift = true
      harness.instance.onRender()
      coverageState.layoutShift = false

      const textElement = requireElement(harness.stdout, 'ink-text')
      harness.instance.setSearchHighlight('alpha')
      harness.instance.setSearchPositions({
        currentIdx: 0,
        positions: [{ col: 0, len: 5, row: 0 }],
        rowOffset: 0,
      })
      harness.instance.onRender()
      harness.instance.setSearchPositions(null)
      harness.instance.setSearchHighlight('')
      harness.instance.setSearchPositions({
        currentIdx: 0,
        positions: [],
        rowOffset: 0,
      })
      harness.instance.onRender()
      harness.instance.setSearchPositions(null)

      harness.instance.cursorDeclaration = {
        node: textElement,
        relativeX: 0,
        relativeY: 0,
      }
      harness.stdoutWrites.length = 0
      harness.instance.onRender()
      expect(harness.stdoutWrites.join('')).toContain(cursorPosition(1, 1))

      harness.instance.cursorDeclaration = null
      harness.instance.setAltScreenActive(false)
      harness.instance.displayCursor = { x: 0, y: 0 }
      const zeroCursorFrame = {
        ...harness.instance.frontFrame,
        cursor: { x: 0, y: 0, visible: true },
      }
      harness.instance.renderer = () => zeroCursorFrame
      harness.instance.log.render = () => [{ type: 'stdout', content: 'q' }]
      harness.stdoutWrites.length = 0
      harness.instance.onRender()
      expect(harness.stdoutWrites.join('')).toContain('q')

      harness.instance.displayCursor = { x: 2, y: 2 }
      const mainFrame = {
        ...harness.instance.frontFrame,
        cursor: { x: 5, y: 3, visible: true },
      }
      harness.instance.renderer = () => mainFrame
      harness.instance.log.render = () => [{ type: 'stdout', content: 'z' }]
      harness.stdoutWrites.length = 0
      harness.instance.onRender()
      expect(harness.stdoutWrites.join('')).toContain('z')

      harness.instance.displayCursor = { x: 2, y: 2 }
      harness.instance.renderer = () => mainFrame
      harness.instance.log.render = () => []
      harness.stdoutWrites.length = 0
      harness.instance.onRender()
      expect(harness.stdoutWrites.join('')).toContain('\x1b[3C\x1b[1B')

      harness.instance.displayCursor = { x: 0, y: 0 }
      harness.instance.renderer = () => zeroCursorFrame
      harness.instance.log.render = () => []
      harness.stdoutWrites.length = 0
      harness.instance.onRender()
      expect(harness.stdoutWrites.join('')).not.toContain('\x1b[')

      harness.instance.cursorDeclaration = {
        node: textElement,
        relativeX: 0,
        relativeY: 0,
      }
      harness.instance.displayCursor = { x: 1, y: 1 }
      harness.instance.renderer = () => zeroCursorFrame
      harness.instance.log.render = () => []
      harness.instance.onRender()

      harness.instance.displayCursor = { x: 0, y: 0 }
      harness.instance.onRender()

      harness.instance.displayCursor = null
      harness.instance.log.render = () => [{ type: 'stdout', content: 't' }]
      harness.instance.onRender()
      harness.instance.cursorDeclaration = null

      const drainFrame = {
        ...harness.instance.frontFrame,
        scrollDrainPending: true,
      }
      harness.instance.renderer = () => drainFrame
      harness.instance.log.render = () => [{ type: 'stdout', content: 'x' }]
      vi.useFakeTimers()
      harness.instance.onRender()
      expect(harness.instance.drainTimer).not.toBeNull()

      harness.instance.renderer = () => ({
        ...harness.instance.frontFrame,
        scrollDrainPending: false,
      })
      harness.instance.log.render = () => []
      await vi.advanceTimersByTimeAsync(10)
      expect(harness.instance.drainTimer).toBeNull()
      vi.useRealTimers()

      harness.instance.selection.anchor = { col: 0, row: 2 }
      harness.instance.selection.focus = null
      harness.instance.selection.isDragging = true
      coverageState.follow = {
        delta: 1,
        viewportBottom: 4,
        viewportTop: 1,
      }
      harness.instance.onRender()

      harness.instance.selection.anchor = { col: 0, row: 2 }
      harness.instance.selection.focus = null
      harness.instance.selection.isDragging = false
      harness.instance.onRender()

      harness.instance.selection.anchor = { col: 0, row: 2 }
      harness.instance.selection.focus = { col: 1, row: 2 }
      harness.instance.selection.isDragging = false
      harness.instance.onRender()
      coverageState.follow = null

      const resetPools = vi.spyOn(harness.instance, 'resetPools')
      harness.instance.lastPoolResetTime = performance.now() - 301_000
      harness.instance.onRender()
      expect(resetPools).toHaveBeenCalledOnce()

      const ownerChain = vi
        .spyOn(dom, 'findOwnerChainAtRow')
        .mockReturnValueOnce([])
        .mockReturnValueOnce(['Owner'])
      coverageState.debugRepaints = true
      harness.instance.log.render = () => [
        {
          type: 'clearTerminal',
          reason: 'resize',
          debug: {
            nextLine: 'next',
            prevLine: 'prev',
            triggerY: 0,
          },
        },
      ]
      harness.instance.onRender()
      harness.instance.onRender()
      expect(ownerChain).toHaveBeenCalledTimes(2)
      expect(
        debugMock.logForDebugging.mock.calls.some((call) =>
          String(call[0]).includes('(no owner chain captured)'),
        ),
      ).toBe(true)
      expect(
        debugMock.logForDebugging.mock.calls.some((call) =>
          String(call[0]).includes('Owner'),
        ),
      ).toBe(true)

      unsubscribe()
    } finally {
      await harness.dispose()
    }
  })
})

describe('Ink terminal-mode and selection edge coverage', () => {
  test('covers external handoff, reassertion, redraw, and resize guard paths', async () => {
    coverageState.extendedKeys = true
    const harness = await createHarness({ columns: 20, rows: 5 })

    try {
      harness.root.render(textNode('terminal modes'))
      await sleep(10)

      harness.instance.enterAlternateScreen()
      harness.stdoutWrites.length = 0
      harness.instance.exitAlternateScreen()
      expect(harness.stdoutWrites.join('')).toContain('\x1b[?1004h')
      expect(harness.stdoutWrites.join('')).toContain('\x1b[>1u')

      harness.instance.setAltScreenActive(true, false)
      harness.instance.enterAlternateScreen()
      harness.stdoutWrites.length = 0
      harness.instance.exitAlternateScreen()
      expect(harness.stdoutWrites.join('')).toContain(ENTER_ALT_SCREEN)
      expect(harness.stdoutWrites.join('')).not.toContain(ENABLE_MOUSE_TRACKING)

      harness.instance.setAltScreenActive(false)
      harness.instance.setAltScreenActive(true, true)
      harness.instance.altScreenMouseTracking = true
      harness.instance.enterAlternateScreen()
      harness.stdoutWrites.length = 0
      coverageState.extendedKeys = false
      harness.instance.exitAlternateScreen()
      expect(harness.stdoutWrites.join('')).toContain(ENABLE_MOUSE_TRACKING)
      expect(harness.stdoutWrites.join('')).not.toContain('\x1b[>1u')
      coverageState.extendedKeys = true

      harness.instance.pause()
      harness.stdoutWrites.length = 0
      harness.instance.reassertTerminalModes()
      expect(harness.stdoutWrites.join('')).toBe('')
      harness.instance.resume()

      harness.instance.setAltScreenActive(false)
      harness.stdoutWrites.length = 0
      harness.instance.reassertTerminalModes()
      expect(harness.stdoutWrites.join('')).toContain('\x1b[>1u')

      harness.instance.setAltScreenActive(true, false)
      harness.stdoutWrites.length = 0
      harness.instance.reassertTerminalModes(true)
      expect(harness.stdoutWrites.join('')).toContain(
        ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME,
      )
      expect(harness.stdoutWrites.join('')).not.toContain(ENABLE_MOUSE_TRACKING)

      const frameBeforeNoop = harness.instance.frontFrame
      harness.instance.setAltScreenActive(true, true)
      expect(harness.instance.frontFrame).toBe(frameBeforeNoop)

      harness.instance.invalidatePrevFrame()
      expect(harness.instance.prevFrameContaminated).toBe(true)

      harness.instance.setAltScreenActive(false)
      harness.stdoutWrites.length = 0
      harness.instance.forceRedraw()
      expect(harness.stdoutWrites.join('')).toContain(
        ERASE_SCREEN + CURSOR_HOME,
      )

      harness.instance.displayCursor = { x: 1, y: 1 }
      harness.stdoutWrites.length = 0
      harness.instance.handleResume()
      expect(harness.instance.displayCursor).toBeNull()

      harness.instance.setAltScreenActive(true, false)
      harness.stdoutWrites.length = 0
      harness.instance.handleResume()
      expect(harness.stdoutWrites.join('')).toContain(
        ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME,
      )

      harness.stdout.columns = 0
      harness.stdout.rows = 0
      harness.stdout.emit('resize')
      await sleep(10)
      expect(harness.instance.frontFrame.viewport.width).toBe(80)
      expect(harness.instance.frontFrame.viewport.height).toBe(25)

      harness.instance.setAltScreenActive(true, false)
      harness.instance.pause()
      harness.stdout.columns = 90
      harness.stdout.rows = 10
      harness.stdout.emit('resize')
      await sleep(10)
      harness.instance.resume()
    } finally {
      await harness.dispose()
    }

    const nonTty = await createHarness({ stdoutIsTTY: false })
    try {
      nonTty.stdoutWrites.length = 0
      nonTty.instance.forceRedraw()
      expect(nonTty.stdoutWrites.join('')).toBe('')
    } finally {
      await nonTty.dispose()
    }

    const noCurrentNode = await createHarness({ columns: 20, rows: 5 })
    try {
      noCurrentNode.stdout.columns = 30
      noCurrentNode.stdout.rows = 6
      noCurrentNode.stdout.emit('resize')
      await sleep(10)
      expect(noCurrentNode.instance.frontFrame.viewport.width).toBe(20)
    } finally {
      await noCurrentNode.dispose()
    }
  })

  test('covers selection, hover, keyboard, hyperlink, and stdin edge guards', async () => {
    const harness = await createHarness({ columns: 12, rows: 4 })
    const opened: string[] = []
    const selectionNotifications: string[] = []

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta'))
      await sleep(10)

      expect(harness.instance.copySelection()).toBe('')
      harness.instance.selection.anchor = { col: 0, row: 3 }
      harness.instance.selection.focus = { col: 0, row: 3 }
      expect(harness.instance.copySelectionNoClear()).toBe('')
      harness.instance.clearTextSelection()

      const oldChalkLevel = chalk.level
      chalk.level = 1
      try {
        harness.instance.setSelectionBgColor('ansi:red')
      } finally {
        chalk.level = oldChalkLevel
      }
      harness.instance.setSelectionBgColor('not-a-real-color')

      harness.instance.setSearchHighlight('alpha')
      expect(
        harness.instance.scanElementSubtree({
          yogaNode: {
            getComputedHeight: () => 1,
            getComputedWidth: () => 0,
          },
        } as DOMElement),
      ).toEqual([])
      harness.root.render(textNode('alpha '.repeat(12)))
      await sleep(10)
      const scanElement = requireElement(harness.stdout, 'ink-text')
      expect(harness.instance.scanElementSubtree(scanElement).length).toBe(12)

      const unsubscribe = harness.instance.subscribeToSelectionChange(() => {
        selectionNotifications.push('changed')
      })
      harness.instance.selection.anchor = { col: 0, row: 1 }
      harness.instance.selection.focus = { col: 4, row: 1 }
      harness.instance.clearTextSelection()
      expect(selectionNotifications).toEqual(['changed'])

      harness.instance.selection.anchor = { col: 0, row: 1 }
      harness.instance.selection.focus = { col: 4, row: 1 }
      harness.instance.captureScrolledRows(0, 0, 'above')
      harness.instance.shiftSelectionForScroll(-10, 0, 3)
      expect(harness.instance.hasTextSelection()).toBe(false)
      expect(selectionNotifications).toEqual(['changed', 'changed'])

      harness.instance.shiftSelectionForScroll(1, 0, 3)
      expect(selectionNotifications).toEqual(['changed', 'changed'])

      harness.instance.pause()
      harness.instance.selection.anchor = { col: 0, row: 1 }
      harness.instance.selection.focus = { col: 4, row: 1 }
      harness.instance.shiftSelectionForScroll(1, 0, 3)
      harness.instance.dispatchHover(0, 0)
      harness.instance.dispatchKeyboardEvent({ name: 'tab' } as never)
      harness.instance.onHyperlinkClick = (url) => opened.push(url)
      harness.instance.openHyperlink('https://paused.test')
      expect(opened).toEqual([])
      harness.instance.resume()

      harness.instance.selection.anchor = { col: 0, row: 0 }
      harness.instance.selection.focus = null
      harness.instance.moveSelectionFocus('left')
      expect(harness.instance.selection.focus).toBeNull()

      harness.instance.selection.focus = { col: 0, row: 1 }
      harness.instance.moveSelectionFocus('left')
      expect(harness.instance.selection.focus).toEqual({ col: 11, row: 0 })

      harness.instance.selection.focus = { col: 3, row: 0 }
      harness.instance.moveSelectionFocus('left')
      expect(harness.instance.selection.focus).toEqual({ col: 2, row: 0 })

      harness.instance.selection.focus = { col: 11, row: 0 }
      harness.instance.moveSelectionFocus('right')
      expect(harness.instance.selection.focus).toEqual({ col: 0, row: 1 })

      harness.instance.selection.focus = { col: 2, row: 0 }
      harness.instance.moveSelectionFocus('right')
      expect(harness.instance.selection.focus).toEqual({ col: 3, row: 0 })

      harness.instance.selection.focus = { col: 11, row: 3 }
      const rightBoundaryFocus = harness.instance.selection.focus
      harness.instance.moveSelectionFocus('right')
      expect(harness.instance.selection.focus).toBe(rightBoundaryFocus)

      harness.instance.selection.focus = { col: 0, row: 0 }
      const beforeBoundaryMove = harness.instance.selection.focus
      harness.instance.moveSelectionFocus('left')
      expect(harness.instance.selection.focus).toBe(beforeBoundaryMove)

      harness.instance.selection.focus = { col: 5, row: 1 }
      harness.instance.moveSelectionFocus('lineStart')
      expect(harness.instance.selection.focus).toEqual({ col: 0, row: 1 })

      harness.instance.moveSelectionFocus('lineEnd')
      expect(harness.instance.selection.focus).toEqual({ col: 11, row: 1 })

      harness.instance.selection.focus = { col: 3, row: 1 }
      harness.instance.moveSelectionFocus('up')
      expect(harness.instance.selection.focus).toEqual({ col: 3, row: 0 })

      const topFocus = harness.instance.selection.focus
      harness.instance.moveSelectionFocus('up')
      expect(harness.instance.selection.focus).toBe(topFocus)

      harness.instance.selection.focus = { col: 3, row: 2 }
      harness.instance.moveSelectionFocus('down')
      expect(harness.instance.selection.focus).toEqual({ col: 3, row: 3 })

      const bottomFocus = harness.instance.selection.focus
      harness.instance.moveSelectionFocus('down')
      expect(harness.instance.selection.focus).toBe(bottomFocus)

      const focusNext = vi.spyOn(harness.instance.focusManager, 'focusNext')
      const focusPrevious = vi.spyOn(
        harness.instance.focusManager,
        'focusPrevious',
      )
      harness.instance.dispatchKeyboardEvent({
        ctrl: false,
        meta: false,
        name: 'tab',
        shift: false,
      } as never)
      harness.instance.dispatchKeyboardEvent({
        ctrl: false,
        meta: false,
        name: 'tab',
        shift: true,
      } as never)
      harness.instance.dispatchKeyboardEvent({
        ctrl: true,
        meta: false,
        name: 'tab',
        shift: false,
      } as never)
      harness.instance.dispatchKeyboardEvent({
        ctrl: false,
        meta: true,
        name: 'tab',
        shift: false,
      } as never)
      harness.instance.dispatchKeyboardEvent({
        ctrl: false,
        meta: false,
        name: 'enter',
        shift: false,
      } as never)
      expect(focusNext).toHaveBeenCalledOnce()
      expect(focusPrevious).toHaveBeenCalledOnce()

      harness.instance.handleMultiClick(0, 99, 3)
      expect(harness.instance.selection.focus).toEqual({ col: 0, row: 99 })

      harness.instance.handleMultiClick(1, 0, 2)
      harness.instance.handleSelectionDrag(6, 0)
      expect(harness.instance.selection.anchorSpan).not.toBeNull()

      const textElement = requireElement(harness.stdout, 'ink-text')
      harness.instance.setCursorDeclaration(
        {
          node: textElement,
          relativeX: 1,
          relativeY: 0,
        },
        undefined,
      )
      harness.instance.setAltScreenActive(false)
      harness.stdoutWrites.length = 0
      harness.instance.onRender()
      expect(harness.stdoutWrites.join('')).toContain('\x1b[1C')

      harness.instance.onRender()

      harness.instance.setCursorDeclaration(null, {
        ...textElement,
      } as DOMElement)
      harness.instance.onRender()
      harness.instance.setCursorDeclaration(null, textElement)
      harness.instance.onRender()

      harness.instance.openHyperlink('https://opened.test')
      expect(opened).toEqual(['https://opened.test'])

      unsubscribe()
    } finally {
      await harness.dispose()
    }

    const unmounted = await createHarness()
    try {
      unmounted.root.unmount()
      unmounted.instance.suspendStdin()
    } finally {
      instances.delete(unmounted.stdout as unknown as NodeJS.WriteStream)
      unmounted.stdin.end()
      unmounted.stdout.end()
      unmounted.stderr.end()
      await sleep(25)
    }

    const nonTty = await createHarness({
      stdinIsTTY: false,
      stdoutIsTTY: false,
    })
    try {
      nonTty.instance.suspendStdin()
      nonTty.instance.resumeStdin()
      nonTty.instance.resetLineCount()
      expect(nonTty.rawModes).toEqual([])
    } finally {
      await nonTty.dispose()
    }

    const rawWithoutSetter = await createHarness({ stdinIsRaw: true })
    try {
      rawWithoutSetter.stdin.isRaw = undefined
      rawWithoutSetter.instance.suspendStdin()
      rawWithoutSetter.instance.resumeStdin()

      rawWithoutSetter.stdin.isRaw = true
      rawWithoutSetter.stdin.setRawMode = undefined
      rawWithoutSetter.instance.suspendStdin()
      ;(
        rawWithoutSetter.instance as unknown as { wasRawMode: boolean }
      ).wasRawMode = true
      rawWithoutSetter.instance.resumeStdin()
      expect(rawWithoutSetter.rawModes).toEqual([])
    } finally {
      await rawWithoutSetter.dispose()
    }
  })
})

describe('Ink lifecycle and cleanup coverage', () => {
  test('covers render error callbacks, shutdown detach, wait rejection, console assertions, tab cleanup, and stderr reentrancy', async () => {
    coverageState.supportsTabStatus = true
    const stderrWrites: Array<Uint8Array | string> = []
    const fakeStderrWrite = vi.fn(
      (
        chunk: Uint8Array | string,
        encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
      ) => {
        stderrWrites.push(chunk)
        const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
        callback?.()
        return true
      },
    )
    process.stderr.write = fakeStderrWrite as never

    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    const injectIntoDevTools = vi
      .spyOn(reconciler, 'injectIntoDevTools')
      .mockImplementation(() => undefined)
    const devHarness = await createHarness({
      columns: 0,
      rows: 0,
      stdoutIsTTY: false,
    })
    try {
      expect(devHarness.instance.frontFrame.viewport.width).toBe(80)
      expect(devHarness.instance.frontFrame.viewport.height).toBe(24)
      expect(injectIntoDevTools).toHaveBeenCalledWith(
        expect.objectContaining({
          rendererPackageName: 'ink',
        }),
      )
      const originalYogaNode = devHarness.instance.rootNode.yogaNode
      devHarness.instance.rootNode.yogaNode = undefined
      devHarness.instance.rootNode.onComputeLayout?.()
      devHarness.instance.rootNode.yogaNode = originalYogaNode
      devHarness.instance.isUnmounted = true
      devHarness.instance.rootNode.onComputeLayout?.()
      devHarness.instance.isUnmounted = false
      devHarness.instance.resolveExitPromise()
      devHarness.instance.rejectExitPromise(new Error('default reject'))
      devHarness.instance.unsubscribeExit()
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = originalNodeEnv
      }
      injectIntoDevTools.mockRestore()
      await devHarness.dispose()
    }

    let createContainerArgs: unknown[] | undefined
    const originalCreateContainer = reconciler.createContainer.bind(reconciler)
    const captureCreateContainer = vi
      .spyOn(reconciler, 'createContainer')
      .mockImplementation(function capture(this: unknown, ...args: unknown[]) {
        createContainerArgs = args
        return originalCreateContainer(
          ...(args as Parameters<typeof reconciler.createContainer>),
        )
      } as never)

    const harness = await createHarness({
      columns: 20,
      rows: 5,
      patchConsole: true,
      stdinIsRaw: true,
    })

    try {
      expect(createContainerArgs).toBeDefined()
      const onUncaughtError = createContainerArgs?.[7] as
        | ((error: unknown) => void)
        | undefined
      const onCaughtError = createContainerArgs?.[8] as
        | ((error: unknown) => void)
        | undefined
      const onRecoverableError = createContainerArgs?.[9] as
        | ((error: unknown) => void)
        | undefined
      onUncaughtError?.(new Error('uncaught'))
      onCaughtError?.('caught as text')
      onRecoverableError?.(new Error('recoverable'))
      harness.instance.reportRenderError('manual', 'plain text')
      expect(logMock.logError).toHaveBeenCalled()

      console.error('console %s', 'error')
      console.assert(false, 'assert %s', 'failed')
      expect(logMock.logError).toHaveBeenCalledWith(expect.any(Error))

      process.stderr.write(Buffer.from('outer stderr'), 'utf8', () => {})
      expect(stderrWrites.length).toBeGreaterThan(0)
      expect(fakeStderrWrite).toHaveBeenCalled()

      harness.instance.setAltScreenActive(true, true)
      harness.instance.drainTimer = setTimeout(() => {}, 1000)
      harness.instance.resetLineCount()
      harness.instance.resetPools()

      harness.instance.detachForShutdown()
      expect(harness.rawModes).toContain(false)

      const rawModesAfterDetach = [...harness.rawModes]
      harness.instance.detachForShutdown()
      expect(harness.rawModes).toEqual(rawModesAfterDetach)
    } finally {
      captureCreateContainer.mockRestore()
      instances.delete(harness.stdout as unknown as NodeJS.WriteStream)
      harness.stdin.end()
      harness.stdout.end()
      harness.stderr.end()
      await sleep(25)
    }

    process.stderr.write = fakeStderrWrite as never
    const rejecting = await createHarness({
      patchConsole: true,
      stdinIsRaw: true,
    })
    try {
      const wait = rejecting.instance.waitUntilExit()
      rejecting.instance.setAltScreenActive(true, true)
      rejecting.instance.drainTimer = setTimeout(() => {}, 1000)
      rejecting.instance.isPaused = true
      process.stderr.write = fakeStderrWrite as never
      rejecting.instance.unmount(new Error('exit failed'))
      await expect(wait).rejects.toThrow('exit failed')
      expect(rejecting.instance.drainTimer).toBeNull()
      expect(fsMock.writeSync).toHaveBeenCalledWith(1, EXIT_ALT_SCREEN)
      expect(fsMock.writeSync.mock.calls.some((call) => call[0] === 1)).toBe(
        true,
      )
    } finally {
      instances.delete(rejecting.stdout as unknown as NodeJS.WriteStream)
      rejecting.stdin.end()
      rejecting.stdout.end()
      rejecting.stderr.end()
      rejecting.instance.unmount()
      await sleep(25)
    }
  })
})

describe('drainStdin platform and tty buffer coverage', () => {
  function createDrainStream(
    options: {
      isRaw?: boolean
      read?: () => Buffer | null
      setRawMode?: (mode: boolean) => void
    } = {},
  ): TestStdin {
    const stdin = new PassThrough() as TestStdin
    stdin.isTTY = true
    stdin.isRaw = options.isRaw ?? false
    stdin.setRawMode =
      options.setRawMode ??
      ((mode: boolean) => {
        stdin.isRaw = mode
      })
    stdin.ref = () => {}
    stdin.unref = () => {}
    if (options.read) {
      stdin.read = options.read
    }
    return stdin
  }

  test('skips kernel tty reads on Windows after draining the node buffer', () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    })
    const stdin = createDrainStream({
      read: vi
        .fn()
        .mockReturnValueOnce(Buffer.from('buffered'))
        .mockReturnValueOnce(null),
    })

    drainStdin(stdin as unknown as NodeJS.ReadStream)

    expect(fsMock.openSync).not.toHaveBeenCalled()
  })

  test('drains non-blocking tty reads, closes the fd, and restores cooked mode', () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    })
    const rawModes: boolean[] = []
    const stdin = createDrainStream({
      read: vi
        .fn()
        .mockReturnValueOnce(Buffer.from('buffered'))
        .mockReturnValueOnce(null),
      setRawMode: (mode) => {
        rawModes.push(mode)
      },
    })
    fsMock.openSync.mockReturnValue(123)
    fsMock.readSync.mockReturnValueOnce(4).mockReturnValueOnce(0)

    drainStdin(stdin as unknown as NodeJS.ReadStream)

    expect(rawModes).toEqual([true, false])
    expect(fsMock.openSync).toHaveBeenCalledWith('/dev/tty', expect.any(Number))
    expect(fsMock.readSync).toHaveBeenCalledTimes(2)
    expect(fsMock.closeSync).toHaveBeenCalledWith(123)
  })

  test('tolerates read and close failures without changing an already raw tty', () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    })
    const setRawMode = vi.fn()
    const stdin = createDrainStream({
      isRaw: true,
      read: vi.fn(() => {
        throw new Error('destroyed stream')
      }),
      setRawMode,
    })
    fsMock.openSync.mockReturnValue(456)
    fsMock.readSync.mockImplementation(() => {
      throw new Error('tty revoked')
    })
    fsMock.closeSync.mockImplementation(() => {
      throw new Error('close failed')
    })

    drainStdin(stdin as unknown as NodeJS.ReadStream)

    expect(setRawMode).not.toHaveBeenCalled()
    expect(fsMock.closeSync).toHaveBeenCalledWith(456)
  })
})
