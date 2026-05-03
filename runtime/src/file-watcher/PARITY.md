# File Watcher Parity

Upstream reference: `/home/tetsuo/git/codex/codex-rs` at commit `35aaa5d9fcb606fb6f27dd5747ecab3f4ba0c07e`. <!-- branding-scan: allow upstream source root path -->

Primary source anchors:
- `core/src/file_watcher.rs`
- `core/src/file_watcher_tests.rs`

This directory owns the TypeScript port of the runtime file-watcher subscription bus:
- `index.ts` implements subscribers, coalesced receivers, throttling, reference-counted watches, missing-path fallback, event matching, and the Node filesystem backend.
- `index.test.ts` ports the donor behavior tests into Vitest coverage for the live AgenC runtime.
