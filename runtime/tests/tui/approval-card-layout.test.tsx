import React from 'react'
import { describe, expect, test } from 'vitest'

import { Box } from '../../src/tui/ink.js'
import { ApprovalCard } from '../../src/tui/components/v2/primitives.js'
import { renderToString } from '../../src/utils/staticRender.js'

// Regression coverage for the tool-approval popup rendering bugs:
//   (A) the title prefix was applied twice and hardcoded "bash"
//       (`tool · bash · tool · write · …`).
//   (B) the popup overflowed its slot, clipping the body and bleeding the
//       action legend / confirm row onto the footer below the border.
//   (C) the action legend [1]/[2]/[3] must stay visible — it is the primary
//       action and must never be the thing that gets clipped.
//
// The approval popup is rendered through the workbench overlay slot, which is a
// fixed-height region. These tests render the card at constrained viewports and
// assert the title appears exactly once with the real tool, the body fits inside
// the popup border, and the action legend is present.

function renderWriteApproval(rows: number, columns = 116): Promise<string> {
  return renderToString(
    <Box flexDirection="column">
      <ApprovalCard
        // The caller (permission-requests.tsx) owns the full canonical prefix.
        risk="low"
        title="tool · write · medium-risk approval"
        command="primes.ts"
        facts={[
          { label: 'tool', value: 'write' },
          { label: 'scope', value: 'medium', color: 'warning' },
          { label: 'request', value: 'req-123' },
          { label: 'confirmation', value: 'enter' },
        ]}
        note="untrusted policy: approve every call"
        confirmLabel="enter approve · 2 session · 3 deny"
      />
    </Box>,
    { columns, rows },
  )
}

// Count how many top borders a "single" box style draws. A correctly bounded
// popup draws exactly one top border line and one bottom border line; an
// overflowing inner box used to leave a stray `└───┘` bottom with no matching
// top (the corruption captured in the original frame).
function countLines(out: string, predicate: (line: string) => boolean): number {
  return out.split('\n').filter(predicate).length
}

describe('ApprovalCard layout (tool-approval popup)', () => {
  test('(A) renders the title prefix exactly once and reflects the real tool', async () => {
    const out = await renderWriteApproval(40)
    const upper = out.toUpperCase()
    // The real tool (WRITE) is shown, and "BASH" is never injected.
    expect(upper).toContain('TOOL · WRITE · MEDIUM-RISK APPROVAL')
    expect(upper).not.toContain('BASH')
    // The "TOOL ·" prefix must appear exactly once in the title line.
    const titleLine = out
      .split('\n')
      .find((line) => line.toUpperCase().includes('MEDIUM-RISK APPROVAL'))
    expect(titleLine).toBeDefined()
    const toolPrefixCount = (titleLine ?? '').toUpperCase().split('TOOL ·').length - 1
    expect(toolPrefixCount).toBe(1)
  })

  test('(B) the popup body fits inside its border and does not bleed below it', async () => {
    // A generous slot: the full card renders cleanly with one top border and
    // one bottom border and nothing after the bottom border line.
    const out = await renderWriteApproval(40)
    const lines = out.split('\n').filter((line) => line.trim().length > 0)
    const firstBorderIndex = lines.findIndex((line) => line.includes('┌'))
    const lastBorderIndex = lines.map((line) => line.includes('└')).lastIndexOf(true)
    expect(firstBorderIndex).toBe(0)
    expect(lastBorderIndex).toBe(lines.length - 1)
    // Exactly one outer top/bottom border — no stray dangling box bottoms from
    // an overflowing inner box.
    expect(countLines(out, (line) => line.includes('┌'))).toBe(1)
    expect(countLines(out, (line) => line.includes('└'))).toBe(1)
  })

  test('(B) the rendered popup never exceeds the available rows at a tight slot', async () => {
    const rows = 18
    const out = await renderWriteApproval(rows)
    const renderedRows = out.split('\n').filter((line) => line.length > 0).length
    expect(renderedRows).toBeLessThanOrEqual(rows)
    // Even clipped, the body stays inside the border: a bottom border closes it.
    expect(out).toContain('└')
    expect(countLines(out, (line) => line.includes('└'))).toBe(1)
  })

  test('(B) the action legend never collapses onto the [e] edit command footer', async () => {
    // The original overflow corruption squashed the body into the footer, so a
    // single rendered line held BOTH the footer key ("[e] edit command") and the
    // action legend ("[3] deny"). A bounded popup keeps them on separate lines.
    const collidedAt = (rows: number, out: string): string[] =>
      out
        .split('\n')
        .filter((line) => line.includes('[e] edit command') && line.includes('[3] deny'))
        .map((line) => `rows=${rows}: ${line.trim()}`)

    const offenders: string[] = []
    for (const rows of [18, 20, 24, 40]) {
      const out = await renderWriteApproval(rows)
      offenders.push(...collidedAt(rows, out))
    }
    expect(offenders).toEqual([])
  })

  test('(C) the action legend [1]/[2]/[3] is present and survives a tight slot', async () => {
    const generous = await renderWriteApproval(40)
    expect(generous).toContain('[1] approve once')
    expect(generous).toContain('[2] approve for session')
    expect(generous).toContain('[3] deny')
    expect(generous).toContain('[e] edit command')

    // The action legend is the primary action and is gated to stay visible
    // even when the slot is too tight to show the secondary facts/note rows.
    const tight = await renderWriteApproval(16)
    expect(tight).toContain('[1] approve once')
  })

  test('(A) a non-bash tool is never relabeled as bash', async () => {
    const out = await renderToString(
      <ApprovalCard
        risk="low"
        title="tool · grep · needs approval"
        command="rg --files"
        facts={[{ label: 'tool', value: 'grep' }]}
        confirmLabel="enter approve · 2 session · 3 deny"
      />,
      { columns: 100, rows: 30 },
    )
    expect(out.toUpperCase()).toContain('TOOL · GREP · NEEDS APPROVAL')
    expect(out.toUpperCase()).not.toContain('BASH')
  })

  test('high-risk typed-confirmation variant still bounds its body and keeps the prompt', async () => {
    const out = await renderToString(
      <ApprovalCard
        risk="high"
        title="tool · bash · destructive high-risk approval"
        command="rm -rf build"
        facts={[
          { label: 'tool', value: 'bash' },
          { label: 'scope', value: 'destructive', color: 'error' },
        ]}
        note="untrusted policy"
        confirmLabel="type 'yes' to approve"
        requireTypedConfirmation={true}
        typedConfirmationValue="ye"
        typedConfirmationTarget="yes"
      />,
      { columns: 100, rows: 24 },
    )
    expect(out.toUpperCase()).toContain('TOOL · BASH · DESTRUCTIVE HIGH-RISK APPROVAL')
    // The doubled-prefix bug would have produced "TOOL · BASH · TOOL · BASH".
    const titleLine = out
      .split('\n')
      .find((line) => line.toUpperCase().includes('HIGH-RISK APPROVAL'))
    expect((titleLine ?? '').toUpperCase().split('TOOL ·').length - 1).toBe(1)
    expect(countLines(out, (line) => line.includes('└'))).toBe(1)
    expect(out).toContain('/ yes')
    expect(out).toContain('confirmation required')
  })
})
