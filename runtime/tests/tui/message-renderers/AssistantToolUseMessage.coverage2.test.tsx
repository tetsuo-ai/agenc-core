import React from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Tool } from '../../tools/Tool.js'
import type {
  AgenCToolUseBlockParam,
  ProgressMessage,
} from '../../types/message.js'
import { renderToString } from '../../utils/staticRender.js'
import { Text } from '../ink.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'

const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

vi.mock('../../utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => false,
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

describe('AssistantToolUseMessage transparent wrapper coverage', () => {
  it('renders active transparent wrappers from progress without wrapper chrome', async () => {
    const param: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id: 'toolu_transparent_wrapper',
      name: 'Delegate',
      input: { prompt: 'outer task should stay hidden' },
    }
    const toolProgress = {
      data: { type: 'tool_progress', text: 'child task running' },
    }
    const hookProgress = {
      data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
    }
    const progressMessagesForMessage = [
      hookProgress,
      toolProgress,
    ] as ProgressMessage[]
    let receivedProgressMessages: ProgressMessage[] = []
    let receivedProgressOptions:
      | {
          readonly verbose: boolean
          readonly terminalSize?: { readonly columns: number; readonly rows: number }
          readonly inProgressToolCallCount?: number
          readonly isTranscriptMode?: boolean
        }
      | undefined

    const tool = {
      name: 'Delegate',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      userFacingName: () => 'Delegate',
      isTransparentWrapper: () => true,
      renderToolUseMessage: vi.fn(() => 'outer chrome'),
      renderToolUseProgressMessage: vi.fn((messages, options) => {
        receivedProgressMessages = messages
        receivedProgressOptions = options
        return <Text>{messages[0]?.data.text}</Text>
      }),
    } as unknown as Tool

    const output = await renderToString(
      <AssistantToolUseMessage
        param={param}
        addMargin={false}
        tools={[tool]}
        commands={[]}
        verbose={true}
        inProgressToolUseIDs={new Set([param.id])}
        progressMessagesForMessage={progressMessagesForMessage}
        shouldAnimate={false}
        shouldShowDot={false}
        inProgressToolCallCount={3}
        isTranscriptMode={true}
        lookups={{
          resolvedToolUseIDs: new Set<string>(),
          erroredToolUseIDs: new Set<string>(),
          inProgressHookCounts: new Map([
            [param.id, new Map([['PreToolUse', 1]])],
          ]),
          resolvedHookCounts: new Map<string, Map<string, number>>(),
        } as never}
      />,
      80,
    )

    expect(output).toContain('child task running')
    expect(output).toContain('PreToolUse')
    expect(output).toContain('hook running')
    expect(output).not.toContain('Delegate')
    expect(output).not.toContain('outer task should stay hidden')
    expect(output).not.toContain('outer chrome')
    expect(tool.renderToolUseMessage).not.toHaveBeenCalled()
    expect(tool.renderToolUseProgressMessage).toHaveBeenCalledTimes(1)
    expect(receivedProgressMessages).toEqual([toolProgress])
    expect(receivedProgressOptions).toMatchObject({
      verbose: true,
      terminalSize: { columns: 80, rows: 24 },
      inProgressToolCallCount: 3,
      isTranscriptMode: true,
    })
  })
})
