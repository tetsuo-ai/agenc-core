# Canonical identity adapter: explicit 403da successor

Read-only review by the sole XHIGH reviewer. No build, import, client, socket,
remote command or test execution. Compared the frozen `real-parent-adapters-v1`
sources with exact Git objects and immutable
`/private/tmp/light-clean-cli-validator-v2-GANyA9/source` at
`403da04398b55e51d1f4e8814f9a70957b0db5ef`.

## Decision

The existing PID/sidecar/authenticated identity/instance-bound shutdown
mechanics can be reused **unchanged**. All five canonical source pins match
403da exactly. The immediate incompatibility is the old explicit revision
selection, not a changed protocol or missing production feature.

Make a small versioned successor selection. Keep the old directory and bridge
artifacts intact. Do not inject process identity, change platform, weaken build
checks or reimplement authentication. The actual future Linux bridge artifact
must be built/selected against 403da; source parity does not turn an old ec45
binary, dependency closure or execution result into current provenance.

## Verified source parity

Git diff from `ec45a1e49a6e563391830b07ff54ac483bed5180` to 403da is empty for
all five files; hashing the immutable 403da files produces these same v1 pins:

| Canonical path under `runtime/` | SHA256 |
| --- | --- |
| `src/app-server/daemon-control.ts` | `78656e62de136277ca889243cc123df9b49f1b1f6f6f8c2d64a9822dcb646534` |
| `src/app-server/daemon-runtime-info.ts` | `805729ed01db043eb59b2f975fce4b0f31e52144021a6fb014b54d0f96a56b10` |
| `src/app-server/daemon-instance-identity.ts` | `a0bbb94b2aad9d4bdb46f9fdb3620507d981629f1acaa9648d13a34f79a0652f` |
| `src/app-server/daemon-request-policy.ts` | `6b42a100bfd1867c0f100e524b6b9362d6143326e8c832a47c6c12d3983e1bca` |
| `src/config/home.ts` | `451624618b9bf31ea8a790d03796e1082fbbc6124e511969cc568a42054512c0` |

The scoped Git comparison also found no changes in the app-server protocol,
transport, config, bounded-file, durable-file, record, environment, logger,
SQLite-lock/driver and Windows-process-identity paths inspected for these
imports. Within app-server, only `daemon-cli.ts`, background runner and its
shared types changed. The daemon-cli diff adds the trusted prepared-validator
option, snapshots options before awaiting, forbids validator plus custom runner,
and forwards the callback to the normal runner. It does not alter daemon
identity construction, sidecar publication, authentication or shutdown.
This scoped comparison is not a claim that every transitive build input is
unchanged; use the actual current build inventory for that purpose.

## Exact implementation/selection delta

Use a successor directory with these four small files:

1. `pins.mjs`: change only `SOURCE_REVISION` to full 403da. Retain the five
   `SOURCE_PINS` values and exact ten-name `API_NAMES` inventory. This is justified
   by the comparison above, not by a sidecar or module's self-declared labels.
2. `adapters.mjs`: reuse byte-for-byte. Its relative `./pins.mjs` resolves to the
   successor selection; `build.commit === SOURCE_REVISION` stays mandatory.
3. `load-bridge.mjs`: reuse byte-for-byte under the same successor selection.
   It retains reviewed immutable-path/import-cache assumptions; copying it does
   not strengthen those assumptions or its file-read guarantees.
4. `canonical-bridge.ts`: retain the same canonical imports and frozen API
   projection; update the ec45-only explanatory comment and resolve
   `agenc-reviewed` explicitly to the selected 403da `runtime/src`. Its relative
   pins export must refer to the successor, not the old v1 directory.

The parent chooses this explicit successor and an independently accepted bridge
artifact path/hash. There is no runtime revision parameter, environment switch,
fallback to old pins, new RPC surface or generic multi-revision adapter needed.
The old adapter would currently fail `build_revision_mismatch`; the old loader
would fail `bridge_verification_failed` on a truthful 403da bridge. Do not remove
either check or patch only the bridge's exported revision label.

For the bridge build, reuse the current reviewed canonical source/config recipe
rather than the historical v1 README's single-bundle instruction. A small parent
bridge entry can share the existing split build machinery; it is allowed to
import its selected canonical API when the parent deliberately loads it. The
owner and preflight wrappers must retain their own zero-eager-Core checks.
The parent bridge need not share an ALS instance **across processes** with the
owner; the existing owner/validator single-graph requirement is unchanged.

## Preserved real control sequence

- Root supplies the actual registered owner's PID, private daemon/user homes and
  independently selected build tuple. No value is adopted from sidecar content.
- Canonical `readDaemonRuntimeInfo` supplies bounded sidecar data; the adapter
  checks all six identity fields and the selected PID/build. Sidecar data alone
  is not authenticated readiness.
- `readAgenCDaemonProcessStart(pid)` is called with exactly one argument.
  On actual Linux it reads `/proc/<pid>/stat` and boot ID, not an injected token
  or a system-helper impersonation.
- `requestAgenCDaemonInstanceIdentity` performs canonical cookie-authenticated
  initialize on the home-scoped socket and validates its identity. The lifecycle
  sequence still requires sidecar → OS token → authenticated identity → sidecar
  → OS token agreement, repeated before task and cleanup.
- `requestAgenCDaemonShutdown(host, expected)` authenticates again, validates
  the full expected identity before sending `daemon.shutdown`, binds that
  request to `instanceId`, and checks the exact acknowledgement. A successful
  canonical void return, not guessed status text, permits the adapter result.
- Only the first null sidecar read may poll. Auth/shutdown are not retried.
  Operation poison, overlap refusal and real-promise `outstanding` accounting
  remain unchanged. Caller timeout does not cancel a pending cookie/filesystem
  read or revoke an already in-flight instance-bound shutdown.

## Independent acceptance needed, without another test framework

The next recipe needs an exact current bridge/output closure and the Linux
selection already identified in `REAL-CLIENT-NEXT-GATE.md`, not new identity
algorithms or another synthetic readiness suite. The known local VERSION is
runtime `0.18.0`, commit 403da, build time `2026-09-30T09:07:17.000Z`; the selected
Linux daemon and ordinary sibling CLI must agree on their independently pinned
tuple. If root produces a distinct Linux build tuple, select its actual bytes
explicitly; do not copy this timestamp into an identity override.

The parent must use the real default platform and real bridge loader, not test
`platform`, `readArtifact`, `importModule` or API substitutions. Load in the
fresh trusted parent with immutable bridge/dependency paths, and retain its
actual input/artifact hashes. The old built bridge selection records ec45,
Node 26.5.0 and a different build time; it remains historical evidence only.

In the already planned single genuine-CLI fixture, validate that the observed
full tuple binds the registered foreground child, then let the ordinary CLI
attach. Preserve instance-bound shutdown and pending-operation/owned-close
conditions. Those actual joins are the required new evidence. Existing adapter
negative tests and accepted lifecycle mechanics do not need to be re-created;
no separate paid call, generic harness, auth redesign or production edit is
justified by this revision change.

## Frozen adapter inputs inspected

- `adapters.mjs`: `1e1526531c9e579829e448a26ba693dffb82700056a6f95607f24a45cbac23f7`
- `pins.mjs`: `a6036f166327d32112650f24e1df8c4bbeea4c2b021b4c9d62141d0e70461a1a`
- `canonical-bridge.ts`: `24226523569f5de7f3acf7848375222cf45d4a3b9320029c8e476273cf0d1ff9`
- `load-bridge.mjs`: `f32f4bc866dfd4ac33092532d4e5a1c8366adf2db799f2092eb5bf69a79470bf`
