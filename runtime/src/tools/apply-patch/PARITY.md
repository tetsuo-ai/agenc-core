# Apply Patch Parity

Upstream reference: donor runtime snapshot at commit `35aaa5d9fcb606fb6f27dd5747ecab3f4ba0c07e`.

Primary source anchors:
- `apply-patch/src/lib.rs`
- `apply-patch/src/parser.rs`
- `apply-patch/src/seek_sequence.rs`
- `core/src/apply_patch.rs`
- `tools/src/apply_patch_tool.rs`
- `tools/src/tool_apply_patch.lark`

This directory owns the TypeScript port of the patch grammar, filesystem application primitive, and registry tool wrapper:
- `types.ts` defines shared parse/runtime/action shapes.
- `parser.ts` implements the patch marker and hunk parser.
- `seek-sequence.ts` implements the line-matching strategy used by update hunks.
- `runtime.ts` applies parsed hunks to AgenC's allowed filesystem roots.
- `tool.ts` exposes the `apply_patch` model-facing tool schema and Lark grammar.
- `index.ts` re-exports the subsystem surface for sub-agents and replay.
