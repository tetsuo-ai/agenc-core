# External Agent Migration Parity

Upstream reference: `/home/tetsuo/git/codex/codex-rs` at commit `c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchors:
- `external-agent-migration/src/lib.rs`
- `external-agent-migration/Cargo.toml`
- `hooks/src/lib.rs`

This directory owns the TypeScript port of the user-project import helper:
- `project-importer.ts` reads `.mcp.json`, project-scoped MCP entries, hook settings, frontmatter agent files, and command markdown files, then emits AgenC-shaped TOML, hook JSON, role TOML, and migrated skill directories.
- `toml.ts` is the minimal TOML emitter needed by the migration output.
- `project-importer.test.ts` locks the end-to-end import path and the major parser/filtering edge cases.

Shape differences:
- HTTP MCP servers with env-placeholder headers are skipped because AgenC's live MCP config supports static `headers` today; generating unresolved headers would produce a broken runtime config.
- Agent role TOML uses escaped basic strings rather than multiline TOML strings so the existing AgenC TOML loader can parse migrated output.
- Hook timeout fields are emitted as `timeout_ms` because AgenC's configured hook runtime expects millisecond timeouts.
