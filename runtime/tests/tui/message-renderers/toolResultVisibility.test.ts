import { describe, expect, it, vi } from 'vitest'

// `bun:bundle` feature() is a no-op in tests.
vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import {
  formatStructuredToolResult,
  makeToolResultMessage,
} from '../../../src/tui/session-transcript.js'
import { shouldShowUserMessage } from '../../../src/utils/messages.js'
import type { NormalizedMessage } from '../../../src/types/message.js'

/**
 * Build a daemon tool-result message exactly the way the live transcript path
 * does: the structured result block comes from formatStructuredToolResult and
 * is wrapped by makeToolResultMessage (matching adaptTranscriptEvents /
 * pushToolResult in session-transcript.ts).
 */
function daemonResult(opts: {
  readonly id: string
  readonly toolName: string
  readonly eventType: string
  readonly payload: Record<string, unknown>
  readonly isError?: boolean
}): NormalizedMessage {
  const structured = formatStructuredToolResult(
    opts.toolName,
    opts.eventType,
    opts.payload,
  )
  return makeToolResultMessage(
    opts.id,
    structured,
    opts.isError ?? false,
  ) as NormalizedMessage
}

describe('live daemon tool results are not filtered out (FIX 1)', () => {
  // The bug: makeToolResultMessage hardcoded isMeta: true, and
  // shouldShowUserMessage DROPS isMeta user messages when NOT in transcript
  // mode — so every tool result was filtered before it could render under its
  // call row. After the fix the message is not isMeta and survives the filter.

  it('FileRead result is shown in live (non-transcript) mode', () => {
    const msg = daemonResult({
      id: 'tu_read',
      toolName: 'FileRead',
      eventType: 'tool_call_completed',
      payload: {
        result: { path: 'PLAN.md', startLine: 1, endLine: 12, content: 'x' },
      },
    })
    expect(msg.isMeta).toBeFalsy()
    expect(shouldShowUserMessage(msg, /* isTranscriptMode */ false)).toBe(true)
  })

  it('Grep result is shown in live (non-transcript) mode', () => {
    const msg = daemonResult({
      id: 'tu_grep',
      toolName: 'Grep',
      eventType: 'tool_call_completed',
      payload: {
        result: {
          pattern: 'IO_NUMBER',
          matches: [{ file: 'a.c', line: 1, content: 'IO_NUMBER' }],
        },
      },
    })
    expect(msg.isMeta).toBeFalsy()
    expect(shouldShowUserMessage(msg, false)).toBe(true)
  })

  it('exec_command result is shown in live (non-transcript) mode', () => {
    const msg = daemonResult({
      id: 'tu_exec',
      toolName: 'exec_command',
      eventType: 'exec_command_end',
      payload: { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 },
    })
    expect(msg.isMeta).toBeFalsy()
    expect(shouldShowUserMessage(msg, false)).toBe(true)
  })

  it('Edit result is shown in live (non-transcript) mode', () => {
    const msg = daemonResult({
      id: 'tu_edit',
      toolName: 'Edit',
      eventType: 'tool_call_completed',
      payload: {
        result: {
          path: 'a.c',
          diff: '--- a/a.c\n+++ b/a.c\n@@ -1 +1 @@\n-a\n+b',
        },
      },
    })
    expect(msg.isMeta).toBeFalsy()
    expect(shouldShowUserMessage(msg, false)).toBe(true)
  })

  it('an errored tool result is also shown in live mode', () => {
    const msg = daemonResult({
      id: 'tu_exec_fail',
      toolName: 'exec_command',
      eventType: 'exec_command_end',
      payload: { stdout: '', stderr: 'boom', exitCode: 2, durationMs: 1 },
      isError: true,
    })
    expect(msg.isMeta).toBeFalsy()
    expect(shouldShowUserMessage(msg, false)).toBe(true)
  })
})
