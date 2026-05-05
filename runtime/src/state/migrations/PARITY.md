# Config Migration Parity

Donor reference: startup migration directory at commit
`0ca43335375beec6e58711b797d5b0c4bb5019b8`.

Primary source anchors:
- `src/main.tsx`
- `src/migrations/migrateBypassPermissionsAcceptedToSettings.ts`
- `src/migrations/migrateEnableAllProjectMcpServersToSettings.ts`
- `src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`
- `src/migrations/migrateAutoUpdatesToSettings.ts`
- `src/migrations/migrateLegacyOpusToCurrent.ts`
- `src/migrations/migrateSonnet1mToSonnet45.ts`
- `src/migrations/migrateSonnet45ToSonnet46.ts`
- `src/migrations/migrateFennecToOpus.ts`
- `src/migrations/migrateOpusToOpus1m.ts`
- `src/migrations/resetProToOpusDefault.ts`
- `src/migrations/resetAutoModeOptInForDefaultOffer.ts`

This directory now owns both SQL state migrations and the standalone
`config-migrations.ts` runner. The config runner stays out of
`migrations/index.ts` so `loadConfig()` can import pure normalization without
pulling in SQLite dependencies.

Executable parity lives in:
- `runtime/src/state/config-migrations.test.ts`
- `runtime/src/config/config.test.ts`
- `runtime/src/bin/project-trust-preflight.test.ts`

The auto-update migration is documented but not executed because AgenC does
not currently expose a live updater path, and explicit `autoUpdates=false`
cannot be distinguished from the current default without a TOML writer.
