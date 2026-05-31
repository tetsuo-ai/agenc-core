import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tool } from '../../tools/Tool.js'
import type { AgenCToolUseBlockParam } from '../../types/message.js'
import { renderToString } from '../../utils/staticRender.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'

const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

const logMock = vi.hoisted(() => ({
  errors: [] as Error[],
}))

vi.mock('../../utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => false,
}))

vi.mock('../../utils/log.js', () => ({
  logError: (error: Error) => {
    logMock.errors.push(error)
  },
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../state/AppState.js', () => ({
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: typeof appStateMock) => unknown,
  ) => selector(appStateMock),
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>(
    '../ink.js',
  )
  return {
    ...actual,
    useTheme: () => ['dark'],
  }
})

function lookups() {
  return {
    resolvedToolUseIDs: new Set<string>(),
    erroredToolUseIDs: new Set<string>(),
  } as never
}

describe('AssistantToolUseMessage hook fallback coverage', () => {
  beforeEach(() => {
    logMock.errors.length = 0
    appStateMock.pendingWorkerRequest = undefined
    appStateMock.toolPermissionContext.mode = 'default'
    appStateMock.toolPermissionContext.strippedDangerousRules = undefined
  })

  it('keeps tool rows visible when optional display hooks throw', async () => {
    const circularInput: Record<string, unknown> = { ignored: true }
    circularInput.self = circularInput
    const runningParam: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id: 'toolu_throwing_running',
      name: 'Reader',
      input: circularInput,
    }
    const runningTool = {
      name: 'Reader',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      userFacingName: () => 'Reader',
      renderToolUseMessage: vi.fn(() => {
        throw new Error('message render failed')
      }),
      renderToolUseProgressMessage: vi.fn(() => {
        throw new Error('progress render failed')
      }),
    } as unknown as Tool

    const runningOutput = await renderToString(
      <AssistantToolUseMessage
        param={runningParam}
        addMargin={false}
        tools={[runningTool]}
        commands={[]}
        verbose={false}
        inProgressToolUseIDs={new Set([runningParam.id])}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={false}
        lookups={lookups()}
      />,
      80,
    )

    expect(runningOutput).toContain('Reader')
    // FIX 1: args are summarized to readable key=value, never a raw JSON /
    // [object Object] dump — even for a circular input (the object-valued
    // `self` key is skipped, the scalar `ignored` is shown).
    expect(runningOutput).toContain('ignored=true')
    expect(runningOutput).not.toContain('[object Object]')
    expect(runningOutput).not.toContain('message render failed')
    expect(runningOutput).not.toContain('progress render failed')
    expect(runningTool.renderToolUseMessage).toHaveBeenCalledTimes(1)
    expect(runningTool.renderToolUseProgressMessage).toHaveBeenCalledTimes(1)

    const queuedParam: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id: 'toolu_throwing_queued',
      name: 'QueueTool',
      input: { command: 'queued command' },
    }
    const queuedTool = {
      name: 'QueueTool',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      userFacingName: () => 'QueueTool',
      renderToolUseMessage: () => 'queued command',
      renderToolUseQueuedMessage: vi.fn(() => {
        throw new Error('queued render failed')
      }),
    } as unknown as Tool

    const queuedOutput = await renderToString(
      <AssistantToolUseMessage
        param={queuedParam}
        addMargin={false}
        tools={[queuedTool]}
        commands={[]}
        verbose={false}
        inProgressToolUseIDs={new Set()}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={false}
        lookups={lookups()}
      />,
      80,
    )

    expect(queuedOutput).toContain('QueueTool')
    expect(queuedOutput).toContain('queued command')
    expect(queuedOutput).not.toContain('queued render failed')
    expect(queuedTool.renderToolUseQueuedMessage).toHaveBeenCalledTimes(1)
    expect(logMock.errors.map(error => error.message)).toEqual([
      expect.stringContaining('Error rendering tool use message for Reader'),
      expect.stringContaining('Error rendering tool use progress message for Reader'),
      expect.stringContaining('Error rendering tool use queued message for QueueTool'),
    ])
  })
})
