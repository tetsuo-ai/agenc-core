# Config Parity

Upstream reference: `/home/tetsuo/git/openclaude` at commit <!-- branding-scan: allow local donor citation in parity artifact -->
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/utils/managedEnvConstants.ts::PROVIDER_MANAGED_ENV_VARS`

CF-03 ports only the managed provider-key policy needed by AgenC's
`auth.managedKeys.enabled` config flag. AgenC does not port the source
settings-env scrubber wholesale; the live behavior is owned by:

- `runtime/src/config/schema.ts` for the typed flag and false default.
- `runtime/src/config/env.ts` for `AGENC_AUTH_MANAGED_KEYS_ENABLED`.
- `runtime/src/auth/selection.ts` for remote backend option plumbing.
- `runtime/src/auth/byok-precedence.ts` for BYOK-before-managed selection.
- `runtime/src/auth/backends/remote.ts` for vending refusal when disabled.
- `runtime/src/bin/bootstrap.ts` and `runtime/src/session/session.ts` for
  runtime managed-key attempt gating.

## CF-06 `agent.retention`

CF-06 is net-new AgenC config over the daemon state pruners that already own
agent-run and snapshot cleanup. Runtime ownership is split intentionally:

- `runtime/src/config/schema.ts` owns the typed `AgentRunRetentionConfig` and
  defaults: `completed_days=30`, `failed_days=90`, `snapshot_days=3`,
  `snapshot_max_count=10000`, and `snapshot_max_bytes=67108864`.
- `runtime/src/app-server/daemon-cli.ts` reads `config.agent?.retention` at
  daemon startup and passes it to terminal-run pruning and snapshot pruning.
- `runtime/src/state/pruning.ts` applies completed-run, failed-run,
  snapshot-age, snapshot-count, and snapshot-byte retention.
- `runtime/src/state/snapshot-policy.ts` receives daemon `snapshotRetention`
  and prunes after each session snapshot write.
- `runtime/src/agents/run-agent.ts` does not read retention directly. It emits
  `run_complete`, `run_error`, and `run_interrupted` progress events; the
  daemon/background-agent runner records those events through the snapshot
  policy, and the state pruners apply retention outside the live turn loop. This
  avoids having `runAgent` open state databases or prune while an agent turn is
  still active.
## CF-11 `mcp.server`

CF-11 is net-new AgenC config for serving AgenC's own MCP endpoint. Runtime
ownership is split intentionally:

- `runtime/src/config/schema.ts` owns the typed `McpServerModeConfig` and the
  default `enabled=false`, `transport="stdio"`.
- `runtime/src/bin/mcp-cli.ts` reads the config-backed defaults for manual
  `agenc mcp serve` invocations; explicit CLI transport still wins.
- `runtime/src/mcp/server/start.ts` owns the canonical start contract used by
  both the CLI and daemon paths.
- `runtime/src/app-server/daemon-autostart.ts` loads `mcp.server` with the
  daemon autostart config so the F-04a autostart reader sees one consistent
  snapshot.
- `runtime/src/app-server/daemon-cli.ts` starts and cleans up enabled SSE mode
  inside the foreground daemon. Enabled stdio mode is not daemon-autostarted
  because stdio requires an attached foreground process; it remains available
  through `agenc mcp serve`.

## CF-13 Schema validation

Upstream reference: `/home/tetsuo/git/codex` at commit <!-- branding-scan: allow local donor citation in parity artifact -->
`c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary source anchor:
- `codex-rs/config/src/schema.rs` (`additional_properties = false` on closed
  config schema blocks). <!-- branding-scan: allow local donor citation in parity artifact -->

CF-13 ports the closed-subschema posture onto AgenC's live config loader while
preserving AgenC's existing top-level forward-compat `_unknown` table:

Merge note: CF-13 integrated main's CF-11 `mcp.server` parity section by
retaining the CF-11 section above and appending this CF-13 validator section
after it.

- `runtime/src/config/schema.ts` owns the block validators and typed
  `Invalid<Block>ConfigError.field` metadata for `auth`, `providers`, `agent`,
  `plugins`, and `mcp.server`.
- `runtime/src/config/loader.ts` runs `validateAgenCConfigBlocks` after
  alias normalization, read-only migrations, and `normalizeRawConfig`, then
  before merging onto defaults.
- `runtime/src/config/store.ts` reads the validation diagnostics through the
  normal `loadConfig` warning path during `ConfigStore.reload`.
- `runtime/src/commands/config.ts` surfaces reload warnings so `/config reload`
  reports schema validation failures instead of silently presenting a clean
  reload message.
- `agenc config validate` is owned by CF-14 and can reuse the exported
  validators without re-parsing block semantics.
