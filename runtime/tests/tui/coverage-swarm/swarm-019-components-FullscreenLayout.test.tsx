import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

const browser = vi.hoisted(() => ({
  logError: vi.fn(),
  openBrowser: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock('../../../src/utils/browser.js', () => browser)

vi.mock('../../../src/utils/log.js', () => ({
  logError: browser.logError,
}))

import { createRoot, Text } from '../../../src/tui/ink.js'
import {
  AppStateProvider,
  getDefaultAppState,
} from '../../../src/tui/state/AppState.js'
import {
  DesignTopChrome,
  FullscreenLayout,
  useUnseenDivider,
} from '../../../src/tui/components/FullscreenLayout.js'
import {
  useSetPromptOverlay,
  useSetPromptOverlayDialog,
} from '../../../src/tui/context/promptOverlayContext.js'
import {
  deleteInkInstance,
  setInkInstance,
} from '../../../src/tui/ink/instances.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import type { ScrollBoxHandle } from '../../../src/tui/ink/components/ScrollBox.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type Viewport = {
  readonly columns: number
  readonly rows: number
}

type TestScrollHandle = ScrollBoxHandle & {
  setPendingDelta: (value: number) => void
  setScrollHeight: (value: number) => void
  setScrollTop: (value: number) => void
  setViewportHeight: (value: number) => void
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = previous
  }
}

async function withFullscreenEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENC_NO_FLICKER
  process.env.AGENC_NO_FLICKER = '1'
  try {
    return await fn()
  } finally {
    restoreEnv('AGENC_NO_FLICKER', previous)
  }
}

function createStreams(viewport: Viewport): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
  readonly getOutput: () => string
} {
  let output = ''
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = viewport.columns
  stdout.rows = viewport.rows
  stdout.isTTY = true
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return {
    stdin,
    stdout,
    getOutput: () => output,
  }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderLatestFrame(
  node: React.ReactNode,
  viewport: Viewport = { columns: 100, rows: 14 },
): Promise<string> {
  return withFullscreenEnv(async () => {
    const { stdin, stdout, getOutput } = createStreams(viewport)
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(node)
      await sleep()
      // Assert against everything painted, not just the last sync frame:
      // the bottom chrome's git label probe resolves asynchronously (by
      // design, so first paint never blocks) and its incremental repaint
      // then becomes the trailing frame, containing only the git segment
      // and none of the overlay content painted earlier.
      return stripAnsi(getOutput())
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
}

function createScrollHandle(): TestScrollHandle {
  let pendingDelta = -1
  let scrollHeight = 30
  let scrollTop = 20
  let viewportHeight = 10

  return {
    getPendingDelta: vi.fn(() => pendingDelta),
    getScrollHeight: vi.fn(() => scrollHeight),
    getScrollTop: vi.fn(() => scrollTop),
    getViewportHeight: vi.fn(() => viewportHeight),
    scrollToBottom: vi.fn(),
    setPendingDelta: (value: number) => {
      pendingDelta = value
    },
    setScrollHeight: (value: number) => {
      scrollHeight = value
    },
    setScrollTop: (value: number) => {
      scrollTop = value
    },
    setViewportHeight: (value: number) => {
      viewportHeight = value
    },
  } as unknown as TestScrollHandle
}

function task(id: string, status: string): never {
  return {
    id,
    type: 'local_bash',
    status,
    description: id,
    command: id,
    startTime: 0,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
  } as never
}

function SuggestionsWriter(): React.ReactNode {
  useSetPromptOverlay({
    suggestions: [
      {
        id: 'command-help',
        displayText: '/help',
        description: 'show commands',
      },
      {
        id: 'command-status',
        displayText: '/status',
        description: 'show status',
      },
    ],
    selectedSuggestion: 1,
    maxColumnWidth: 16,
    suggestionType: 'command',
  })

  return <Text>prompt suggestions writer</Text>
}

function DialogWriter(): React.ReactNode {
  useSetPromptOverlayDialog(<Text>floating dialog marker</Text>)
  return <Text>prompt dialog writer</Text>
}

describe('FullscreenLayout coverage swarm 019', () => {
  test('repins the unseen divider after a pending-delta scroll-away snapshot', async () => {
    let messageCount = 4
    let latest: ReturnType<typeof useUnseenDivider> | undefined
    const { stdin, stdout } = createStreams({ columns: 80, rows: 12 })
    stdout.resume()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    function Harness(): null {
      latest = useUnseenDivider(messageCount)
      return null
    }

    async function render(
      nextCount = messageCount,
    ): Promise<ReturnType<typeof useUnseenDivider>> {
      messageCount = nextCount
      root.render(<Harness />)
      await sleep()
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    }

    try {
      const handle = createScrollHandle()
      let state = await render()

      state.onScrollAway(handle)
      await sleep()
      state = await render()
      expect(state.dividerIndex).toBe(4)
      expect(state.dividerYRef.current).toBe(30)

      state.onRepin()
      expect(state.dividerYRef.current).toBe(30)

      await sleep()
      state = await render()
      expect(state.dividerIndex).toBeNull()
      expect(state.dividerYRef.current).toBeNull()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('selects active tasks for top chrome and truncates long task ids', async () => {
    const state = getDefaultAppState()
    const output = await renderToString(
      <AppStateProvider
        initialState={{
          ...state,
          tasks: {
            done: task('done-task', 'completed'),
            active: task('run-task-1234567890abcdefghij', 'running'),
          },
        }}
      >
        <DesignTopChrome columns={120} noColor={true} />
      </AppStateProvider>,
      120,
    )

    expect(output).toContain('run-task')
    expect(output).not.toContain('run-task-1234567890abcdefghij')
    expect(output).not.toContain('done-task')
  })

  test('renders the active task in the top chrome and honest bottom labels', async () => {
    const state = getDefaultAppState()
    const output = await withFullscreenEnv(() =>
      renderToString(
        <AppStateProvider
          initialState={{
            ...state,
            tasks: {
              running: task('running-task', 'running'),
              queued: task('queued-task', 'queued'),
              completed: task('completed-task', 'completed'),
            },
            toolPermissionContext: {
              ...state.toolPermissionContext,
              mode: 'auto',
            },
          }}
        >
          <FullscreenLayout
            scrollable={<Text>scroll body</Text>}
            bottom={<Text>prompt body</Text>}
          />
        </AppStateProvider>,
        { columns: 100, rows: 12 },
      ),
    )

    // Top chrome surfaces the first running/queued task by id; the other
    // tasks stay out of the chrome (no aggregate count anywhere).
    expect(output).toContain('running-task')
    expect(output).not.toContain('queued-task')
    expect(output).not.toContain('completed-task')
    // Bottom chrome keeps the real labels (mode, spend) and drops the
    // fabricated ctx/stake segments the pre-redesign chrome hardcoded —
    // the old '2' assertion only ever matched the fake `12.4K` stake.
    expect(output).toContain('mode')
    expect(output).toContain('spend')
    expect(output).not.toContain('12.4K')
  })

  test('portals prompt suggestions above the clipped bottom slot', async () => {
    const output = await renderLatestFrame(
      <FullscreenLayout
        scrollable={<Text>scroll body</Text>}
        bottom={<SuggestionsWriter />}
      />,
    )
    const compactOutput = output.replace(/\s+/gu, '')

    expect(compactOutput).toContain('SLASHCOMMANDS')
    expect(compactOutput).toContain('/statusshowstatus')
  })

  test('portals prompt dialogs over the fullscreen scroll region', async () => {
    const output = await renderLatestFrame(
      <FullscreenLayout
        scrollable={<Text>scroll body</Text>}
        bottom={<DialogWriter />}
      />,
    )

    expect(output.replace(/\s+/gu, '')).toContain('dialogmarker')
  })

  test('routes fullscreen hyperlink clicks to file and browser openers', async () => {
    const browserFailure = new Error('browser failed')
    browser.logError.mockClear()
    browser.openBrowser.mockClear()
    browser.openPath.mockClear()
    browser.openBrowser.mockRejectedValueOnce(browserFailure)
    const fakeInk = {} as { onHyperlinkClick?: (url: string) => void }
    setInkInstance(process.stdout, fakeInk as never)

    const { stdin, stdout } = createStreams({ columns: 90, rows: 12 })
    stdout.resume()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      await withFullscreenEnv(async () => {
        root.render(
          <FullscreenLayout
            scrollable={<Text>link body</Text>}
            bottom={<Text>prompt body</Text>}
          />,
        )
        await sleep()

        expect(fakeInk.onHyperlinkClick).toEqual(expect.any(Function))

        fakeInk.onHyperlinkClick?.('file:///tmp/agenc-layout-marker.txt')
        fakeInk.onHyperlinkClick?.('https://example.test/docs')
        fakeInk.onHyperlinkClick?.('file://%zz')
        fakeInk.onHyperlinkClick?.('https://example.test/ok')
        await sleep()

        expect(browser.openPath).toHaveBeenCalledTimes(1)
        expect(browser.openPath).toHaveBeenCalledWith(
          '/tmp/agenc-layout-marker.txt',
        )
        expect(browser.openBrowser).toHaveBeenNthCalledWith(
          1,
          'https://example.test/docs',
        )
        expect(browser.openBrowser).toHaveBeenNthCalledWith(2, 'https://example.test/ok')
        expect(browser.logError).toHaveBeenCalledWith(browserFailure)
        expect(browser.logError.mock.calls.some(([error]) =>
          error instanceof Error && error.message.includes('Invalid URL')
        )).toBe(true)
      })
    } finally {
      root.unmount()
      deleteInkInstance(process.stdout)
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('restores only its own fullscreen hyperlink handler on unmount', async () => {
    const previousHandler = vi.fn()
    const replacementHandler = vi.fn()
    const fakeInk = {
      onHyperlinkClick: previousHandler,
    } as { onHyperlinkClick?: (url: string) => void }
    setInkInstance(process.stdout, fakeInk as never)

    try {
      await withFullscreenEnv(async () => {
        const first = createStreams({ columns: 90, rows: 12 })
        first.stdout.resume()
        const firstRoot = await createRoot({
          patchConsole: false,
          stdin: first.stdin as unknown as NodeJS.ReadStream,
          stdout: first.stdout as unknown as NodeJS.WriteStream,
        })
        try {
          firstRoot.render(
            <FullscreenLayout
              scrollable={<Text>link body</Text>}
              bottom={<Text>prompt body</Text>}
            />,
          )
          await sleep()

          expect(fakeInk.onHyperlinkClick).toEqual(expect.any(Function))
          expect(fakeInk.onHyperlinkClick).not.toBe(previousHandler)

          fakeInk.onHyperlinkClick = replacementHandler
          firstRoot.unmount()
          await sleep()

          expect(fakeInk.onHyperlinkClick).toBe(replacementHandler)
        } finally {
          firstRoot.unmount()
          first.stdin.end()
          first.stdout.end()
        }

        const second = createStreams({ columns: 90, rows: 12 })
        second.stdout.resume()
        const secondRoot = await createRoot({
          patchConsole: false,
          stdin: second.stdin as unknown as NodeJS.ReadStream,
          stdout: second.stdout as unknown as NodeJS.WriteStream,
        })
        fakeInk.onHyperlinkClick = previousHandler
        try {
          secondRoot.render(
            <FullscreenLayout
              scrollable={<Text>link body</Text>}
              bottom={<Text>prompt body</Text>}
            />,
          )
          await sleep()

          secondRoot.unmount()
          await sleep()

          expect(fakeInk.onHyperlinkClick).toBe(previousHandler)
        } finally {
          secondRoot.unmount()
          second.stdin.end()
          second.stdout.end()
        }
      })
    } finally {
      deleteInkInstance(process.stdout)
      await sleep()
    }
  })

  test('keeps nested fullscreen hyperlink handlers stacked', async () => {
    const previousHandler = vi.fn()
    const fakeInk = {
      onHyperlinkClick: previousHandler,
    } as { onHyperlinkClick?: (url: string) => void }
    setInkInstance(process.stdout, fakeInk as never)

    try {
      await withFullscreenEnv(async () => {
        const first = createStreams({ columns: 90, rows: 12 })
        const second = createStreams({ columns: 90, rows: 12 })
        first.stdout.resume()
        second.stdout.resume()
        const firstRoot = await createRoot({
          patchConsole: false,
          stdin: first.stdin as unknown as NodeJS.ReadStream,
          stdout: first.stdout as unknown as NodeJS.WriteStream,
        })
        const secondRoot = await createRoot({
          patchConsole: false,
          stdin: second.stdin as unknown as NodeJS.ReadStream,
          stdout: second.stdout as unknown as NodeJS.WriteStream,
        })

        try {
          firstRoot.render(
            <FullscreenLayout
              scrollable={<Text>first link body</Text>}
              bottom={<Text>first prompt body</Text>}
            />,
          )
          await sleep()
          const firstHandler = fakeInk.onHyperlinkClick
          expect(firstHandler).toEqual(expect.any(Function))

          secondRoot.render(
            <FullscreenLayout
              scrollable={<Text>second link body</Text>}
              bottom={<Text>second prompt body</Text>}
            />,
          )
          await sleep()
          const secondHandler = fakeInk.onHyperlinkClick
          expect(secondHandler).toEqual(expect.any(Function))
          expect(secondHandler).not.toBe(firstHandler)

          firstRoot.unmount()
          await sleep()

          expect(fakeInk.onHyperlinkClick).toBe(secondHandler)

          secondRoot.unmount()
          await sleep()

          expect(fakeInk.onHyperlinkClick).toBe(previousHandler)
        } finally {
          firstRoot.unmount()
          secondRoot.unmount()
          first.stdin.end()
          first.stdout.end()
          second.stdin.end()
          second.stdout.end()
        }
      })
    } finally {
      deleteInkInstance(process.stdout)
      await sleep()
    }
  })
})
