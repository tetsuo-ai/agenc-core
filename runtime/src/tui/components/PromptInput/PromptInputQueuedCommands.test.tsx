import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from '../../../agenc/upstream/utils/staticRender.js'
import { Text } from '../../ink.js'

type QueuedCommandFixture = {
  value: string
  mode: string
  isMeta?: boolean
}

const queueFixture = vi.hoisted(() => ({
  commands: [] as QueuedCommandFixture[],
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../agenc/upstream/hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => queueFixture.commands,
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (
    selector: (state: { viewingAgentTaskId?: string; isBriefOnly: boolean }) => unknown,
  ) => selector({ viewingAgentTaskId: undefined, isBriefOnly: false }),
}))

vi.mock('../../../agenc/upstream/components/Message.js', () => ({
  Message: ({ message }: { message: { message?: { content?: unknown } } }) => (
    <Text>
      {typeof message.message?.content === 'string'
        ? message.message.content
        : ''}
    </Text>
  ),
}))

vi.mock('../../../agenc/upstream/utils/messages.js', () => ({
  EMPTY_LOOKUPS: {},
  createUserMessage: ({ content }: { content: unknown }) => ({
    type: 'user',
    message: { content },
  }),
  normalizeMessages: (messages: unknown[]) => messages,
}))

vi.mock('../../../agenc/upstream/utils/messageQueueManager.js', () => ({
  isQueuedCommandEditable: (cmd: { mode?: string }) => cmd.mode === 'prompt',
  isQueuedCommandVisible: (cmd: { isMeta?: boolean }) => cmd.isMeta !== true,
}))

describe('PromptInputQueuedCommands', () => {
  beforeEach(() => {
    queueFixture.commands = [
      {
        value: 'Use another library',
        mode: 'prompt',
      },
    ]
  })

  it('shows a next-turn guidance banner for queued prompt messages', async () => {
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')

    const output = await renderToString(<PromptInputQueuedCommands />, 100)

    expect(output).toContain('1 message queued for next turn')
    expect(output).toContain('Use another library')
  })

  it('hides idle notifications from the queue preview', async () => {
    queueFixture.commands = [
      {
        value: JSON.stringify({ type: 'idle_notification' }),
        mode: 'task-notification',
      },
    ]
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')

    const output = await renderToString(<PromptInputQueuedCommands />, 100)

    expect(output).not.toContain('idle_notification')
    expect(output.trim()).toBe('')
  })

  it('caps task notifications with an overflow summary', async () => {
    queueFixture.commands = [1, 2, 3, 4, 5].map((index) => ({
      value: `<task-notification><summary>task ${index}</summary><status>completed</status></task-notification>`,
      mode: 'task-notification',
    }))
    const { PromptInputQueuedCommands } = await import('./PromptInputQueuedCommands.js')

    const output = await renderToString(<PromptInputQueuedCommands />, 120)

    expect(output).toContain('task 1')
    expect(output).toContain('task 2')
    expect(output).toContain('+3 more tasks completed')
    expect(output).not.toContain('task 5')
  })
})
