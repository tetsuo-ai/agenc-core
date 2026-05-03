# Rollout Parity

Upstream reference: Rust rollout crates at commit `48791920a8b122939c4d3feb15673c0a690ca4a0`.

Primary source anchors:
- `rollout/src/recorder.rs`
- `rollout/src/session_index.rs`
- `rollout/src/policy.rs`
- `rollout/src/metadata.rs`
- `rollout/src/list.rs`
- `rollout-trace/src/bundle.rs`
- `rollout-trace/src/writer.rs`
- `rollout-trace/src/raw_event.rs`
- `rollout-trace/src/reducer/mod.rs`
- `rollout-trace/src/model/mod.rs`
- `rollout-trace/src/payload.rs`

This directory owns AgenC's TypeScript rollout persistence surface:
- `recorder.ts` writes schema-stamped JSONL rollout rows and updates the session index.
- `session-index.ts` stores append-only session metadata with latest-entry-wins reads.
- `policy.ts` owns persistence filtering and retention selection.
- `metadata.ts` owns rollout filenames and session metadata records.
- `list.ts` lists, repairs, and prunes rollout files.
- `trace.ts` writes self-contained debug trace bundles and replays them into reduced state.
