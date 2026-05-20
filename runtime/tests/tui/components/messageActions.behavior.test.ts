import { describe, expect, test } from 'vitest'

import {
  copyTextOf,
  isNavigableMessage,
  stripSystemReminders,
  toolCallOf,
} from './messageActions.js'

function userText(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'user',
    uuid: `user-${text}`,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  }
}

function assistantText(text: string) {
  return {
    type: 'assistant',
    uuid: `assistant-${text}`,
    message: { content: [{ type: 'text', text }] },
  }
}

function assistantTool(name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    uuid: `assistant-tool-${name}`,
    message: { content: [{ type: 'tool_use', name, input }] },
  }
}

function toolResult(content: unknown) {
  return {
    type: 'user',
    uuid: 'tool-result',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }],
    },
  }
}

describe('message action text helpers', () => {
  test('strips leading system-reminder blocks from user-authored text', () => {
    expect(
      stripSystemReminders(
        '  <system-reminder>ignore this</system-reminder>\n<system-reminder>and this</system-reminder>\nactual prompt',
      ),
    ).toBe('actual prompt')

    expect(stripSystemReminders('<system-reminder>unterminated')).toBe(
      '<system-reminder>unterminated',
    )
  })

  test('extracts primary tool-call inputs from assistant and grouped messages', () => {
    expect(toolCallOf(assistantTool('Bash', { command: 'npm test' }) as never)).toEqual({
      name: 'Bash',
      input: { command: 'npm test' },
    })

    const grouped = {
      type: 'grouped_tool_use',
      toolName: 'Agent',
      messages: [
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', input: { prompt: 'fix it' } }] },
        },
      ],
      results: [],
    }

    expect(toolCallOf(grouped as never)).toEqual({
      name: 'Agent',
      input: { prompt: 'fix it' },
    })
    expect(toolCallOf(userText('plain') as never)).toBeUndefined()
  })

  test('copies useful text for each navigable message family', () => {
    expect(
      copyTextOf(
        userText(
          '<system-reminder>hidden</system-reminder>\nvisible user prompt',
        ) as never,
      ),
    ).toBe('visible user prompt')
    expect(copyTextOf(assistantText('assistant answer') as never)).toBe(
      'assistant answer',
    )
    expect(
      copyTextOf(assistantTool('Read', { file_path: '/tmp/file.ts' }) as never),
    ).toBe('/tmp/file.ts')
    expect(copyTextOf(assistantTool('Unknown', { value: 'ignored' }) as never)).toBe('')

    expect(
      copyTextOf({
        type: 'grouped_tool_use',
        results: [
          toolResult('first result'),
          toolResult([{ type: 'text', text: 'second result' }, { type: 'image' }]),
        ],
      } as never),
    ).toBe('first result\n\nsecond result')

    expect(
      copyTextOf({
        type: 'collapsed_read_search',
        messages: [
          toolResult('read result'),
          {
            type: 'grouped_tool_use',
            results: [toolResult([{ type: 'text', text: 'nested result' }])],
          },
          assistantText('ignored assistant'),
        ],
      } as never),
    ).toBe('read result\n\nnested result')

    expect(copyTextOf({ type: 'system', content: 'system content' } as never)).toBe(
      'system content',
    )
    expect(copyTextOf({ type: 'system', error: new Error('bad') } as never)).toBe(
      'Error: bad',
    )
    expect(copyTextOf({ type: 'system', subtype: 'bridge_status' } as never)).toBe(
      'bridge_status',
    )
    expect(
      copyTextOf({
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: 'queued prompt' },
      } as never),
    ).toBe('queued prompt')
    expect(
      copyTextOf({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }],
        },
      } as never),
    ).toBe('one\ntwo')
    expect(
      copyTextOf({
        type: 'attachment',
        attachment: { type: 'diagnostics' },
      } as never),
    ).toBe('[diagnostics]')
  })
})

describe('isNavigableMessage', () => {
  test('accepts meaningful assistant and user messages', () => {
    expect(isNavigableMessage(assistantText('answer') as never)).toBe(true)
    expect(isNavigableMessage(assistantText('') as never)).toBe(false)
    expect(isNavigableMessage(assistantTool('Bash', { command: 'pwd' }) as never)).toBe(true)
    expect(isNavigableMessage(assistantTool('Unknown', {}) as never)).toBe(false)

    expect(isNavigableMessage(userText('real prompt') as never)).toBe(true)
    expect(isNavigableMessage(userText('meta', { isMeta: true }) as never)).toBe(false)
    expect(isNavigableMessage(userText('summary', { isCompactSummary: true }) as never)).toBe(false)
    expect(
      isNavigableMessage(
        userText('<system-reminder>hidden</system-reminder>\n<command-message>slash</command-message>') as never,
      ),
    ).toBe(false)
  })

  test('filters passive system and attachment messages', () => {
    expect(isNavigableMessage({ type: 'system', subtype: 'bridge_status' } as never)).toBe(true)
    expect(isNavigableMessage({ type: 'system', subtype: 'turn_duration' } as never)).toBe(false)
    expect(isNavigableMessage({ type: 'system', subtype: 'thinking' } as never)).toBe(false)
    expect(isNavigableMessage({ type: 'grouped_tool_use' } as never)).toBe(true)
    expect(isNavigableMessage({ type: 'collapsed_read_search' } as never)).toBe(true)
    expect(
      isNavigableMessage({
        type: 'attachment',
        attachment: { type: 'queued_command' },
      } as never),
    ).toBe(true)
    expect(
      isNavigableMessage({
        type: 'attachment',
        attachment: { type: 'image' },
      } as never),
    ).toBe(false)
  })
})
