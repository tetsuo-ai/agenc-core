import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import type Ink from './ink.tsx'
import { drainStdin } from './ink.tsx'
import type { DOMElement, ElementNames } from './dom.ts'
import type { Frame } from './frame.ts'
import instances from './instances.ts'
import { createRoot, type Root } from './root.ts'
import { CellWidth, cellAt } from './screen.ts'
import { BEL } from './termio/ansi.ts'
import { CURSOR_HOME, ERASE_SCREEN } from './termio/csi.ts'
import { ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN } from './termio/dec.ts'
import { useTerminalNotification } from './useTerminalNotification.ts'

const clipboardMock = vi.hoisted(() => ({
  logError: vi.fn(),
  setClipboard: vi.fn(async (_text: string) => ''),
  supportsTabStatus: vi.fn(() => false),
}))

vi.mock('./termio/osc.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./termio/osc.ts')>()
  return {
    ...actual,
    setClipboard: clipboardMock.setClipboard,
    supportsTabStatus: clipboardMock.supportsTabStatus,
  }
})

vi.mock('../../utils/log.js', () => ({
  logError: clipboardMock.logError,
}))

vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type TestStdin = PassThrough & {
  isTTY: boolean
  isRaw?: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

type InkInternals = Ink & {
  frontFrame: Frame
  handleResume: () => void
  prevFrameContaminated: boolean
  rootNode: DOMElement
  selection: Ink['selection']
}

const RAW_TEXT_STYLE = {
  flexDirection: 'row',
  flexGrow: 0,
  flexShrink: 1,
  textWrap: 'wrap',
} as const

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function textNode(children: React.ReactNode): React.ReactElement {
  return React.createElement(
    'ink-text',
    {
      style: RAW_TEXT_STYLE,
    },
    children,
  )
}

function CaptureTerminalBell({
  onReady,
}: {
  onReady: (notifyBell: () => void) => void
}): React.ReactElement {
  const { notifyBell } = useTerminalNotification()

  React.useEffect(() => {
    onReady(notifyBell)
  }, [notifyBell, onReady])

  return textNode('ready')
}

function createTestStreams(options: {
  columns?: number
  rows?: number
  stdoutIsTTY?: boolean
  stdinIsTTY?: boolean
  stdinIsRaw?: boolean
} = {}): {
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
  stdout.on('data', chunk => {
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

function requireElement(stdout: PassThrough, nodeName: ElementNames): DOMElement {
  const { rootNode } = getInkInstance(stdout)
  const found = findElement(rootNode, nodeName)
  if (!found) throw new Error(`Element ${nodeName} not found`)
  return found
}

async function createHarness(options: {
  columns?: number
  rows?: number
  stdoutIsTTY?: boolean
  stdinIsTTY?: boolean
  stdinIsRaw?: boolean
} = {}): Promise<{
  root: Root
  instance: InkInternals
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stdoutWrites: string[]
  rawModes: boolean[]
  dispose: () => Promise<void>
}> {
  const { stdout, stdin, stderr, stdoutWrites, rawModes } = createTestStreams(
    options,
  )
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    patchConsole: false,
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

describe('Ink instance rendering paths', () => {
  test('tracks alt-screen state and reasserts terminal modes with a full repaint', async () => {
    const harness = await createHarness({ columns: 20, rows: 5 })

    try {
      harness.root.render(textNode('ready'))
      await sleep(10)

      harness.stdoutWrites.length = 0
      harness.instance.setAltScreenActive(true, true)

      expect(harness.instance.isAltScreenActive).toBe(true)
      expect(harness.instance.frontFrame.screen.width).toBe(20)
      expect(harness.instance.frontFrame.screen.height).toBe(5)
      expect(harness.instance.frontFrame.viewport.height).toBe(6)
      expect(harness.instance.prevFrameContaminated).toBe(true)

      harness.instance.reassertTerminalModes(false)
      expect(harness.stdoutWrites.join('')).toContain(ENABLE_MOUSE_TRACKING)
      expect(harness.stdoutWrites.join('')).not.toContain(ENTER_ALT_SCREEN)

      harness.stdoutWrites.length = 0
      harness.instance.reassertTerminalModes(true)

      const reasserted = harness.stdoutWrites.join('')
      expect(reasserted).toContain(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME)
      expect(reasserted).toContain(ENABLE_MOUSE_TRACKING)

      harness.stdoutWrites.length = 0
      harness.instance.forceRedraw()
      expect(harness.stdoutWrites.join('')).toContain(ERASE_SCREEN + CURSOR_HOME)

      harness.instance.setAltScreenActive(false)
      expect(harness.instance.isAltScreenActive).toBe(false)
      expect(harness.instance.frontFrame.screen.height).toBe(0)
    } finally {
      await harness.dispose()
    }
  })

  test('does not reassert terminal modes after unmounting', async () => {
    const harness = await createHarness({ columns: 20, rows: 5 })

    try {
      harness.instance.setAltScreenActive(true, true)
      harness.root.render(textNode('ready'))
      await sleep(10)

      harness.root.unmount()
      harness.stdoutWrites.length = 0

      harness.instance.reassertTerminalModes(true)

      const writes = harness.stdoutWrites.join('')
      expect(writes).not.toContain(ENABLE_MOUSE_TRACKING)
      expect(writes).not.toContain(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME)
    } finally {
      harness.stdin.end()
      harness.stdout.end()
      harness.stderr.end()
      await sleep(25)
    }
  })

  test('ignores stale terminal resume after unmounting or while paused', async () => {
    const unmounted = await createHarness({ columns: 20, rows: 5 })

    try {
      unmounted.instance.setAltScreenActive(true, true)
      unmounted.root.render(textNode('ready'))
      await sleep(10)

      unmounted.root.unmount()
      unmounted.stdoutWrites.length = 0

      unmounted.instance.handleResume()

      const writes = unmounted.stdoutWrites.join('')
      expect(writes).not.toContain(ENABLE_MOUSE_TRACKING)
      expect(writes).not.toContain(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME)
    } finally {
      unmounted.stdin.end()
      unmounted.stdout.end()
      unmounted.stderr.end()
      await sleep(25)
    }

    const paused = await createHarness({ columns: 20, rows: 5 })

    try {
      paused.instance.setAltScreenActive(true, true)
      paused.root.render(textNode('ready'))
      await sleep(10)

      paused.instance.pause()
      paused.stdoutWrites.length = 0

      paused.instance.handleResume()

      const writes = paused.stdoutWrites.join('')
      expect(writes).not.toContain(ENABLE_MOUSE_TRACKING)
      expect(writes).not.toContain(ENTER_ALT_SCREEN + ERASE_SCREEN + CURSOR_HOME)
      paused.instance.resume()
    } finally {
      await paused.dispose()
    }
  })

  test('ignores resize events after shutdown detach', async () => {
    const harness = await createHarness({ columns: 20, rows: 5 })

    try {
      harness.instance.setAltScreenActive(true, true)
      harness.root.render(textNode('ready'))
      await sleep(10)

      const widthBeforeDetach = harness.instance.frontFrame.screen.width
      const heightBeforeDetach = harness.instance.frontFrame.screen.height
      harness.instance.detachForShutdown()
      harness.stdoutWrites.length = 0

      harness.stdout.columns = 32
      harness.stdout.rows = 9
      harness.stdout.emit('resize')
      await sleep(10)

      const writes = harness.stdoutWrites.join('')
      expect(writes).not.toContain(ENABLE_MOUSE_TRACKING)
      expect(writes).not.toContain(ERASE_SCREEN + CURSOR_HOME)
      expect(harness.instance.frontFrame.screen.width).toBe(widthBeforeDetach)
      expect(harness.instance.frontFrame.screen.height).toBe(heightBeforeDetach)
    } finally {
      instances.delete(harness.stdout as unknown as NodeJS.WriteStream)
      harness.stdin.end()
      harness.stdout.end()
      harness.stderr.end()
      await sleep(25)
    }
  })

  test('drops stale raw terminal writes while paused or unmounted', async () => {
    const harness = await createHarness({ columns: 20, rows: 5 })
    let notifyBell: (() => void) | undefined

    try {
      harness.root.render(
        <CaptureTerminalBell
          onReady={callback => {
            notifyBell = callback
          }}
        />,
      )
      await sleep(10)
      expect(notifyBell).toEqual(expect.any(Function))

      harness.stdoutWrites.length = 0
      notifyBell?.()
      expect(harness.stdoutWrites.join('')).toContain(BEL)

      harness.instance.pause()
      harness.stdoutWrites.length = 0
      notifyBell?.()
      expect(harness.stdoutWrites.join('')).not.toContain(BEL)
      harness.instance.resume()

      harness.root.unmount()
      harness.stdoutWrites.length = 0
      notifyBell?.()
      expect(harness.stdoutWrites.join('')).not.toContain(BEL)
    } finally {
      instances.delete(harness.stdout as unknown as NodeJS.WriteStream)
      harness.stdin.end()
      harness.stdout.end()
      harness.stderr.end()
      await sleep(25)
    }
  })

  test('drops stale external alternate-screen handoffs after detach or unmount', async () => {
    const enterAfterDetach = await createHarness({ columns: 20, rows: 5 })

    try {
      enterAfterDetach.root.render(textNode('ready'))
      await sleep(10)

      enterAfterDetach.instance.detachForShutdown()
      enterAfterDetach.stdoutWrites.length = 0

      enterAfterDetach.instance.enterAlternateScreen()

      expect(enterAfterDetach.stdoutWrites.join('')).toBe('')
    } finally {
      instances.delete(enterAfterDetach.stdout as unknown as NodeJS.WriteStream)
      enterAfterDetach.stdin.end()
      enterAfterDetach.stdout.end()
      enterAfterDetach.stderr.end()
      await sleep(25)
    }

    const enterAfterUnmount = await createHarness({ columns: 20, rows: 5 })

    try {
      enterAfterUnmount.root.render(textNode('ready'))
      await sleep(10)

      enterAfterUnmount.root.unmount()
      enterAfterUnmount.stdoutWrites.length = 0

      enterAfterUnmount.instance.enterAlternateScreen()

      expect(enterAfterUnmount.stdoutWrites.join('')).toBe('')
    } finally {
      instances.delete(enterAfterUnmount.stdout as unknown as NodeJS.WriteStream)
      enterAfterUnmount.stdin.end()
      enterAfterUnmount.stdout.end()
      enterAfterUnmount.stderr.end()
      await sleep(25)
    }

    const detached = await createHarness({ columns: 20, rows: 5 })

    try {
      detached.root.render(textNode('ready'))
      await sleep(10)

      detached.instance.enterAlternateScreen()
      detached.instance.detachForShutdown()
      detached.stdoutWrites.length = 0

      detached.instance.exitAlternateScreen()

      expect(detached.stdoutWrites.join('')).toBe('')
    } finally {
      instances.delete(detached.stdout as unknown as NodeJS.WriteStream)
      detached.stdin.end()
      detached.stdout.end()
      detached.stderr.end()
      await sleep(25)
    }

    const unmounted = await createHarness({ columns: 20, rows: 5 })

    try {
      unmounted.root.render(textNode('ready'))
      await sleep(10)

      unmounted.instance.enterAlternateScreen()
      unmounted.root.unmount()
      unmounted.stdoutWrites.length = 0

      unmounted.instance.exitAlternateScreen()

      expect(unmounted.stdoutWrites.join('')).toBe('')
    } finally {
      instances.delete(unmounted.stdout as unknown as NodeJS.WriteStream)
      unmounted.stdin.end()
      unmounted.stdout.end()
      unmounted.stderr.end()
      await sleep(25)
    }
  })

  test('ignores stale terminal interactions while paused or unmounted', async () => {
    const harness = await createHarness({ columns: 40, rows: 6 })
    const clicks: Array<{ localCol?: number; localRow?: number }> = []

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(
        React.createElement(
          'ink-box',
          {
            onClick: (event: { localCol?: number; localRow?: number }) => {
              clicks.push({
                localCol: event.localCol,
                localRow: event.localRow,
              })
            },
            style: { height: 1, width: 12 },
          },
          textNode('alpha beta'),
        ),
      )
      await sleep(10)

      harness.instance.pause()
      expect(harness.instance.dispatchClick(1, 0)).toBe(false)
      harness.instance.handleMultiClick(1, 0, 2)
      harness.instance.handleSelectionDrag(9, 0)
      harness.instance.moveSelectionFocus('right')
      expect(clicks).toEqual([])
      expect(harness.instance.hasTextSelection()).toBe(false)
      harness.instance.resume()

      harness.root.unmount()
      harness.instance.handleMultiClick(1, 0, 2)
      harness.instance.handleSelectionDrag(9, 0)
      expect(harness.instance.hasTextSelection()).toBe(false)
    } finally {
      instances.delete(harness.stdout as unknown as NodeJS.WriteStream)
      harness.stdin.end()
      harness.stdout.end()
      harness.stderr.end()
      await sleep(25)
    }
  })

  test('suspends and resumes stdin listeners and raw mode around external TUI handoff', async () => {
    const harness = await createHarness({ stdinIsRaw: true })
    const readableListener = vi.fn()

    try {
      harness.stdin.on('readable', readableListener)
      expect(harness.stdin.listenerCount('readable')).toBe(1)

      harness.instance.suspendStdin()
      expect(harness.stdin.listenerCount('readable')).toBe(0)
      expect(harness.rawModes).toEqual([false])

      harness.instance.resumeStdin()
      expect(harness.stdin.listeners('readable')).toContain(readableListener)
      expect(harness.rawModes).toEqual([false, true])
    } finally {
      await harness.dispose()
    }
  })

  test('copies, clears, and extends alt-screen text selection without native clipboard access', async () => {
    const harness = await createHarness({ columns: 40, rows: 6 })
    const selectionChanges: string[] = []

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta'))
      await sleep(10)

      expect(harness.instance.copySelectionNoClear()).toBe('')
      harness.instance.handleMultiClick(1, 0, 2)
      expect(harness.instance.hasTextSelection()).toBe(true)
      expect(harness.instance.copySelectionNoClear()).toBe('alpha')
      expect(harness.instance.hasTextSelection()).toBe(true)
      expect(clipboardMock.setClipboard).toHaveBeenCalledWith('alpha')

      const unsubscribe = harness.instance.subscribeToSelectionChange(() => {
        selectionChanges.push('changed')
      })

      harness.instance.moveSelectionFocus('right')
      expect(harness.instance.selection.focus).toEqual({ col: 5, row: 0 })

      harness.instance.handleSelectionDrag(9, 0)
      expect(harness.instance.copySelection()).toBe('alpha beta')
      expect(harness.instance.hasTextSelection()).toBe(false)
      expect(selectionChanges.length).toBeGreaterThan(0)

      const afterCopyChanges = selectionChanges.length
      harness.instance.clearTextSelection()
      expect(selectionChanges).toHaveLength(afterCopyChanges)

      unsubscribe()
    } finally {
      await harness.dispose()
    }
  })

  test('logs rejected clipboard writes while preserving copied selection text', async () => {
    const error = new Error('clipboard write failed')
    clipboardMock.logError.mockClear()
    clipboardMock.setClipboard.mockRejectedValueOnce(error)
    const harness = await createHarness({ columns: 40, rows: 6 })

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta'))
      await sleep(10)

      harness.instance.handleMultiClick(1, 0, 2)

      expect(harness.instance.copySelectionNoClear()).toBe('alpha')
      expect(harness.instance.hasTextSelection()).toBe(true)
      await sleep(10)
      expect(clipboardMock.logError).toHaveBeenCalledWith(error)
    } finally {
      await harness.dispose()
    }
  })

  test('writes delayed clipboard OSC while the instance is still active', async () => {
    const rawClipboard = '\u001b]52;c;YWxwaGE=\u0007'
    clipboardMock.setClipboard.mockResolvedValueOnce(rawClipboard)
    const harness = await createHarness({ columns: 40, rows: 6 })

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta'))
      await sleep(10)

      harness.stdoutWrites.length = 0
      harness.instance.handleMultiClick(1, 0, 2)
      expect(harness.instance.copySelectionNoClear()).toBe('alpha')
      await sleep(10)

      expect(harness.stdoutWrites.join('')).toContain(rawClipboard)
    } finally {
      await harness.dispose()
    }
  })

  test('does not write delayed clipboard OSC after unmounting', async () => {
    let resolveClipboard: (raw: string) => void = () => {}
    clipboardMock.setClipboard.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveClipboard = resolve
      }),
    )
    const harness = await createHarness({ columns: 40, rows: 6 })

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta'))
      await sleep(10)

      harness.instance.handleMultiClick(1, 0, 2)
      expect(harness.instance.copySelectionNoClear()).toBe('alpha')

      harness.root.unmount()
      harness.stdoutWrites.length = 0

      resolveClipboard('\u001b]52;c;YWxwaGE=\u0007')
      await sleep(10)

      expect(harness.stdoutWrites.join('')).not.toContain('\u001b]52;')
    } finally {
      harness.stdin.end()
      harness.stdout.end()
      harness.stderr.end()
      await sleep(25)
    }
  })

  test('does not write delayed clipboard OSC while paused for external handoff', async () => {
    let resolveClipboard: (raw: string) => void = () => {}
    clipboardMock.setClipboard.mockReturnValueOnce(
      new Promise<string>(resolve => {
        resolveClipboard = resolve
      }),
    )
    const harness = await createHarness({ columns: 40, rows: 6 })

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta'))
      await sleep(10)

      harness.instance.handleMultiClick(1, 0, 2)
      expect(harness.instance.copySelectionNoClear()).toBe('alpha')

      harness.instance.pause()
      harness.stdoutWrites.length = 0

      resolveClipboard('\u001b]52;c;YWxwaGE=\u0007')
      await sleep(10)

      expect(harness.stdoutWrites.join('')).not.toContain('\u001b]52;')
      harness.instance.resume()
    } finally {
      await harness.dispose()
    }
  })

  test('looks up rendered hyperlinks, dispatches hit-tested mouse events, and opens mutable hyperlink handlers', async () => {
    const harness = await createHarness({ columns: 40, rows: 6 })
    const clicks: Array<{ localCol?: number; localRow?: number }> = []
    const hoverEvents: string[] = []
    const opened: string[] = []

    try {
      expect(harness.instance.dispatchClick(0, 0)).toBe(false)
      expect(harness.instance.getHyperlinkAt(0, 0)).toBeUndefined()

      harness.instance.setAltScreenActive(true)
      harness.root.render(
        React.createElement(
          'ink-box',
          {
            onClick: (event: { localCol?: number; localRow?: number }) => {
              clicks.push({
                localCol: event.localCol,
                localRow: event.localRow,
              })
            },
            onMouseEnter: () => hoverEvents.push('enter'),
            onMouseLeave: () => hoverEvents.push('leave'),
            style: { height: 1, width: 12 },
            tabIndex: 0,
          },
          textNode('hit'),
        ),
      )
      await sleep(10)

      expect(harness.instance.dispatchClick(1, 0)).toBe(true)
      expect(clicks).toEqual([{ localCol: 1, localRow: 0 }])

      harness.instance.dispatchHover(1, 0)
      harness.instance.dispatchHover(30, 5)
      expect(hoverEvents).toEqual(['enter', 'leave'])

      harness.root.render(
        textNode(
          React.createElement(
            'ink-link',
            { href: 'https://wide.test' },
            '\u597d',
          ),
        ),
      )
      await sleep(10)
      expect(cellAt(harness.instance.frontFrame.screen, 1, 0)?.width).toBe(
        CellWidth.SpacerTail,
      )
      expect(harness.instance.getHyperlinkAt(1, 0)).toBe('https://wide.test')

      harness.root.render(textNode('see https://plain.test/path).'))
      await sleep(10)
      expect(harness.instance.getHyperlinkAt(12, 0)).toBe(
        'https://plain.test/path',
      )

      harness.instance.openHyperlink('https://ignored.test')
      harness.instance.onHyperlinkClick = url => opened.push(url)
      harness.instance.openHyperlink('https://opened.test')
      expect(opened).toEqual(['https://opened.test'])
    } finally {
      await harness.dispose()
    }
  })

  test('scans rendered subtrees and schedules search highlight overlays', async () => {
    const harness = await createHarness({ columns: 40, rows: 6 })

    try {
      harness.instance.setAltScreenActive(true)
      harness.root.render(textNode('alpha beta beta'))
      await sleep(10)

      const textElement = requireElement(harness.stdout, 'ink-text')
      expect(harness.instance.scanElementSubtree(textElement)).toEqual([])

      harness.instance.setSearchHighlight('beta')
      harness.instance.setSearchHighlight('beta')
      await sleep(10)

      const positions = harness.instance.scanElementSubtree(textElement)
      expect(positions).toEqual([
        { col: 6, len: 4, row: 0 },
        { col: 11, len: 4, row: 0 },
      ])

      harness.instance.setSearchPositions({
        currentIdx: 1,
        positions,
        rowOffset: 0,
      })
      await sleep(10)

      harness.instance.setSearchPositions(null)
      harness.instance.setSearchHighlight('')
    } finally {
      await harness.dispose()
    }
  })
})

describe('drainStdin', () => {
  test('returns early for non-TTY streams', () => {
    const stdin = new PassThrough() as TestStdin
    const rawModes: boolean[] = []
    stdin.isTTY = false
    stdin.setRawMode = (mode: boolean) => {
      rawModes.push(mode)
    }
    stdin.ref = () => {}
    stdin.unref = () => {}

    drainStdin(stdin as unknown as NodeJS.ReadStream)

    expect(rawModes).toEqual([])
  })

  test('drains buffered bytes and restores cooked mode for TTY streams', () => {
    const stdin = new PassThrough() as TestStdin
    const rawModes: boolean[] = []
    stdin.isTTY = true
    stdin.isRaw = false
    stdin.setRawMode = (mode: boolean) => {
      rawModes.push(mode)
      stdin.isRaw = mode
    }
    stdin.ref = () => {}
    stdin.unref = () => {}
    stdin.write('pending')

    drainStdin(stdin as unknown as NodeJS.ReadStream)

    expect(rawModes).toEqual(process.platform === 'win32' ? [] : [true, false])
    expect(stdin.read()).toBeNull()
  })
})
