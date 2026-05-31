import { describe, expect, test, vi } from 'vitest'

// Keep fullscreen-specific bash bucketing out of the way; these tests only
// exercise non-collapsible Edit retries.
vi.mock('../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))

// REPL primitives are only consulted when a tool is missing from `tools`; our
// fixtures always include the tool, but stub it to avoid pulling the real tree.
vi.mock('../../tools/REPLTool/primitiveTools.js', () => ({
  getReplPrimitiveTools: () => [],
}))

import { collapseReadSearchGroups } from '../../utils/collapseReadSearch.js'

// A minimal tool whose absence of `isSearchOrReadCommand` makes the collapser
// treat it as a non-collapsible tool use (exactly like the real Edit tool for
// the rollup path).
const editTool = { name: 'Edit' } as any
const tools = [editTool] as any

let seq = 0
function uid(): string {
  return `id-${seq++}`
}

function editToolUse(id: string, filePath: string, oldString: string): any {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-05-30T00:00:00.000Z',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'Edit',
          input: { file_path: filePath, old_string: oldString, new_string: 'x' },
        },
      ],
    },
  }
}

function toolResult(id: string, isError: boolean, content: string): any {
  return {
    type: 'user',
    uuid: uid(),
    timestamp: '2026-05-30T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: isError,
          content,
        },
      ],
    },
  }
}

function errorResult(id: string, reason: string): any {
  return toolResult(id, true, `<tool_use_error>${reason}</tool_use_error>`)
}

function isEditToolUse(msg: any): boolean {
  return (
    msg?.type === 'assistant' && msg.message.content[0]?.type === 'tool_use'
  )
}

function retryCountOf(msg: any): number | undefined {
  return msg?.message?.content?.[0]?.retriedFailureCount
}

describe('collapseReadSearchGroups - failed retry rollup', () => {
  test('rolls up consecutive same-target failed Edits into one row with a count', () => {
    const ids = Array.from({ length: 5 }, () => uid())
    const messages: any[] = []
    for (const id of ids) {
      messages.push(editToolUse(id, '/repo/lexer.c', 'foo'))
      messages.push(errorResult(id, 'File has not been read yet'))
    }

    const out = collapseReadSearchGroups(messages, tools)

    const editRows = out.filter(isEditToolUse)
    expect(editRows).toHaveLength(1)
    // The single kept row is annotated with the total attempt count.
    expect(retryCountOf(editRows[0])).toBe(5)
    // It keeps the LAST attempt's tool-use id.
    expect(editRows[0].message.content[0].id).toBe(ids[4])

    // Only the last error result survives (1 result, not 5).
    const resultRows = out.filter(
      (m: any) =>
        m.type === 'user' && m.message.content[0]?.type === 'tool_result',
    )
    expect(resultRows).toHaveLength(1)
    expect(resultRows[0].message.content[0].tool_use_id).toBe(ids[4])
  })

  test('does not roll up edits to different files', () => {
    const a = uid()
    const b = uid()
    const messages = [
      editToolUse(a, '/repo/a.c', 'foo'),
      errorResult(a, 'File has not been read yet'),
      editToolUse(b, '/repo/b.c', 'bar'),
      errorResult(b, 'File has not been read yet'),
    ]

    const out = collapseReadSearchGroups(messages, tools)
    const editRows = out.filter(isEditToolUse)
    expect(editRows).toHaveLength(2)
    // Distinct targets => no rollup annotation.
    expect(retryCountOf(editRows[0])).toBeUndefined()
    expect(retryCountOf(editRows[1])).toBeUndefined()
  })

  test('does not roll up when the previous attempt SUCCEEDED', () => {
    const a = uid()
    const b = uid()
    const messages = [
      editToolUse(a, '/repo/lexer.c', 'foo'),
      toolResult(a, false, 'ok'),
      editToolUse(b, '/repo/lexer.c', 'foo'),
      toolResult(b, false, 'ok'),
    ]

    const out = collapseReadSearchGroups(messages, tools)
    const editRows = out.filter(isEditToolUse)
    // Two successful edits to the same file are independent rows.
    expect(editRows).toHaveLength(2)
  })

  test('annotates the final (successful) attempt after earlier failures', () => {
    const fail1 = uid()
    const fail2 = uid()
    const ok = uid()
    const messages = [
      editToolUse(fail1, '/repo/lexer.c', 'foo'),
      errorResult(fail1, 'String to replace not found in file'),
      editToolUse(fail2, '/repo/lexer.c', 'foo'),
      errorResult(fail2, 'String to replace not found in file'),
      editToolUse(ok, '/repo/lexer.c', 'foo'),
      toolResult(ok, false, 'updated'),
    ]

    const out = collapseReadSearchGroups(messages, tools)
    const editRows = out.filter(isEditToolUse)
    expect(editRows).toHaveLength(1)
    // 2 prior failures + the successful attempt = 3 folded attempts.
    expect(retryCountOf(editRows[0])).toBe(3)
    expect(editRows[0].message.content[0].id).toBe(ok)
  })

  test('assistant text between attempts breaks the rollup', () => {
    const a = uid()
    const b = uid()
    const messages = [
      editToolUse(a, '/repo/lexer.c', 'foo'),
      errorResult(a, 'File has not been read yet'),
      {
        type: 'assistant',
        uuid: uid(),
        timestamp: '2026-05-30T00:00:00.000Z',
        message: {
          id: 'msg-text',
          role: 'assistant',
          content: [{ type: 'text', text: 'Let me reconsider.' }],
        },
      },
      editToolUse(b, '/repo/lexer.c', 'foo'),
      errorResult(b, 'File has not been read yet'),
    ]

    const out = collapseReadSearchGroups(messages, tools)
    const editRows = out.filter(isEditToolUse)
    expect(editRows).toHaveLength(2)
  })
})
