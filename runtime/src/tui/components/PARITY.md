# TUI Component Parity

## T-19 Diff Renderer Set

Reference source: `src/components/{StructuredDiff,StructuredDiffList,FileEditToolDiff,diff/DiffDetailView,diff/DiffDialog,diff/DiffFileList}.tsx` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

AgenC destinations:

- `runtime/src/tui/components/diff/StructuredDiff.tsx`
- `runtime/src/tui/components/diff/StructuredDiffList.tsx`
- `runtime/src/tui/components/diff/FileEditToolDiff.tsx`
- `runtime/src/tui/components/diff/DiffDetailView.tsx`
- `runtime/src/tui/components/diff/DiffDialog.tsx`
- `runtime/src/tui/components/diff/DiffFileList.tsx`

Coverage added in `runtime/src/tui/components/diff/diff-renderer.test.tsx` locks the structured hunk list, file-list pagination, detail-state rendering, and current-diff dialog list path.

## T-21 Compact Summary + Boundary Cells

Reference source: `src/components/{CompactSummary.tsx,messages/CompactBoundaryMessage.tsx}` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

AgenC destinations:

- `runtime/src/tui/components/compact/CompactSummary.tsx`
- `runtime/src/tui/components/compact/CompactBoundaryMessage.tsx`

`Message.tsx` dispatches compact-summary user messages and compact-boundary system messages through the compact component directory. `CompactBoundaryMessage.tsx` is byte-equivalent to the reference file after relocation; `CompactSummary.tsx` differs only by AgenC-owned relative import paths and the existing upstream-import comments for dependencies still owned by later purge items.

Coverage added in `runtime/src/tui/components/compact/compact-rendering.test.tsx` locks prompt and transcript rendering for metadata-backed summaries, fallback summaries, and the compact boundary shortcut line.

## OB-07 AGENC.md External Includes Dialog

Reference source: `src/components/ClaudeMdExternalIncludesDialog.tsx` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`.

AgenC destination:

- `runtime/src/tui/components/AgenCMdExternalIncludesDialog.tsx`

The dialog preserves the external-include trust prompt and project-config decision write while using AgenC-branded copy, telemetry names, config fields, and the AgenC-owned security documentation URL.

Coverage in `runtime/src/tui/components/AgenCMdExternalIncludesDialog.test.tsx` locks the accept/decline config writes and telemetry names.
