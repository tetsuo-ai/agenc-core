import React from 'react'
import { describe, expect, test } from 'vitest'

import { Box } from '../../src/tui/ink.js'
import {
  deriveTurnFileChanges,
  type TurnFileChange,
} from '../../src/tui/turn-file-changes.js'
import { TurnFileChangesSummary } from '../../src/tui/message-renderers/TurnFileChangesSummary.js'
import { renderToString } from '../../src/utils/staticRender.js'

// UX improvement coverage: a build session renders a per-file collapsed diff
// for every Write/Edit, but had no concise "here's what THIS turn changed"
// rollup. The summary derives that from the assistant message's OWN tool-use
// blocks (scoped to the turn — no global git scan) and renders one compact
// line after the turn's tool activity.

// A realistic assistant message content array: one Write (new file) and one
// Edit (existing file), matching the diff-card inputs in the codebase.
function writeBlock(file: string, content: string): unknown {
  return { type: 'tool_use', id: `w-${file}`, name: 'Write', input: { file_path: file, content } }
}
function editBlock(file: string, oldStr: string, newStr: string): unknown {
  return {
    type: 'tool_use',
    id: `e-${file}`,
    name: 'Edit',
    input: { file_path: file, old_string: oldStr, new_string: newStr },
  }
}

function renderSummary(changes: readonly TurnFileChange[], columns = 100): Promise<string> {
  return renderToString(
    <Box flexDirection="column" width={columns}>
      <TurnFileChangesSummary changes={changes} />
    </Box>,
    { columns, rows: 40 },
  )
}

describe('deriveTurnFileChanges (per-turn changed-file data source)', () => {
  test('derives a CREATE for a Write and an EDIT for an Edit, in first-touch order', () => {
    const content = [
      { type: 'text', text: 'making changes' },
      writeBlock('index.html', '<html></html>\n'),
      editBlock('styles.css', 'a{}\n', 'a{color:red}\nb{}\n'),
    ]
    const changes = deriveTurnFileChanges(content)
    expect(changes).toHaveLength(2)
    expect(changes[0]).toMatchObject({ file: 'index.html', kind: 'create' })
    expect(changes[1]).toMatchObject({ file: 'styles.css', kind: 'edit' })
    // The Edit added 2 lines and removed 1.
    expect(changes[1]?.additions).toBe(2)
    expect(changes[1]?.removals).toBe(1)
  })

  test('a turn with no file-mutating tool uses derives an empty list', () => {
    const content = [
      { type: 'text', text: 'just thinking out loud' },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
    ]
    expect(deriveTurnFileChanges(content)).toEqual([])
  })

  test('repeat ops on the same file merge into one entry; a Write then Edit stays CREATE', () => {
    const content = [
      writeBlock('app.ts', 'const a = 1\n'),
      editBlock('app.ts', 'const a = 1\n', 'const a = 1\nconst b = 2\n'),
    ]
    const changes = deriveTurnFileChanges(content)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe('create')
    // Additions accumulate across both ops (1 for the write line + 1 for the
    // appended edit line).
    expect(changes[0]?.additions).toBe(2)
  })

  test('a no-op Edit (old === new) and a malformed block contribute nothing', () => {
    const content = [
      editBlock('noop.ts', 'same\n', 'same\n'),
      { type: 'tool_use', id: 'x', name: 'Edit', input: 12345 },
      { type: 'text', text: 'hi' },
    ]
    expect(deriveTurnFileChanges(content)).toEqual([])
  })

  test('non-array / undefined content is handled defensively', () => {
    expect(deriveTurnFileChanges(undefined)).toEqual([])
    expect(deriveTurnFileChanges([])).toEqual([])
  })
})

describe('TurnFileChangesSummary (compact per-turn render)', () => {
  test('a turn with a Write + an Edit renders a summary listing both with create/edit markers', async () => {
    const changes = deriveTurnFileChanges([
      writeBlock('index.html', '<html></html>\n'),
      editBlock('styles.css', 'a{}\n', 'a{color:red}\nb{}\n'),
    ])
    const out = await renderSummary(changes)
    expect(out).toContain('files changed')
    // Both files appear.
    expect(out).toContain('index.html')
    expect(out).toContain('styles.css')
    // The created file carries the (new) marker + a '+' create marker; the
    // edited file shows +N -M stats.
    expect(out).toContain('(new)')
    expect(out).toContain('+2')
    expect(out).toContain('-1')
  })

  test('REVERT-SENSITIVITY: summary present with file ops, absent (null) with none', async () => {
    const withOps = await renderSummary(
      deriveTurnFileChanges([writeBlock('index.html', '<html></html>\n')]),
    )
    const withoutOps = await renderSummary(deriveTurnFileChanges([{ type: 'text', text: 'hi' }]))
    expect(withOps).toContain('files changed')
    expect(withOps).toContain('index.html')
    // No file ops → the component returns null → nothing rendered.
    expect(withoutOps.trim()).toBe('')
    expect(withoutOps).not.toContain('files changed')
  })

  test('a created file shows a "+" create marker + (new) distinct from the "~" edit marker', async () => {
    // Render a CREATE-only turn and an EDIT-only turn so each marker is asserted
    // in isolation (the compact summary may pack several files onto one row).
    const createOut = await renderSummary(deriveTurnFileChanges([writeBlock('new.ts', 'x\n')]))
    const editOut = await renderSummary(deriveTurnFileChanges([editBlock('old.ts', 'a\n', 'b\n')]))
    // Create: '+ new.ts (new)' — the new-file marker and label are present.
    expect(createOut).toContain('+ new.ts')
    expect(createOut).toContain('(new)')
    // Edit: '~ old.ts' — the edit marker, and NO (new) label.
    expect(editOut).toContain('~ old.ts')
    expect(editOut).not.toContain('(new)')
  })

  test('a long list of changed files does NOT overflow the viewport width', async () => {
    const columns = 80
    // 20 changed files — more than the inline cap — at a narrow width.
    const changes = deriveTurnFileChanges(
      Array.from({ length: 20 }, (_v, i) => writeBlock(`file-${i}.ts`, 'x\n')),
    )
    const out = await renderSummary(changes, columns)
    // Every rendered row stays within the terminal width (no overflow).
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(columns)
    }
    // The remainder past the cap collapses to a "… +N more" tail rather than
    // listing all 20 files.
    expect(out).toMatch(/… \+\d+ more/)
  })

  test('a very long single file path is truncated and never overflows the row', async () => {
    const columns = 60
    const longPath = `/very/deeply/nested/${'segment/'.repeat(8)}component.tsx`
    const out = await renderSummary(
      deriveTurnFileChanges([editBlock(longPath, 'a\n', 'b\n')]),
      columns,
    )
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(columns)
    }
    expect(out).toContain('files changed')
  })

  test('an empty changes array renders nothing', async () => {
    const out = await renderSummary([])
    expect(out.trim()).toBe('')
  })
})
