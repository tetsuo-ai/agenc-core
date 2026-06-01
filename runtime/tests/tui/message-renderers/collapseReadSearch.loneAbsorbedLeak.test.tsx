import { describe, expect, it, vi } from 'vitest'

// GAP #11 regression: when a lone Read/Grep group also contains silently
// absorbed meta-ops (Snip / ToolSearch), the un-collapsed lone group must NOT
// leak those absorbed rows (or their results) into the default transcript.
//
// ToolSearch is only absorbed-silently when fullscreen mode is enabled, so this
// suite forces it on. `feature()` stays a no-op (HISTORY_SNIP off is fine —
// ToolSearch alone exercises the leak path).
vi.mock('bun:bundle', () => ({
  feature: () => false,
}))
vi.mock('../../../src/utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => true,
}))
vi.mock('../../../src/tools/REPLTool/primitiveTools.js', () => ({
  getReplPrimitiveTools: () => [],
}))

import { collapseReadSearchGroups } from '../../../src/utils/collapseReadSearch.js'
import { TOOL_SEARCH_TOOL_NAME } from '../../../src/tools/ToolSearchTool/constants.js'
import type { Tools } from '../../../src/tools/Tool.js'

// Minimal Read/Grep tools that report themselves as read/search. ToolSearch is
// recognized by name inside getToolSearchOrReadInfo (before any registry
// lookup), so it does NOT need to appear in this list — matching how the live
// daemon classifies it.
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

function use(id: string, name: string, input: unknown): any {
  return {
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-05-30T00:00:00.000Z',
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
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
function toolUseNames(out: any[]): string[] {
  return out
    .filter(
      (m) => m?.type === 'assistant' && m.message.content[0]?.type === 'tool_use',
    )
    .map((m) => m.message.content[0].name)
}
function toolResultIds(out: any[]): string[] {
  return out
    .filter(
      (m) => m?.type === 'user' && m.message.content[0]?.type === 'tool_result',
    )
    .map((m) => m.message.content[0].tool_use_id)
}

describe('collapseReadSearchGroups — lone group does not leak absorbed ToolSearch (GAP #11)', () => {
  it('un-collapses a lone Read but keeps an interleaved ToolSearch row (and its result) hidden', () => {
    const search = uid()
    const read = uid()
    const out = collapseReadSearchGroups(
      [
        use(search, TOOL_SEARCH_TOOL_NAME, { query: 'select:Foo' }),
        result(search, 'loaded 1 tool'),
        use(read, 'FileRead', { file_path: '/repo/PLAN.md' }),
        result(read, 'file body'),
      ],
      tools,
    )

    // The lone Read is un-collapsed (no count summary).
    expect(out.some(isCollapsedGroup)).toBe(false)
    // Only the Read call + its result survive; ToolSearch stays absorbed.
    expect(toolUseNames(out)).toEqual(['FileRead'])
    expect(toolUseNames(out)).not.toContain(TOOL_SEARCH_TOOL_NAME)
    expect(toolResultIds(out)).toEqual([read])
    expect(toolResultIds(out)).not.toContain(search)
  })

  it('leaks nothing when the lone op is a Grep and ToolSearch trails it', () => {
    const grep = uid()
    const search = uid()
    const out = collapseReadSearchGroups(
      [
        use(grep, 'Grep', { pattern: 'IO_NUMBER' }),
        result(grep, 'Found 2 matches'),
        use(search, TOOL_SEARCH_TOOL_NAME, { query: 'webfetch' }),
        result(search, 'loaded WebFetch'),
      ],
      tools,
    )

    expect(out.some(isCollapsedGroup)).toBe(false)
    expect(toolUseNames(out)).toEqual(['Grep'])
    expect(toolResultIds(out)).toEqual([grep])
  })

  it('a lone Read with NO absorbed ops still emits the call + result unchanged', () => {
    const read = uid()
    const out = collapseReadSearchGroups(
      [use(read, 'FileRead', { file_path: '/repo/a.md' }), result(read, 'x')],
      tools,
    )
    expect(out.some(isCollapsedGroup)).toBe(false)
    expect(toolUseNames(out)).toEqual(['FileRead'])
    expect(toolResultIds(out)).toEqual([read])
  })
})
