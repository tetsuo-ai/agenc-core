# Secrets Parity

Upstream reference: `/home/tetsuo/git/codex/codex-rs` at commit `35aaa5d9fcb606fb6f27dd5747ecab3f4ba0c07e`. <!-- branding-scan: allow upstream source root path -->

Primary source anchors:
- `secrets/src/lib.rs`
- `secrets/src/local.rs`
- `secrets/src/sanitizer.rs`

This directory owns the TypeScript port of the secrets sanitizer surface:
- `sanitizer.ts` redacts API keys, tokens, JWTs, bearer tokens, and secret assignments from strings and JSON-like artifacts.
- `index.ts` exports the sanitizer and the name/scope/environment helpers needed by later secret consumers.
- `sanitizer.test.ts` ports and expands donor sanitizer coverage for AgenC log, transcript, hook-output, and trace payloads.

Storage boundary:
- The donor local encrypted backend is recorded in the parity source anchors, but SE-01's named checklist behavior is sanitization for persisted artifacts. Local secret storage can be ported as a separate consumer-facing item when command/config surfaces require it.
