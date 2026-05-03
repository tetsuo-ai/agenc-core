# Thread Store Parity

Source root: `/home/tetsuo/git/codex/codex-rs/thread-store` <!-- branding-scan: allow donor source root path -->

ST-11 ports the thread-store contract into AgenC-owned TypeScript:

- `store.ts` provides the filesystem-backed thread store, model/provider metadata, path reads, list filters/cursors, archive metadata, and typed request errors.
- `live-thread.ts` wires active rollout writers through the thread store.
- `in-memory.ts` provides a contract-compatible test store.
- `types.ts`, `errors.ts`, and `index.ts` expose the public module surface while `runtime/src/session/thread-store.ts` and `runtime/src/session/live-thread.ts` remain compatibility re-export shims.

Known deferred work:

- Remote thread storage is out of scope for ST-11.
- Rich donor metadata that AgenC does not yet collect, such as sandbox and approval snapshots, remains absent from `StoredThread`.
