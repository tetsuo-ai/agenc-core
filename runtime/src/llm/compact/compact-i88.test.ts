import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('axios', () => ({
  default: {},
  AxiosError: class AxiosError extends Error {},
}))

import {
  COMPACT_TOOL_RESULT_DROP_BYTES,
  filterLargeToolResultsForCompact,
  loadCompactToolResultIndex,
} from './compact.ts'
import { SessionStore } from '../../session/session-store.js'

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
  let home = ''
  let origAgencHome = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agenc-compact-i88-'))
    origAgencHome = process.env.AGENC_HOME ?? ''
    process.env.AGENC_HOME = home
  })

  afterEach(() => {
    if (origAgencHome) process.env.AGENC_HOME = origAgencHome
    else delete process.env.AGENC_HOME
    if (home) rmSync(home, { recursive: true, force: true })
  })

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

  test('uses the per-turn index as a fast path for turns below threshold', () => {
    const huge = 'x'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES * 2)
    const messages = [
      {
        type: 'assistant',
        message: { id: 'a-1', content: [{ type: 'text', text: 'turn-1' }] },
      },
      userWithToolResult('call-fast-path', huge),
      {
        type: 'assistant',
        message: { id: 'a-2', content: [{ type: 'text', text: 'turn-2' }] },
      },
      userWithToolResult('call-filter-me', huge),
    ]

    const result = filterLargeToolResultsForCompact(messages as never[], {
      toolResultBytesByTurn: new Map([
        ['turn-1', COMPACT_TOOL_RESULT_DROP_BYTES - 1],
        ['turn-2', COMPACT_TOOL_RESULT_DROP_BYTES + 1],
      ]),
      toolCallTurnIds: new Map([
        ['call-fast-path', 'turn-1'],
        ['call-filter-me', 'turn-2'],
      ]),
    })

    // The first turn is trusted from the index and skipped wholesale,
    // even though the tool_result payload is large.
    expect(result.messages[1]).toBe(messages[1])
    // The second turn is over the threshold, so the real per-result
    // scan still drops the oversized payload.
    expect(result.messages[3]).not.toBe(messages[3])
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0]!.toolCallId).toBe('call-filter-me')
  })

  test('loads the persisted compaction index snapshot when no rolloutStore is injected', () => {
    const store = new SessionStore({
      cwd: '/home/test-compact-i88',
      sessionId: 'agent-compact-i88',
      agencVersion: '0.2.0',
    })
    store.open({
      sessionId: 'agent-compact-i88',
      timestamp: new Date().toISOString(),
      cwd: '/home/test-compact-i88',
      originator: 'agenc-cli',
      agencVersion: '0.2.0',
    })
    store.append(
      {
        id: 'tool-complete',
        seq: 2,
        msg: {
          type: 'tool_call_completed',
          payload: {
            callId: 'call-from-snapshot',
            result: 'x'.repeat(COMPACT_TOOL_RESULT_DROP_BYTES + 64),
            isError: false,
          },
        },
      },
      {
        turnId: 'turn-from-snapshot',
        toolResultBytes: COMPACT_TOOL_RESULT_DROP_BYTES + 64,
      },
    )
    store.close()

    const compactionIndex = loadCompactToolResultIndex({
      agentId: 'agent-compact-i88',
      cwd: '/home/test-compact-i88',
    } as never)

    expect(compactionIndex).toBeDefined()
    expect(
      compactionIndex!.toolResultBytesByTurn.get('turn-from-snapshot'),
    ).toBe(COMPACT_TOOL_RESULT_DROP_BYTES + 64)
    expect(
      compactionIndex!.tokenEstimateByTurn?.get('turn-from-snapshot'),
    ).toBe(
      Math.ceil((COMPACT_TOOL_RESULT_DROP_BYTES + 64) / 4),
    )
    expect(compactionIndex!.toolCallTurnIds.get('call-from-snapshot')).toBe(
      'turn-from-snapshot',
    )
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
