import React from 'react'
import { describe, expect, test } from 'vitest'

import { Box } from '../../src/tui/ink.js'
import {
  ApprovalCard,
  approvalDiffPreviewBudget,
  type ApprovalDiffPreview,
} from '../../src/tui/components/v2/primitives.js'
import { buildEditDiffPreview } from '../../src/tui/edit-diff-preview.js'
import { renderToString } from '../../src/utils/staticRender.js'

// BUG 1 (HIGH): in a height-constrained approval popup for a large file Write,
// the embedded DiffInline preview used to clip right after its header row,
// leaving an UNTERMINATED box (top border + `CREATE path +153 -0` header, then
// no diff body and no closing border) — and the user was asked to approve a
// 153-line write seeing ZERO content. ROOT CAUSE: `showPreview` was gated on a
// budget (`>= 2`) that did NOT reserve the box's full minimum chrome (2 border
// + 1 header + >=1 diff line = 4 rows). The fix reserves that full chrome up
// front (`approvalDiffPreviewBudget`) and OMITS the embedded diff entirely when
// it cannot fit at least the closing border + one diff line.

// A realistic large Write diff (153 added lines).
function bigWritePreview(): ApprovalDiffPreview {
  const lines = Array.from({ length: 153 }, (_v, i) => `line ${i} content`).join(
    '\n',
  )
  const built = buildEditDiffPreview('Write', {
    file_path: 'config_validator/validator.py',
    content: `${lines}\n`,
  })
  if (built === null) throw new Error('expected a Write diff preview')
  return {
    file: built.file,
    stats: built.stats,
    lines: built.lines,
    remaining: built.remaining,
    op: 'CREATE',
  }
}

describe('approvalDiffPreviewBudget (BUG 1: never a header-only unterminated box)', () => {
  test('omits the preview when the slot cannot fit the box chrome + one diff line', () => {
    // The DiffInline box's fixed chrome is 5 rows (2 borders + header + header
    // separator + continuation row); with 5 essential body rows reserved it
    // needs popupBodyRows >= 11 to fit even one diff line. Below that it must be
    // omitted, NOT rendered header-only and NOT at the cost of the action legend.
    for (let popupBodyRows = 0; popupBodyRows <= 10; popupBodyRows++) {
      const budget = approvalDiffPreviewBudget(popupBodyRows, 153)
      expect(budget.showPreview).toBe(false)
      expect(budget.previewLineCap).toBe(0)
    }
  })

  test('shows the preview with >=1 diff line once the full chrome fits', () => {
    // The threshold: popupBodyRows = 11 leaves exactly room for the essential
    // body + box chrome + one diff line. Whenever the preview is shown, at least
    // one line is shown (never a header-only box).
    for (let popupBodyRows = 11; popupBodyRows <= 40; popupBodyRows++) {
      const budget = approvalDiffPreviewBudget(popupBodyRows, 153)
      expect(budget.showPreview).toBe(true)
      expect(budget.previewLineCap).toBeGreaterThanOrEqual(1)
    }
  })

  test('REVERT-SENSITIVITY: the budget reserves the box header + continuation, not just borders', () => {
    // The bug was gating on a budget (`>= 2` after reserving only 5 essential +
    // 2 border = 7) that did NOT reserve the box header, its separator, or the
    // continuation row — so at marginal heights the box either clipped after its
    // header (unterminated) or pushed the [1]/[2]/[3] legend off the bottom. The
    // corrected helper reserves all of it, so the preview is OMITTED below
    // popupBodyRows = 11. Against the broken gate, popupBodyRows = 10 SHOWED the
    // diff (and clipped the legend); now it is omitted.
    expect(approvalDiffPreviewBudget(10, 153).showPreview).toBe(false)
    // And at the first height where the full chrome fits, exactly one line.
    expect(approvalDiffPreviewBudget(11, 153)).toEqual({
      showPreview: true,
      previewLineCap: 1,
    })
  })

  test('no diff lines available → no preview regardless of height', () => {
    expect(approvalDiffPreviewBudget(40, 0).showPreview).toBe(false)
  })

  test('a generous slot caps the inline diff to the compact window', () => {
    expect(approvalDiffPreviewBudget(100, 153).previewLineCap).toBe(7)
  })
})

describe('ApprovalCard (BUG 1: embedded diff is complete or absent, never half-drawn)', () => {
  // Invariant on the rendered card across every constrained height: if the
  // inner DiffInline box draws a CREATE header, it ALSO draws its closing border
  // (a complete box), and the count of inner `┌` and `└` corners is balanced.
  // AND the [1]/[2]/[3] legend + confirm row ALWAYS survive — the diff is shed
  // before either of those, never the other way round.
  for (const rows of [16, 18, 20, 21, 22, 23, 24, 28, 40]) {
    test(`rows=${rows}: the embedded diff is a complete box or omitted, legend always survives`, async () => {
      const out = await renderToString(
        <Box flexDirection="column">
          <ApprovalCard
            risk="low"
            title="tool · write · needs approval"
            command="config_validator/validator.py"
            commandIsShell={false}
            facts={[
              { label: 'tool', value: 'write' },
              { label: 'scope', value: 'session' },
              { label: 'request', value: 'req-1' },
              { label: 'confirmation', value: 'enter' },
            ]}
            note="untrusted policy: approve every call"
            diffPreview={bigWritePreview()}
            confirmLabel="enter approve · 2 session · 3 deny"
          />
        </Box>,
        { columns: 116, rows },
      )
      const lines = out.split('\n')
      const topCorners = lines.filter((l) => l.includes('┌')).length
      const bottomCorners = lines.filter((l) => l.includes('└')).length
      // Outer popup always draws one top + one bottom; the inner diff box, when
      // present, adds exactly one more of each. Either way they are balanced —
      // never a header-only box that adds a top with no matching bottom.
      expect(topCorners).toBe(bottomCorners)
      if (out.includes('CREATE')) {
        // When the CREATE header shows, the inner box must be complete (2 of
        // each corner) and show at least one diff line.
        expect(topCorners).toBe(2)
        expect(out).toMatch(/\+ line \d+ content/)
      }
      // The primary action legend + confirm row are NEVER the thing clipped —
      // at every height, whether or not the diff is shown.
      expect(out).toContain('[1] approve once')
      expect(out).toContain('▸ enter approve')
    })
  }
})
