import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import instances from '../ink/instances.js'
import { createRoot } from '../ink/root.js'

const appStateMock = vi.hoisted(() => ({
  state: {
    expandedView: undefined as string | undefined,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
  },
  setAppState: vi.fn(),
}))

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 80, rows: 24 },
}))

const teammateViewMock = vi.hoisted(() => ({
  enterTeammateView: vi.fn(),
  exitTeammateView: vi.fn(),
}))

vi.mock('../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
  useSetAppState: () => appStateMock.setAppState,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

vi.mock('../state/teammateViewHelpers.js', () => teammateViewMock)

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

function shellTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: id,
    startTime: 10,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    command: `npm run ${id}`,
    kind: 'bash',
    ...overrides,
  }
}

function teammateTask(
  id: string,
  agentName: string,
  options: { color?: string; isIdle?: boolean } = {},
) {
  return {
    id,
    type: 'in_process_teammate',
    status: 'running',
    description: agentName,
    startTime: 10,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: id,
      agentName,
      teamName: 'team',
      color: options.color,
      planModeRequired: false,
      parentSessionId: 'parent',
    },
    prompt: 'help',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: options.isIdle ?? false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function createStreams(): { stdin: TestStdin; stdout: PassThrough } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.on('data', () => {})
  ;(stdout as unknown as { columns: number }).columns = 120
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdin, stdout }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }
  return instance.rootNode
}

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue
  return node.childNodes.map(collectText).join('')
}

function findBoxByText(node: DOMNode, text: string): DOMElement | undefined {
  if (
    node.nodeName !== '#text' &&
    node.nodeName === 'ink-box' &&
    collectText(node).includes(text)
  ) {
    return node
  }
  if (node.nodeName === '#text') return undefined
  for (const child of node.childNodes) {
    const found = findBoxByText(child, text)
    if (found) return found
  }
  return undefined
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForText(stdout: PassThrough, text: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2_000) {
    if (collectText(getRootNode(stdout)).includes(text)) return
    await sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}`)
}

describe('BackgroundTaskStatus coverage swarm row 028', () => {
  beforeEach(() => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'
    appStateMock.state = {
      expandedView: undefined,
      tasks: {},
      viewingAgentTaskId: undefined,
    }
    appStateMock.setAppState.mockClear()
    teammateViewMock.enterTeammateView.mockClear()
    teammateViewMock.exitTeammateView.mockClear()
    terminalSizeMock.size = { columns: 80, rows: 24 }
  })

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('renders nothing when no visible footer task remains', async () => {
    const { BackgroundTaskStatus } = await import(
      '../components/tasks/BackgroundTaskStatus.js'
    )

    expect(
      (
        await renderToString(
          <BackgroundTaskStatus tasksSelected={false} />,
          80,
        )
      ).trim(),
    ).toBe('')

    appStateMock.state = {
      expandedView: 'teammates',
      viewingAgentTaskId: undefined,
      tasks: {
        alpha: teammateTask('alpha', 'alpha'),
      },
    }

    expect(
      (
        await renderToString(
          <BackgroundTaskStatus tasksSelected={false} />,
          80,
        )
      ).trim(),
    ).toBe('')
  })

  test('uses the compact summary when spinner tree has mixed task types', async () => {
    appStateMock.state = {
      expandedView: 'teammates',
      viewingAgentTaskId: undefined,
      tasks: {
        shell: shellTask('shell'),
        alpha: teammateTask('alpha', 'alpha'),
      },
    }

    const { BackgroundTaskStatus } = await import(
      '../components/tasks/BackgroundTaskStatus.js'
    )
    const output = await renderToString(
      <BackgroundTaskStatus tasksSelected={true} />,
      80,
    )

    expect(output).toContain('2 background tasks')
    expect(output).not.toContain('@alpha')
    expect(output).not.toContain('to view')
  })

  test('renders teammate pill states and routes teammate clicks', async () => {
    process.env.AGENC_TUI_GLYPHS = 'unicode'
    terminalSizeMock.size = { columns: 120, rows: 24 }
    appStateMock.state = {
      expandedView: undefined,
      viewingAgentTaskId: 'viewed',
      tasks: {
        idle: teammateTask('idle', 'aaa-idle', { isIdle: true }),
        viewed: teammateTask('viewed', 'bbb-viewed', { color: 'red' }),
        plain: teammateTask('plain', 'ccc-plain'),
        colored: teammateTask('colored', 'ddd-colored', { color: 'cyan' }),
        selected: teammateTask('selected', 'zzz-selected', {
          color: 'not-a-theme-color',
        }),
      },
    }

    const { BackgroundTaskStatus } = await import(
      '../components/tasks/BackgroundTaskStatus.js'
    )
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <BackgroundTaskStatus tasksSelected={true} teammateFooterIndex={5} />,
      )
      await waitForText(stdout, '@zzz-selected')

      const rootNode = getRootNode(stdout)
      const text = collectText(rootNode)
      expect(text).toContain('@main')
      expect(text).toContain('@aaa-idle')
      expect(text).toContain('@bbb-viewed')
      expect(text).toContain('@ccc-plain')
      expect(text).toContain('@ddd-colored')
      expect(text).toContain('@zzz-selected')
      expect(text).toContain('to expand')

      const mainBox = findBoxByText(rootNode, '@main')
      const selectedBox = findBoxByText(rootNode, '@zzz-selected')
      expect(mainBox?._eventHandlers?.onClick).toBeTypeOf('function')
      expect(selectedBox?._eventHandlers?.onClick).toBeTypeOf('function')

      ;(selectedBox?._eventHandlers?.onMouseEnter as
        | (() => void)
        | undefined)?.()
      await sleep()
      ;(selectedBox?._eventHandlers?.onMouseLeave as
        | (() => void)
        | undefined)?.()
      ;(selectedBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(teammateViewMock.enterTeammateView).toHaveBeenCalledWith(
        'selected',
        appStateMock.setAppState,
      )

      ;(mainBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(teammateViewMock.exitTeammateView).toHaveBeenCalledWith(
        appStateMock.setAppState,
      )
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('wires compact summary pill hover and click handlers', async () => {
    appStateMock.state = {
      expandedView: undefined,
      viewingAgentTaskId: undefined,
      tasks: {
        shell: shellTask('shell'),
      },
    }
    const onOpenDialog = vi.fn()
    const { BackgroundTaskStatus } = await import(
      '../components/tasks/BackgroundTaskStatus.js'
    )
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <BackgroundTaskStatus
          tasksSelected={false}
          onOpenDialog={onOpenDialog}
        />,
      )
      await waitForText(stdout, '1 shell')

      const summaryBox = findBoxByText(getRootNode(stdout), '1 shell')
      expect(summaryBox?._eventHandlers?.onClick).toBeTypeOf('function')
      ;(summaryBox?._eventHandlers?.onMouseEnter as
        | (() => void)
        | undefined)?.()
      await sleep()
      ;(summaryBox?._eventHandlers?.onMouseLeave as
        | (() => void)
        | undefined)?.()
      ;(summaryBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(onOpenDialog).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
