import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { Text } from '../../../src/tui/ink.js'
import { renderToString } from '../../../src/utils/staticRender.js'

type QueuedCommandFixture = {
  value: unknown
  mode: string
  isMeta?: boolean
}

const fixture = vi.hoisted(() => ({
  appState: {
    isBriefOnly: false,
    viewingAgentTaskId: undefined as string | undefined,
  },
  commands: [] as QueuedCommandFixture[],
  features: {} as Record<string, boolean>,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => fixture.features[name] === true,
}))

vi.mock('src/tui/hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => fixture.commands,
}))

vi.mock('src/tui/state/AppState.js', () => ({
  useAppState: (
    selector: (state: typeof fixture.appState) => unknown,
  ) => selector(fixture.appState),
}))

vi.mock('src/tui/context/QueuedMessageContext.js', () => ({
  QueuedMessageProvider: ({
    children,
    isFirst,
    useBriefLayout,
  }: {
    children: React.ReactNode
    isFirst: boolean
    useBriefLayout: boolean
  }) => (
    <>
      <Text>
        {isFirst ? '[first]' : '[later]'}
        {useBriefLayout ? '[brief]' : '[full]'}
      </Text>
      {children}
    </>
  ),
}))

vi.mock('src/tui/components/Message.js', () => ({
  Message: ({ message }: { message: { message?: { content?: unknown } } }) => {
    const content = message.message?.content

    if (Array.isArray(content)) {
      return (
        <Text>
          {content
            .map((block) =>
              typeof block === 'object' && block !== null && 'text' in block
                ? String(block.text)
                : JSON.stringify(block),
            )
            .join('|')}
        </Text>
      )
    }

    return <Text>{typeof content === 'string' ? content : ''}</Text>
  },
}))

vi.mock('src/utils/messages.js', () => ({
  EMPTY_LOOKUPS: {},
  createUserMessage: ({ content }: { content: unknown }) => ({
    message: { content },
    type: 'user',
  }),
  normalizeMessages: (messages: unknown[]) => messages,
}))

vi.mock('src/utils/messageQueueManager.js', () => ({
  isQueuedCommandEditable: (command: QueuedCommandFixture) =>
    !command.isMeta &&
    (command.mode === 'prompt' || command.mode === 'bash'),
  isQueuedCommandVisible: (command: QueuedCommandFixture) =>
    command.isMeta !== true,
}))

async function renderQueuedCommands(): Promise<string> {
  const { PromptInputQueuedCommands } = await import(
    '../../../src/tui/components/PromptInput/PromptInputQueuedCommands.js'
  )

  return renderToString(<PromptInputQueuedCommands />, { columns: 120 })
}

describe('PromptInputQueuedCommands coverage swarm 180', () => {
  beforeEach(() => {
    fixture.appState = {
      isBriefOnly: false,
      viewingAgentTaskId: undefined,
    }
    fixture.commands = []
    fixture.features = {}
  })

  test('renders nothing for empty queues, all-hidden queues, and teammate transcript views', async () => {
    expect((await renderQueuedCommands()).trim()).toBe('')

    fixture.commands = [
      {
        isMeta: true,
        mode: 'prompt',
        value: 'hidden queued text',
      },
    ]
    expect((await renderQueuedCommands()).trim()).toBe('')

    fixture.appState.viewingAgentTaskId = 'agent-task-1'
    fixture.commands = [
      {
        mode: 'prompt',
        value: 'leader text hidden while viewing teammate',
      },
    ]
    expect((await renderQueuedCommands()).trim()).toBe('')
  })

  test('counts editable prompt and bash entries while preserving non-string bash content', async () => {
    fixture.commands = [
      {
        mode: 'prompt',
        value: 'first queued prompt',
      },
      {
        mode: 'bash',
        value: [{ text: 'array backed bash command', type: 'text' }],
      },
    ]

    const output = await renderQueuedCommands()

    expect(output).toContain('2 inputs queued for next turn')
    expect(output).toContain('first queued prompt')
    expect(output).toContain('array backed bash command')
    expect(output).not.toContain('<bash-input>[object Object]</bash-input>')
  })

  test('passes brief layout through the queued message provider when brief features are enabled', async () => {
    fixture.features.KAIROS_BRIEF = true
    fixture.appState.isBriefOnly = true
    fixture.commands = [
      {
        mode: 'prompt',
        value: 'brief queued prompt',
      },
      {
        mode: 'prompt',
        value: 'second queued prompt',
      },
    ]

    const output = await renderQueuedCommands()

    expect(output).toContain('[first][brief]')
    expect(output).toContain('[later][brief]')
    expect(output).toContain('brief queued prompt')
    expect(output).toContain('second queued prompt')
  })

  test('filters idle notifications and caps visible task notification overflow', async () => {
    fixture.commands = [
      {
        mode: 'task-notification',
        value: JSON.stringify({ type: 'idle_notification' }),
      },
      ...[1, 2, 3, 4].map((index) => ({
        mode: 'task-notification',
        value: `<task-notification><summary>task ${index}</summary><status>completed</status></task-notification>`,
      })),
    ]

    const output = await renderQueuedCommands()

    expect(output).not.toContain('idle_notification')
    expect(output).toContain('task 1')
    expect(output).toContain('task 2')
    expect(output).toContain('+2 more tasks completed')
    expect(output).not.toContain('task 4')
    expect(output).not.toContain('inputs queued for next turn')
  })
})
