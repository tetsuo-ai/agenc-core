import { describe, expect, test } from 'vitest'

import {
  COMPACT_TOOL_RESULT_DROP_BYTES,
  filterLargeToolResultsForCompact,
} from './compact.ts'

/**
 * I-88 compact-prompt half: verify `filterLargeToolResultsForCompact`
 * drops tool_results ≥ 50KB before the compact prompt is built, keeps
 * the surrounding tool_use/tool_result pairing intact, and reports
 * `{turnId, toolCallId, bytes}` for each drop.
 */

function userWithToolResult(
  toolUseId: string,
  content: unknown,
): {
  type: 'user'
  message: { content: unknown[] }
} {
  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
  }
}

describe('I-88 filterLargeToolResultsForCompact', () => {
  test('exports the 50KB threshold constant', () => {
    expect(COMPACT_TOOL_RESULT_DROP_BYTES).toBe(50 * 1024)
  })

  test('drops tool_result whose string content is ≥ 50KB', () => {
    const big = 'x'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES)
    const small = 'short tool output'
    const messages = [
      userWithToolResult('call-big', big),
      userWithToolResult('call-small', small),
    ]

    const result = filterLargeToolResultsForCompact(messages as never[])

    // Small one is untouched.
    expect(result.messages[1]).toBe(messages[1])

    // Big one is replaced: original reference differs, tool_use_id
    // preserved, and content swapped for the drop placeholder.
    expect(result.messages[0]).not.toBe(messages[0])
    const bigBlock = (result.messages[0] as any).message.content[0]
    expect(bigBlock.type).toBe('tool_result')
    expect(bigBlock.tool_use_id).toBe('call-big')
    expect(typeof bigBlock.content).toBe('string')
    expect(bigBlock.content).toMatch(/^\[tool_result dropped: \d+ bytes/)

    // Drop record emitted.
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]).toMatchObject({
      toolCallId: 'call-big',
      turnId: 'unknown',
    })
    expect(result.dropped[0]!.bytes).toBeGreaterThanOrEqual(
      COMPACT_TOOL_RESULT_DROP_BYTES,
    )
  })

  test('keeps tool_results below threshold untouched and returns same array', () => {
    const messages = [
      userWithToolResult('call-1', 'tiny'),
      userWithToolResult('call-2', 'also tiny'),
    ]
    const result = filterLargeToolResultsForCompact(messages as never[])
    expect(result.dropped).toHaveLength(0)
    // No changes → identity on the outer array is preserved.
    expect(result.messages).toBe(messages)
  })

  test('honors caller-supplied turnId resolver on dropped entries', () => {
    const big = 'x'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES + 10)
    const messages = [userWithToolResult('call-big', big)]

    const result = filterLargeToolResultsForCompact(messages as never[], {
      getTurnIdForMessage: () => 'turn-42',
    })

    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]!.turnId).toBe('turn-42')
    expect(result.dropped[0]!.toolCallId).toBe('call-big')
  })

  test('measures structured (array) tool_result content by text bytes', () => {
    const bigText = 'y'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES + 1)
    const messages = [
      userWithToolResult('call-structured', [
        { type: 'text', text: bigText },
      ]),
    ]
    const result = filterLargeToolResultsForCompact(messages as never[])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]!.toolCallId).toBe('call-structured')
    expect(result.dropped[0]!.bytes).toBeGreaterThanOrEqual(
      COMPACT_TOOL_RESULT_DROP_BYTES,
    )
  })

  test('custom threshold=0 disables the filter entirely', () => {
    const big = 'z'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES + 1)
    const messages = [userWithToolResult('call-big', big)]
    const result = filterLargeToolResultsForCompact(messages as never[], {
      thresholdBytes: 0,
    })
    expect(result.dropped).toHaveLength(0)
    expect(result.messages).toBe(messages)
  })

  test('leaves non-tool_result blocks and non-user messages untouched', () => {
    const messages = [
      { type: 'user', message: { content: 'plain string body' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'a'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES) },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'unrelated' },
            {
              type: 'tool_result',
              tool_use_id: 'call-big',
              content: 'b'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES),
            },
          ],
        },
      },
    ]
    const result = filterLargeToolResultsForCompact(messages as never[])
    // Only the final message's tool_result is dropped.
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]!.toolCallId).toBe('call-big')
    // First two messages unchanged identity.
    expect(result.messages[0]).toBe(messages[0])
    expect(result.messages[1]).toBe(messages[1])
  })
})
