# Apply Patch Parity

Upstream reference: donor runtime snapshot at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `apply-patch/src/lib.rs`
- `apply-patch/src/parser.rs`
- `apply-patch/src/seek_sequence.rs`
- `apply-patch/tests/fixtures/scenarios/`
- `apply-patch/tests/suite/scenarios.rs`
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
- `scenarios.test.ts` replays every donor fixture scenario against the AgenC runtime.
- `__fixtures__/scenarios/` stores the portable apply-patch fixture corpus.
