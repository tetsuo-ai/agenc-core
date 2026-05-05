# File Watcher Parity

Upstream reference: `/home/tetsuo/git/codex/codex-rs` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`. <!-- branding-scan: allow upstream source root path -->

Primary source anchors:
- `core/src/file_watcher.rs`
- `core/src/file_watcher_tests.rs`

This directory owns the TypeScript port of the runtime file-watcher subscription bus:
- `index.ts` implements subscribers, coalesced receivers, throttling, reference-counted watches, missing-path fallback, event matching, and the Node filesystem backend.
- `index.test.ts` ports the donor behavior tests into Vitest coverage for the live AgenC runtime.

## ZC-29 breadth audit

Decision: no additional port split is needed for this subsystem. The donor uses a Rust module plus
its test module; AgenC keeps the same behavior in one TypeScript implementation file and one test
file because the runtime only has one public file-watcher service boundary.

Carried behavior:
- reference-counted subscriber registrations for recursive and non-recursive paths
- throttled receiver coalescing and shutdown flush
- mutating-event filtering
- missing-path fallback through the nearest existing directory ancestor
- recursive watcher downgrade/reconfiguration and Node `fs.watch` fallback
- synthetic test hooks for deterministic subscriber notification

Intentional reductions:
- The donor's Tokio channel, `notify` watcher, and lock-order regression harness are not mirrored as
  separate files. AgenC uses the Node `FSWatcher` backend and keeps the same externally observable
  registration, matching, close, and fallback semantics under `index.ts`.
