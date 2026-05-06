# TUI Component Parity

## T-19 Diff Renderer Set

Donor source: `/home/tetsuo/git/openclaude/src/components/{StructuredDiff,StructuredDiffList,FileEditToolDiff,diff/DiffDetailView,diff/DiffDialog,diff/DiffFileList}.tsx` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

AgenC destinations:

- `runtime/src/tui/components/diff/StructuredDiff.tsx`
- `runtime/src/tui/components/diff/StructuredDiffList.tsx`
- `runtime/src/tui/components/diff/FileEditToolDiff.tsx`
- `runtime/src/tui/components/diff/DiffDetailView.tsx`
- `runtime/src/tui/components/diff/DiffDialog.tsx`
- `runtime/src/tui/components/diff/DiffFileList.tsx`

Coverage added in `runtime/src/tui/components/diff/diff-renderer.test.tsx` locks the structured hunk list, file-list pagination, detail-state rendering, and current-diff dialog list path.
