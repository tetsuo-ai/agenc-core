# TUI Component Parity

## T-19 Diff Renderer Set

Donor source: `/home/tetsuo/git/openclaude/src/components/{StructuredDiff,StructuredDiffList,FileEditToolDiff,diff/DiffDetailView,diff/DiffDialog,diff/DiffFileList}.tsx` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow donor citation in local parity artifact -->

AgenC destinations:

- `runtime/src/tui/components/diff/StructuredDiff.tsx`
- `runtime/src/tui/components/diff/StructuredDiffList.tsx`
- `runtime/src/tui/components/diff/FileEditToolDiff.tsx`
- `runtime/src/tui/components/diff/DiffDetailView.tsx`
- `runtime/src/tui/components/diff/DiffDialog.tsx`
- `runtime/src/tui/components/diff/DiffFileList.tsx`

Coverage added in `runtime/src/tui/components/diff/diff-renderer.test.tsx` locks the structured hunk list, file-list pagination, detail-state rendering, and current-diff dialog list path.

## T-21 Compact Summary + Boundary Cells

Donor source: `/home/tetsuo/git/openclaude/src/components/{CompactSummary.tsx,messages/CompactBoundaryMessage.tsx}` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow donor citation in local parity artifact -->

AgenC destinations:

- `runtime/src/tui/components/compact/CompactSummary.tsx`
- `runtime/src/tui/components/compact/CompactBoundaryMessage.tsx`

`Message.tsx` dispatches compact-summary user messages and compact-boundary system messages through the compact component directory. `CompactBoundaryMessage.tsx` is byte-equivalent to the donor file after relocation; `CompactSummary.tsx` differs only by AgenC-owned relative import paths and the existing upstream-import comments for dependencies still owned by later purge items.

Coverage added in `runtime/src/tui/components/compact/compact-rendering.test.tsx` locks prompt and transcript rendering for metadata-backed summaries, fallback summaries, and the compact boundary shortcut line.
