import React from 'react'
import { describe, expect, test } from 'vitest'

import { Box } from '../../src/tui/ink.js'
import {
  ApprovalCard,
  type ApprovalDiffPreview,
} from '../../src/tui/components/v2/primitives.js'
import { buildEditDiffPreview } from '../../src/tui/edit-diff-preview.js'
import { renderToString } from '../../src/utils/staticRender.js'

// UX improvement coverage: the tool-approval popup now shows a BOUNDED preview
// of the change (the diff for an Edit, first lines of content for a new-file
// Write) INSIDE the dialog, so a Write/Edit is never approved blind.
//
// CRITICAL: this must NOT regress the height/overflow discipline that the
// approval popup was recently repaired for. The preview is part of the existing
// maxHeight + overflow:'hidden' budget and is the FIRST optional block shed when
// the slot is tight — never the primary action picker.

// A realistic Edit diff: one changed line + one added line.
function editPreview(): ApprovalDiffPreview {
  const built = buildEditDiffPreview('Edit', {
    file_path: 'src/primes.ts',
    old_string: 'const a = 1\nconst b = 2\n',
    new_string: 'const a = 10\nconst b = 2\nconst c = 3\n',
  })
  if (built === null) throw new Error('expected a diff preview for the Edit')
  return {
    file: built.file,
    stats: built.stats,
    lines: built.lines,
    remaining: built.remaining,
  }
}

// A long Write diff so the in-dialog cap collapses the tail to "… +N more".
function longWritePreview(): ApprovalDiffPreview {
  const lines = Array.from({ length: 40 }, (_v, i) => `line ${i}`).join('\n')
  const built = buildEditDiffPreview('Write', {
    file_path: 'src/big.ts',
    content: `${lines}\n`,
  })
  if (built === null) throw new Error('expected a diff preview for the Write')
  return {
    file: built.file,
    stats: built.stats,
    lines: built.lines,
    remaining: built.remaining,
  }
}

function renderEditApproval(
  rows: number,
  opts: { withPreview: boolean } = { withPreview: true },
  columns = 116,
): Promise<string> {
  const preview = opts.withPreview ? editPreview() : undefined
  return renderToString(
    <Box flexDirection="column">
      <ApprovalCard
        risk="low"
        title="tool · edit · medium-risk approval"
        command="src/primes.ts"
        facts={[
          { label: 'tool', value: 'edit' },
          { label: 'scope', value: 'session', color: 'text2' },
          { label: 'request', value: 'req-77' },
          { label: 'confirmation', value: 'enter' },
        ]}
        note="untrusted policy: approve every call"
        {...(preview !== undefined ? { diffPreview: preview } : {})}
        confirmLabel="enter approve · 2 session · 3 deny"
      />
    </Box>,
    { columns, rows },
  )
}

function renderBashApproval(rows = 40, columns = 116): Promise<string> {
  // A Bash approval carries no diffPreview (the wiring builds none for non-file
  // tools), so it must show the command and never a DIFF box.
  return renderToString(
    <Box flexDirection="column">
      <ApprovalCard
        risk="low"
        title="tool · bash · needs approval"
        command="rm -rf build"
        facts={[{ label: 'tool', value: 'bash' }]}
        confirmLabel="enter approve · 2 session · 3 deny"
      />
    </Box>,
    { columns, rows },
  )
}

function countLines(out: string, predicate: (line: string) => boolean): number {
  return out.split('\n').filter(predicate).length
}

describe('ApprovalCard diff preview (in-dialog change preview)', () => {
  test('an Edit approval shows a bounded diff with added/removed lines', async () => {
    const out = await renderEditApproval(40)
    // The DIFF box header + the changed file is present.
    expect(out).toContain('DIFF')
    expect(out).toContain('primes.ts')
    // Both an added (+) and a removed (-) line are visible in the preview.
    // The Edit turns `const a = 1` into `const a = 10` (rem+add) and appends
    // `const c = 3` (add).
    expect(out).toContain('const a = 1')
    expect(out).toContain('const a = 10')
    expect(out).toContain('const c = 3')
    const sigilRows = out.split('\n').filter((l) => l.includes('const a'))
    expect(sigilRows.some((l) => l.includes('-'))).toBe(true)
    expect(sigilRows.some((l) => l.includes('+'))).toBe(true)
  })

  test('the diff preview does NOT push out the action picker', async () => {
    const out = await renderEditApproval(40)
    expect(out).toContain('approve once')
    expect(out).toContain('approve for session')
    expect(out).toContain('deny')
  })

  test('REGRESSION: the popup with a diff still fits its border (one top, one bottom)', async () => {
    const out = await renderEditApproval(40)
    const lines = out.split('\n').filter((line) => line.trim().length > 0)
    const firstBorderIndex = lines.findIndex((line) => line.includes('┌'))
    const lastBorderIndex = lines
      .map((line) => line.includes('└'))
      .lastIndexOf(true)
    expect(firstBorderIndex).toBe(0)
    expect(lastBorderIndex).toBe(lines.length - 1)
    // Exactly one OUTER popup top/bottom border. The inner DiffInline box draws
    // its own '┌'/'└' line corners, so assert the popup border specifically by
    // checking nothing renders after the last bottom-border line.
    const renderedRows = out.split('\n').filter((l) => l.length > 0).length
    expect(lastBorderIndex).toBe(renderedRows - 1)
  })

  test('REGRESSION: the popup with a diff never exceeds the available rows', async () => {
    for (const rows of [16, 18, 20, 24, 40]) {
      const out = await renderEditApproval(rows)
      const renderedRows = out.split('\n').filter((l) => l.length > 0).length
      expect(renderedRows).toBeLessThanOrEqual(rows)
      // Still bounded by a closing bottom border at every height.
      expect(out).toContain('└')
    }
  })

  test('a tight slot DROPS the diff preview BEFORE the action legend', async () => {
    // At a tight height the diff preview (the largest optional block) is shed,
    // but the primary action picker survives.
    const tight = await renderEditApproval(16)
    expect(tight).not.toContain('DIFF')
    expect(tight).toContain('approve once')
  })

  test('a long Write diff collapses its tail to a "… +N more" affordance row', async () => {
    const out = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · write · needs approval"
          command="src/big.ts"
          facts={[{ label: 'tool', value: 'write' }]}
          diffPreview={longWritePreview()}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    expect(out).toContain('DIFF')
    expect(out).toMatch(/… \+\d+ more lines · ctrl\+w d for full diff/)
    // The action picker still survives alongside the collapsed preview.
    expect(out).toContain('approve once')
  })

  test('a Bash approval shows NO diff preview (command-only card)', async () => {
    const out = await renderBashApproval()
    expect(out).not.toContain('DIFF')
    expect(out).toContain('rm -rf build')
    expect(out).toContain('approve once')
  })

  test('an Edit approval labels the inline diff EDIT (matching the transcript card)', async () => {
    // The approval path passes op = (tool === 'Write' ? 'CREATE' : 'EDIT'),
    // the SAME label the post-approval TRANSCRIPT diff card uses.
    const preview = { ...editPreview(), op: 'EDIT' as const }
    const out = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · edit · medium-risk approval"
          command="src/primes.ts"
          facts={[{ label: 'tool', value: 'edit' }]}
          diffPreview={preview}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    expect(out).toContain('EDIT')
    // The neutral DIFF verb must NOT leak when the op is known.
    expect(out).not.toContain('DIFF')
    expect(out).toContain('primes.ts')
  })

  test('a Write approval labels the inline diff CREATE (new-file write)', async () => {
    const preview = { ...longWritePreview(), op: 'CREATE' as const }
    const out = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · write · needs approval"
          command="src/big.ts"
          facts={[{ label: 'tool', value: 'write' }]}
          diffPreview={preview}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    expect(out).toContain('CREATE')
    expect(out).not.toContain('DIFF')
    expect(out).toContain('big.ts')
  })

  test('REVERT-SENSITIVITY: the diff-box header verb falls back to DIFF only when op is absent', async () => {
    // With op set, the inline diff header reads EDIT; without it (the old
    // behavior), it falls back to the neutral DIFF. The card TITLE independently
    // contains "EDIT", so assert against the diff-box header ROW specifically:
    // the row that carries the file name + stats.
    const diffHeaderRow = (out: string): string =>
      out
        .split('\n')
        .find((line) => line.includes('primes.ts') && line.includes('+2 -1')) ?? ''
    const withOp = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · edit · medium-risk approval"
          command="src/primes.ts"
          facts={[{ label: 'tool', value: 'edit' }]}
          diffPreview={{ ...editPreview(), op: 'EDIT' }}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    const withoutOp = await renderEditApproval(40)
    expect(diffHeaderRow(withOp)).toContain('EDIT')
    expect(diffHeaderRow(withOp)).not.toContain('DIFF')
    expect(diffHeaderRow(withoutOp)).toContain('DIFF')
    expect(diffHeaderRow(withoutOp)).not.toContain('EDIT')
  })

  test('REVERT-SENSITIVITY: diff present with the prop, absent without it', async () => {
    const withPreview = await renderEditApproval(40, { withPreview: true })
    const withoutPreview = await renderEditApproval(40, { withPreview: false })
    expect(withPreview).toContain('DIFF')
    expect(withPreview).toContain('const c = 3')
    // Same card, no diffPreview prop → no DIFF box, but the card still renders
    // its command + action legend (the pre-improvement behavior).
    expect(withoutPreview).not.toContain('DIFF')
    expect(withoutPreview).not.toContain('const c = 3')
    expect(withoutPreview).toContain('approve once')
    // Guard: both still fit one closing bottom border (no overflow regression).
    expect(countLines(withPreview, (l) => l.includes('└'))).toBeGreaterThanOrEqual(1)
    expect(countLines(withoutPreview, (l) => l.includes('└'))).toBe(1)
  })
})
