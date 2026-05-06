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
  plugin component loading.
- `runtime/src/plugins/policy.ts` applies the same per-plugin and allowlist
  policy at permission decision time.
- `runtime/src/plugins/cli/pluginOperations.ts` writes managed entries under
  `plugins.plugins.<id>`.
