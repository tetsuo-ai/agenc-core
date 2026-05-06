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

## CF-10 `plugins`

CF-10 ports the plugin config shape from `/home/tetsuo/git/codex` at commit <!-- branding-scan: allow local donor citation in parity artifact -->
`c8c30d9d75556ecbe94991af22380d2a4e9d6589`.

Primary CF-10 source anchors:
- `codex-rs/config/src/types.rs::PluginConfig` <!-- branding-scan: allow local donor citation in parity artifact -->
- `codex-rs/config/src/config_toml.rs::ConfigToml.plugins` <!-- branding-scan: allow local donor citation in parity artifact -->

AgenC keeps the donor's per-plugin enablement and MCP-server policy overlay
shape, but wraps it in AgenC's ship-safe `plugins.enabled` feature gate and
`plugins.allowlist` filter:

- `runtime/src/config/schema.ts` owns the typed config and disabled defaults.
- `runtime/src/plugins/loader.ts` applies the feature gate and allowlist before
  plugin component loading, and applies `plugins.plugins.<id>.mcp_servers`
  enablement/tool-policy overlays to plugin-contributed MCP servers.
- `runtime/src/plugins/policy.ts` applies the same per-plugin and allowlist
  policy at permission decision time.
- `runtime/src/plugins/cli/pluginOperations.ts` writes managed entries under
  `plugins.plugins.<id>` and turns on the global `plugins.enabled` gate for
  install/enable operations.
- `runtime/src/commands.ts` and prompt attachment producers pass the active
  config snapshot into local skill discovery so plugin-provided skills follow
  the same gate in command and model-visible surfaces.
