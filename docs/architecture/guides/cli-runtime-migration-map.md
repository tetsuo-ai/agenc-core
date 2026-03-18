# CLI And Runtime Migration Map

This map records how the current `agenc` and `agenc-runtime` surfaces migrate
into the public product contract defined by
[ADR-003](../adr/adr-003-public-framework-product.md) and
[product-contract.md](../product-contract.md).

## Canonical state decision

Target canonical paths:

- config: `~/.agenc/config.json`
- PID: `~/.agenc/daemon.pid`
- replay SQLite store: `~/.agenc/replay-events.sqlite`
- logs/state/plugin/connector data: `~/.agenc/`
- wrapper-managed runtime releases: `~/.agenc/runtime/releases/...`
- wrapper-managed active runtime pointer: `~/.agenc/runtime/current`

Compatibility rule:

- `.agenc-runtime.json` is importable legacy state
- it is not a long-term competing default
- both `agenc` and direct `agenc-runtime` execution must resolve the canonical
  config path by default after convergence

Config path precedence after convergence:

1. `--config`
2. `AGENC_CONFIG`
3. `AGENC_RUNTIME_CONFIG` for legacy-compatible CLI consumers only
4. `~/.agenc/config.json`

Field precedence after a config file is selected:

1. CLI flags
2. `AGENC_RUNTIME_*` environment overrides
3. config file values
4. built-in defaults

Lifecycle rule:

- daemon-backed commands (`start`, `restart`, `config init|validate|show`,
  operator console attach) accept canonical gateway config only
- `AGENC_RUNTIME_CONFIG` does **not** change daemon/config command targets
- legacy config compatibility remains for replay/plugin/skill/bootstrap-style CLI
  consumers and explicit import flows only

## Command migration table

| Current surface | Current behavior | Public product disposition | Notes |
| --- | --- | --- | --- |
| `agenc` | opens operator console by default | `KEEP` | remains the default interactive operator/TUI surface |
| `agenc console` | explicit operator console | `KEEP` | keep as explicit alias for default interactive mode |
| `agenc <runtime-command>` | pass-through to runtime CLI | `KEEP` in transition | wrapper continues forwarding while public contract is stabilized |
| `agenc runtime where|install|update|uninstall` | wrapper-owned runtime management | `KEEP` | explicit public install/update/remove namespace for the packaged runtime |
| `agenc-runtime onboard` | write local runtime config | `WRAP` | public surface becomes `agenc onboard`; runtime alias remains for compatibility |
| `agenc-runtime health` | health checks | `WRAP` | public surface becomes `agenc health` |
| `agenc-runtime doctor` | diagnostics/remediation | `WRAP` | public surface becomes `agenc doctor` |
| `agenc-runtime init` | contributor-guide scaffolding | `DEFER/ADVANCED` | not required for end-user v1 |
| `agenc-runtime config init|validate|show` | config commands | `KEEP/WRAP` | keep available; public wording should align to canonical config path |
| `agenc-runtime start` | start daemon | `WRAP` | public surface becomes `agenc start` |
| `agenc-runtime stop` | stop daemon | `WRAP` | public surface becomes `agenc stop` |
| `agenc-runtime restart` | restart daemon | `WRAP` | public surface becomes `agenc restart` |
| `agenc-runtime status` | daemon status | `WRAP` | public surface becomes `agenc status` |
| `agenc-runtime logs` | daemon log access/help | `WRAP` | public surface becomes `agenc logs` |
| `agenc-runtime service install` | service template generation | `KEEP/ADVANCED` | available for power users; not required to explain first-run product usage |
| `agenc-runtime sessions list|kill` | control-plane sessions | `KEEP/ADVANCED` | important operator tooling; not day-one onboarding copy |
| `agenc-runtime plugin ...` | plugin lifecycle | `WRAP` | plugin lifecycle becomes part of the public product surface |
| `agenc-runtime jobs ...` | scheduled job controls | `KEEP INTERNAL TERM` | do not confuse with future public marketplace `tasks`/`bids` contract |
| `agenc-runtime skill ...` | skill registry/management | `KEEP/ADVANCED` | retain as advanced surface; not first-run product copy |
| `agenc-runtime replay ...` | replay/incident tooling | `KEEP INTERNAL/ADVANCED` | operator/debug tooling, not first-run public onboarding |

## Config migration map

| Current source | Target state | Disposition |
| --- | --- | --- |
| `.agenc-runtime.json` in cwd | import into `~/.agenc/config.json` | preserve as migration source only |
| `~/.agenc/config.json` | canonical product config | preserve |
| `~/.agenc/daemon.pid` | canonical PID file | preserve |

Migration expectations:

- first run detects legacy `.agenc-runtime.json` and offers import/migration
- `onboard` always writes canonical gateway config, not legacy flat config
- imported files are backed up before mutation
- direct `agenc-runtime` uses the canonical config by default after migration

## UI migration map

| Surface | Disposition |
| --- | --- |
| operator console / TUI | primary mature operator surface |
| `web/` | chosen daemon-backed dashboard surface |
| `demo-app/` | move out of product path into demo/example track |

## Runtime handoff rule

The wrapper package owns public installation and version switching.

The runtime package owns product behavior once execution is handed off.

That split means:

- wrapper-managed service/templates/console handoff must resolve runtime entry
  paths through `~/.agenc/runtime/current`
- public install/update/remove flows live under `agenc runtime ...`
- direct `agenc-runtime` remains a compatibility alias, not a second install
  authority

## Marketplace language rule

Current `jobs` commands are scheduled runtime job controls.

They are **not** automatically the public marketplace UX.

Public marketplace terms such as `tasks` and `bids` need their own explicit
daemon/API contract before they are exposed as first-class public commands.
