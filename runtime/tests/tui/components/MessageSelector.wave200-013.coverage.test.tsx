import { describe, expect, it } from 'vitest'

import type { Message, UserMessage } from '../../types/message.js'
import { buildMessageSelectorFileHistoryMetadata } from './MessageSelector.js'

function userMessage(uuid: string, text: string): UserMessage {
  return {
    message: { content: [{ type: 'text', text }] },
    timestamp: '2026-05-20T00:00:00.000Z',
    type: 'user',
    uuid,
  } as UserMessage
}

function toolResultMessage(uuid: string, toolUseResult?: unknown): Message {
  return {
    message: {
      content: [{ content: 'done', tool_use_id: uuid, type: 'tool_result' }],
    },
    toolUseResult,
    type: 'user',
    uuid,
  } as Message
}

describe('MessageSelector file history metadata coverage', () => {
  it('builds per-message diff stats from bounded tool-result windows', () => {
    const first = userMessage('user-1', 'restore from here')
    const second = userMessage('user-2', 'restore later')
    const missingNext = userMessage('missing-next', 'missing from transcript')
    const current = userMessage('current-message', '')

    const metadata = buildMessageSelectorFileHistoryMetadata({
      canRestoreMessage: () => true,
      currentUUID: current.uuid as never,
      fileHistory: {} as never,
      isFileHistoryEnabled: true,
      messageOptions: [first, second, missingNext, current],
      messages: [
        first,
        toolResultMessage('ignored-no-result'),
        toolResultMessage('created-file', {
          content: 'alpha\nbeta',
          filePath: '/tmp/new-file.ts',
          structuredPatch: [],
          type: 'create',
        }),
        toolResultMessage('edited-file', {
          filePath: '/tmp/edited-file.ts',
          structuredPatch: [
            {
              lines: [' context', '+added', '-removed', '+another'],
              newLines: 3,
              newStart: 1,
              oldLines: 2,
              oldStart: 1,
            },
          ],
        }),
        toolResultMessage('ignored-no-file', { structuredPatch: [] }),
        second,
        toolResultMessage('after-second', {
          filePath: '/tmp/after-second.ts',
          structuredPatch: [
            {
              lines: ['+after', '-before'],
              newLines: 1,
              newStart: 1,
              oldLines: 1,
              oldStart: 1,
            },
          ],
        }),
      ],
    })

    expect(metadata).toEqual({
      'missing-next': undefined,
      'user-1': {
        deletions: 1,
        filesChanged: ['/tmp/new-file.ts', '/tmp/edited-file.ts'],
        insertions: 4,
      },
      'user-2': {
        deletions: 1,
        filesChanged: ['/tmp/after-second.ts'],
        insertions: 1,
      },
    })
  })
})
