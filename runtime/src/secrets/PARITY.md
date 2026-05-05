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

## ZC-35 Coverage Lock

Source anchors: `/home/tetsuo/git/openclaude` at commit
`0ca43335375beec6e58711b797d5b0c4bb5019b8`,
`src/utils/secureStorage/**`.

Decision: platform credential vault storage remains a documented reduction for
this cleanup item. AgenC's live secrets surface carries sanitization and
explicit auth-token paths; it does not yet have a managed credential store
surface that would consume OS keychains.

Carried behavior:
- log, transcript, hook-output, and trace redaction in `sanitizer.ts`
- atomic local auth state writes with 0600 file mode
- remote auth token resolution through explicit bootstrap environment and file
  paths

Intentional reductions:
- macOS Keychain, Linux Secret Service, Windows DPAPI, and keychain prefetch are
  not carried until AgenC has a managed credential store API.
- `LocalAuthBackend` persists a local UUID identity marker; it cannot vend
  provider credentials and therefore is not a managed provider key store.
- BYOK provider keys remain outside managed auth and are supplied through
  explicit provider configuration.
