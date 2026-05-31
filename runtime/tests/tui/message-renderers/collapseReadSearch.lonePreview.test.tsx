import React from 'react'
import { describe, expect, it, test, vi } from 'vitest'

// `bun:bundle` feature() is a no-op in tests (TEAMMEM / HISTORY_SNIP off).
vi.mock('bun:bundle', () => ({
  feature: () => false,
}))
// Keep fullscreen bash bucketing out of the way.
vi.mock('../../../src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => false,
}))
// Isolate the collapser from the real REPL-primitive fallback registry so the
// pure-behavior cases below depend only on the `tools` we pass in.
vi.mock('../../../src/tools/REPLTool/primitiveTools.js', () => ({
  getReplPrimitiveTools: () => [],
}))

import { collapseReadSearchGroups } from '../../../src/utils/collapseReadSearch.js'
import type { Tools } from '../../../src/tools/Tool.js'

// Minimal Read/Grep tools that report themselves as read/search via
// isSearchOrReadCommand — exactly the signal the real Canonical FileRead/Grep
// tools expose to the collapser.
const readTool = {
  name: 'FileRead',
  isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
} as any
const grepTool = {
  name: 'Grep',
  isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
} as any
const tools = [readTool, grepTool] as unknown as Tools

let seq = 0
function uid(): string {
  return `id-${seq++}`
}

function readUse(id: string, filePath: string): any {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-05-30T00:00:00.000Z',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'FileRead', input: { file_path: filePath } },
      ],
    },
  }
}

function grepUse(id: string, pattern: string): any {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-05-30T00:00:00.000Z',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern } }],
    },
  }
}

function result(id: string, content: string): any {
  return {
    type: 'user',
    uuid: uid(),
    timestamp: '2026-05-30T00:00:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, is_error: false, content },
      ],
    },
  }
}

function isCollapsedGroup(m: any): boolean {
  return m?.type === 'collapsed_read_search'
}
function isToolUse(m: any): boolean {
  return m?.type === 'assistant' && m.message.content[0]?.type === 'tool_use'
}
function isToolResult(m: any): boolean {
  return m?.type === 'user' && m.message.content[0]?.type === 'tool_result'
}

describe('collapseReadSearchGroups - lone read/search preview (FIX 2)', () => {
  it('does NOT collapse a single Read — emits the call + result verbatim', () => {
    const id = uid()
    const out = collapseReadSearchGroups([readUse(id, '/repo/PLAN.md'), result(id, 'x')], tools)
    expect(out.some(isCollapsedGroup)).toBe(false)
    // Original tool-use + tool-result survive so the normal pair renderer (which
    // shows "Read N lines") runs instead of the count summary.
    expect(out.filter(isToolUse)).toHaveLength(1)
    expect(out.filter(isToolResult)).toHaveLength(1)
    expect(out.filter(isToolResult)[0].message.content[0].tool_use_id).toBe(id)
  })

  it('does NOT collapse a single Grep — emits the call + result verbatim', () => {
    const id = uid()
    const out = collapseReadSearchGroups([grepUse(id, 'IO_NUMBER'), result(id, 'x')], tools)
    expect(out.some(isCollapsedGroup)).toBe(false)
    expect(out.filter(isToolUse)).toHaveLength(1)
    expect(out.filter(isToolResult)).toHaveLength(1)
  })

  test('STILL collapses a run of 2+ consecutive reads into one summary', () => {
    const a = uid()
    const b = uid()
    const out = collapseReadSearchGroups(
      [readUse(a, '/repo/a.md'), result(a, 'x'), readUse(b, '/repo/b.md'), result(b, 'y')],
      tools,
    )
    // The multi-call run keeps the tidy collapsed summary.
    expect(out.some(isCollapsedGroup)).toBe(true)
    expect(out.filter(isToolUse)).toHaveLength(0)
  })

  test('STILL collapses a mixed read + grep run into one summary', () => {
    const a = uid()
    const b = uid()
    const out = collapseReadSearchGroups(
      [readUse(a, '/repo/a.md'), result(a, 'x'), grepUse(b, 'foo'), result(b, 'y')],
      tools,
    )
    expect(out.some(isCollapsedGroup)).toBe(true)
  })
})
