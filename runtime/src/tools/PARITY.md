# Tools Runtime Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit `0ca43335375beec6e58711b797d5b0c4bb5019b8`. <!-- branding-scan: allow upstream source root path -->

Primary source anchors:
- `src/services/tools/toolOrchestration.ts`
- `src/services/tools/toolExecution.ts`
- `src/services/tools/StreamingToolExecutor.ts`
- `src/services/tools/toolHooks.ts`
- `src/services/tools/toolExecution.test.ts`

This directory owns the TypeScript port of the tools service runtime:
- `orchestration.ts` partitions tool-use batches, applies the env concurrency cap, and coordinates context updates.
- `execution.ts` owns tool validation, hooks, permission decisions, progress, and dispatch result shaping.
- `streaming-executor.ts` owns streamed tool dispatch, sibling aborts, progress, and ordered result yield.
- `hooks.ts` owns pre-tool, post-tool, failure, and permission hook decisions.

The live tool phase imports these root modules directly from `runtime/src/phases/execute-tools.ts`; per-phase `_deps` tool-runtime files are not the owner for S-10 behavior.

Target-path note: the checklist row names `runtime/src/services/tools/` because it follows the source service path. The approved AgenC owner is `runtime/src/tools/`, matching `docs/plan/architecture.md` and `docs/plan/feature-matrix.md`; S-10 intentionally does not recreate the legacy services directory.
