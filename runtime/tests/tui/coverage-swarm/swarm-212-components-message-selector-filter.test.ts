import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  BASH_STDERR_TAG,
  BASH_STDOUT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../../src/constants/xml.js'

const messageHarness = vi.hoisted(() => ({
  isSyntheticMessage: vi.fn(() => false),
}))

vi.mock('../../../src/utils/messages.js', () => ({
  isSyntheticMessage: messageHarness.isSyntheticMessage,
}))

import { selectableUserMessagesFilter } from '../../../src/tui/components/message-selector-filter.js'

function userMessage(
  content: unknown,
  overrides: Record<string, unknown> = {},
): never {
  return {
    message: { content },
    type: 'user',
    uuid: 'user-message',
    ...overrides,
  } as never
}

function typedMessage(type: string, content: unknown = 'visible prompt'): never {
  return {
    message: { content },
    type,
    uuid: `${type}-message`,
  } as never
}

describe('message selector filter coverage swarm row 212', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageHarness.isSyntheticMessage.mockReturnValue(false)
  })

  test('rejects message shapes that cannot be restored from the selector', () => {
    expect(selectableUserMessagesFilter(typedMessage('assistant'))).toBe(false)
    expect(
      selectableUserMessagesFilter(
        userMessage([
          {
            content: 'tool result',
            tool_use_id: 'tool-1',
            type: 'tool_result',
          },
        ]),
      ),
    ).toBe(false)

    messageHarness.isSyntheticMessage.mockReturnValueOnce(true)
    expect(selectableUserMessagesFilter(userMessage('No response requested.'))).toBe(false)
    expect(messageHarness.isSyntheticMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user' }),
    )

    expect(
      selectableUserMessagesFilter(
        userMessage('transcript-only prompt', {
          isVisibleInTranscriptOnly: true,
        }),
      ),
    ).toBe(false)
  })

  test('uses the final text block when deciding whether array content is selectable', () => {
    expect(
      selectableUserMessagesFilter(
        userMessage([
          { text: 'earlier visible text', type: 'text' },
          {
            source: {
              data: 'iVBORw0KGgo=',
              media_type: 'image/png',
              type: 'base64',
            },
            type: 'image',
          },
        ]),
      ),
    ).toBe(false)

    expect(
      selectableUserMessagesFilter(
        userMessage([
          {
            source: {
              data: 'iVBORw0KGgo=',
              media_type: 'image/png',
              type: 'base64',
            },
            type: 'image',
          },
          { text: '  restore this user prompt  ', type: 'text' },
        ]),
      ),
    ).toBe(true)
  })

  test.each([
    {
      markup: `<${LOCAL_COMMAND_STDOUT_TAG}>hidden output</${LOCAL_COMMAND_STDOUT_TAG}>`,
      tag: LOCAL_COMMAND_STDOUT_TAG,
    },
    {
      markup: `<${LOCAL_COMMAND_STDERR_TAG}>hidden output</${LOCAL_COMMAND_STDERR_TAG}>`,
      tag: LOCAL_COMMAND_STDERR_TAG,
    },
    {
      markup: `<${BASH_STDOUT_TAG}>hidden output</${BASH_STDOUT_TAG}>`,
      tag: BASH_STDOUT_TAG,
    },
    {
      markup: `<${BASH_STDERR_TAG}>hidden output</${BASH_STDERR_TAG}>`,
      tag: BASH_STDERR_TAG,
    },
    {
      markup: `<${TASK_NOTIFICATION_TAG}>hidden output</${TASK_NOTIFICATION_TAG}>`,
      tag: TASK_NOTIFICATION_TAG,
    },
    {
      markup: `<${TICK_TAG}>hidden output</${TICK_TAG}>`,
      tag: TICK_TAG,
    },
    {
      markup: `<${TEAMMATE_MESSAGE_TAG} id="1">hidden output</${TEAMMATE_MESSAGE_TAG}>`,
      tag: TEAMMATE_MESSAGE_TAG,
    },
  ])('rejects synthetic transcript markup tagged as $tag', ({ markup }) => {
    expect(
      selectableUserMessagesFilter(
        userMessage(`before ${markup} after`),
      ),
    ).toBe(false)
  })
})
