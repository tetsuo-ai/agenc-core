import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { DOMElement, DOMNode } from '../../ink/dom.js'
import instances from '../../ink/instances.js'
import { createRoot } from '../../ink/root.js'

const appStateMock = vi.hoisted(() => ({
  state: {
    expandedView: undefined as string | undefined,
    tasks: {} as Record<string, unknown>,
    viewingAgentTaskId: undefined as string | undefined,
  },
  setAppState: vi.fn(),
}))

const terminalSizeMock = vi.hoisted(() => ({
  size: { columns: 120, rows: 24 },
}))

const teammateViewMock = vi.hoisted(() => ({
  enterTeammateView: vi.fn(),
  exitTeammateView: vi.fn(),
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof appStateMock.state) => unknown) =>
    selector(appStateMock.state),
  useSetAppState: () => appStateMock.setAppState,
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminalSizeMock.size,
}))

vi.mock('../../state/teammateViewHelpers.js', () => teammateViewMock)

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type StyledText = {
  text: string
  styles: Record<string, unknown>
}

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

function createStreams(): { stdin: TestStdin; stdout: PassThrough } {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

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

function shellTask(id: string) {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: id,
    startTime: 10,
    outputFile: `urn:agenc:task:${id}:output`,
    outputOffset: 0,
    notified: false,
    command: 'npm test',
    kind: 'bash',
  }
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

function collectStyledText(
  node: DOMNode,
  inheritedStyles: Record<string, unknown> = {},
  found: StyledText[] = [],
): StyledText[] {
  if (node.nodeName === '#text') {
    if (node.nodeValue.length > 0) {
      found.push({ text: node.nodeValue, styles: inheritedStyles })
    }
    return found
  }

  const nextStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles

  for (const child of node.childNodes) {
    collectStyledText(child, nextStyles, found)
  }
  return found
}

function textStyles(rootNode: DOMElement, text: string): Record<string, unknown> {
  const segment = collectStyledText(rootNode).find(item => item.text === text)
  if (!segment) throw new Error(`Text segment not found: ${text}`)
  return segment.styles
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

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}

describe('BackgroundTaskStatus wave 200 coverage', () => {
  beforeEach(() => {
    process.env.AGENC_TUI_GLYPHS = 'unicode'
    appStateMock.state = {
      expandedView: undefined,
      tasks: {},
      viewingAgentTaskId: undefined,
    }
    appStateMock.setAppState.mockClear()
    teammateViewMock.enterTeammateView.mockClear()
    teammateViewMock.exitTeammateView.mockClear()
    terminalSizeMock.size = { columns: 120, rows: 24 }
  })

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode
    }
  })

  test('wires hover and click handlers for teammate and summary pills', async () => {
    const { BackgroundTaskStatus } = await import('./BackgroundTaskStatus.js')
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      appStateMock.state = {
        expandedView: undefined,
        viewingAgentTaskId: 'active-red',
        tasks: {
          idle: teammateTask('idle', 'aaa-idle', {
            color: 'ultraviolet',
            isIdle: true,
          }),
          plain: teammateTask('plain', 'mmm-plain'),
          active: teammateTask('active-red', 'zzz-active', { color: 'red' }),
        },
      }

      root.render(
        <BackgroundTaskStatus tasksSelected={false} isLeaderIdle={true} />,
      )
      await waitForCondition(
        () => collectText(getRootNode(stdout)).includes('@zzz-active'),
        'teammate footer did not render',
      )

      let rootNode = getRootNode(stdout)
      const teammateText = collectText(rootNode)
      expect(teammateText.indexOf('@zzz-active')).toBeLessThan(
        teammateText.indexOf('@aaa-idle'),
      )
      expect(teammateText).toContain('shift +')
      expect(teammateText).toContain('to expand')
      const activeColor = textStyles(rootNode, '@zzz-active').color
      const activeInitialStyles = { ...textStyles(rootNode, '@zzz-active') }
      const idleInitialStyles = { ...textStyles(rootNode, '@aaa-idle') }
      expect(activeColor).toBeTypeOf('string')

      const mainBox = findBoxByText(rootNode, '@main')
      const activeBox = findBoxByText(rootNode, '@zzz-active')
      expect(mainBox?._eventHandlers?.onClick).toBeTypeOf('function')
      expect(activeBox?._eventHandlers?.onClick).toBeTypeOf('function')

      ;(activeBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(teammateViewMock.enterTeammateView).toHaveBeenCalledWith(
        'active-red',
        appStateMock.setAppState,
      )

      ;(mainBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(teammateViewMock.exitTeammateView).toHaveBeenCalledWith(
        appStateMock.setAppState,
      )

      ;(mainBox?._eventHandlers?.onMouseEnter as (() => void) | undefined)?.()
      await waitForCondition(
        () => textStyles(getRootNode(stdout), '@main').inverse === true,
        'main pill hover style did not apply',
      )
      const hoveredMainBox = findBoxByText(getRootNode(stdout), '@main')
      expect(hoveredMainBox?._eventHandlers?.onMouseLeave).toBeTypeOf(
        'function',
      )
      ;(hoveredMainBox?._eventHandlers?.onMouseLeave as
        | (() => void)
        | undefined)?.()
      await waitForCondition(
        () => textStyles(getRootNode(stdout), '@main').inverse !== true,
        'main pill hover style did not clear',
      )

      ;(activeBox?._eventHandlers?.onMouseEnter as (() => void) | undefined)?.()
      await waitForCondition(
        () =>
          textStyles(getRootNode(stdout), '@zzz-active').backgroundColor ===
          activeColor,
        'active pill hover style did not apply',
      )
      const hoveredActiveBox = findBoxByText(getRootNode(stdout), '@zzz-active')
      expect(hoveredActiveBox?._eventHandlers?.onMouseLeave).toBeTypeOf(
        'function',
      )
      ;(hoveredActiveBox?._eventHandlers?.onMouseLeave as
        | (() => void)
        | undefined)?.()
      await waitForCondition(
        () =>
          textStyles(getRootNode(stdout), '@zzz-active').color ===
          activeColor,
        'active pill hover style did not clear',
      )

      const onOpenDialog = vi.fn()
      appStateMock.state = {
        expandedView: undefined,
        viewingAgentTaskId: undefined,
        tasks: {
          shell: shellTask('shell'),
        },
      }
      root.render(
        <BackgroundTaskStatus
          tasksSelected={false}
          onOpenDialog={onOpenDialog}
        />,
      )
      await waitForCondition(
        () => collectText(getRootNode(stdout)).includes('1 shell'),
        'summary pill did not render',
      )

      rootNode = getRootNode(stdout)
      const summaryBox = findBoxByText(rootNode, '1 shell')
      expect(summaryBox?._eventHandlers?.onClick).toBeTypeOf('function')
      ;(summaryBox?._eventHandlers?.onMouseEnter as
        | (() => void)
        | undefined)?.()
      await waitForCondition(
        () => textStyles(getRootNode(stdout), '1 shell').inverse === true,
        'summary pill hover style did not apply',
      )
      ;(summaryBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(onOpenDialog).toHaveBeenCalledTimes(1)
      ;(summaryBox?._eventHandlers?.onMouseLeave as
        | (() => void)
        | undefined)?.()
      await waitForCondition(
        () => textStyles(getRootNode(stdout), '1 shell').inverse !== true,
        'summary pill hover style did not clear',
      )

      expect(activeInitialStyles).toMatchObject({ bold: true })
      expect(idleInitialStyles).not.toHaveProperty('bold')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
