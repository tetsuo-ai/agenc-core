# Next genuine CLI gate: exact 403da, one fake response

Read-only source assessment by the sole XHIGH reviewer. No entrypoint, client,
preflight, build, test, provider or remote command was executed for this report.
Selected product: `403da04398b55e51d1f4e8814f9a70957b0db5ef`, immutable source at
`/private/tmp/light-clean-cli-validator-v2-GANyA9/source`.

## Decision

Use the existing companion, canonical independent preflight, callback factory,
observer-v6 and owned-parent implementation. The immediate build-only step is
the guarded preflight entry **in the same split graph** as the owner, combined
with the already identified package-layout/asset correction. Do not make the
old source loader portable or introduce another SDK-based test client.

Linux reachability is not the only unfinished item. The guarded preflight has
not been built/executed, the actual parent has not yet supplied its independent
inputs and material handoff, and the old identity adapter selects a different
revision. These are small concrete preparation/integration tasks that can be
drafted without Linux. Actual native dependencies, canonical sandbox readiness
and the real daemon/CLI run require a selected working Linux environment.

## Guarded preflight entry: approved for build-only inclusion

Root's `preflight-entry.ts` is the right boundary. Its `Inputs` import is
type-only; `runSelectedIndependent()` calls `verifySelection()` before the
dynamic import of `preflight.js`. The preserved false approval in
`preflight-selection.mjs` therefore refuses before Core imports. The actual
preflight retains its own approval, source, environment and resource checks.

Add this as a second split ESM entry, retaining `preflight-selection.mjs` as an
explicit external selection dependency. Inspect both entry static closures,
not just the owner: neither may hoist the optional Chrome graph or import Core
before its gate. The actual foreground/preflight graph must still contain one
canonical `current-session` implementation, not a second ALS copy introduced
by aliases. No selection flag or null acceptance field needs to change to build.

The v2 output is not a deployable runtime merely because its disabled entry
imports. `DEPLOYMENT-CLOSURE.md` identifies two concrete host-independent fixes:
canonical runtime package/VERSION geometry and the enabled classifier prompt
assets. Root's authorized v3 flat-dist/package-layout build addresses these;
its future output still needs review. Linux SQLite, sandbox/process helpers,
external package conditions and observer/Python paths remain actual deployment
inputs. Do not copy Darwin native modules, install unrelated optional providers,
stub assets or override canonical build identity to make the gate pass.

## Independent inputs the existing preflight actually needs

Freeze these before the preflight or measured owner starts:

| Input | Existing source contract / concrete preparation |
| --- | --- |
| Task/config | Exact `TASK` and `CONFIG` literals in `preflight.ts`: no-tools task, OpenAI Luna, fixed low, summary auto, cap 8192. Supply the literal config path and independently computed byte hash. No observed report/request may define these expectations. |
| Filesystem | One absolute empty workspace with its declared `.git`, distinct private preflight/target homes, absent managed/project/user instruction and recovery resources. `emptyResources()` checks the reduced scope. Trust only the preflight home initially; leave target home unchanged until preflight finishes. Then prepare target-home trust/config as separately declared parent inputs. |
| Environment | Explicit PATH/shell authority, fixed Date/TZ input, cache-tail `0`, replay `1`, private HOME/AGENC_HOME, exact workspace. The same prompt-relevant facts must reach the measured daemon/session. Select a real hermetic preload and OS network denial; the marker is not a substitute for either. The existing canonical `tests/helpers/network-tripwire.cjs` installs the marker and guards, so no marker-only imitation is needed. |
| Startup/config authority | Select the canonical daemon-home configuration as well as the sibling CLI `--config` path. `daemon-cli.ts::loadCanonicalDaemonConfig` reads the daemon's home/env separately. Declare only synthetic credentials/private auth state; do not inherit the user's home, credential files or ambient provider settings. |
| Deployment | Exact Linux Node, built owner/preflight entries and ordinary CLI, package/build identity, actual dependency/native/helper/observer/Python closure and private directories. Current source pins and a Darwin build are not these Linux facts. |
| Observer fixture | Fixed protocol/run/channel IDs, new synthetic financial root plus inode/prefix inventory, explicit spend-policy mode, private publisher directory, independent config/client hashes, existing 60 binding pins and accepted Python/helper pins. These are the existing callback factory's inputs, not a new authority schema. |

The independent bootstrap calls the real instruction/tool/19-producer assembly
once, with fake-only fetch and selected-sampling refusals. Its private Session
uses deferred startup only for preparation; the measured daemon must retain
normal startup. A nonempty/unknown attachment or resource result is a concrete
scope refusal, not permission to strip it. The generated conversation/root/
managed-request/user-initial identifiers fill declared identity slots only.

The preflight's private result must survive its canonical shutdown and owned
process close before activation. Preserve raw material privately; accept its
semantic digest and workspace in the owner selection before owner startup.
Do not derive a replacement expected envelope from the first real request.

## Exact genuine client path

The selected ordinary entry is `runtime/bin/agenc`, which imports
`runtime/dist/bin/agenc.js`. Its bootstrap routes to
`src/bin/agenc-main.ts::oneShotCLI` (line 2752), then
`runDaemonOneShotPrompt` (line 2284), ordinary `agent.create` and `agent.attach`.
`initialContent` preserves the complete declared prompt instead of recovering
it from the trimmed objective.

The intended sibling invocation, only after deployment/launch approval, is:

```text
<selected Linux Node> <selected runtime>/bin/agenc \
  -p 'Say Done. Do not invoke any tool.' --light --provider openai \
  --model gpt-6-luna --config <independently pinned config> \
  --permission-mode default
```

Use the declared workspace as cwd and the exact selected private environment.
No resume, goal, file mention, image, permission bypass, custom runner or SDK
substitution is part of this gate.

The owned companion starts real `runAgenCDaemonForeground` with
`createNodeDaemonCliHost`, `enterDaemonHome:true` and the captured validator.
The ordinary `AgenCDelegateBackgroundAgentRunner::startAgent` supplies canonical
bootstrap, real shared admission repositories and `requireSandboxReadyAtStartup`.
It creates `user-initial-<managed thread id>` and submits the real managed turn.
The companion resolves the scoped Session in that same graph, checks the
independently sealed selected preparation, publishes the binding once, and
requires the matching durable dispatched UUID before the observed fetch.
The fake native callback supplies the complete scripted response and physical
EOF; it does not settle accounting or manufacture the observer's ACK.

## Smallest remaining implementation, in order

1. Finish/review the existing v3 split package build with both guarded entries
   and exact assets. Keep all execution gates false. This is useful now, without
   Linux, and does not claim a Linux closure.
2. Finish one parent recipe using existing lifecycle mechanics: create the
   declared private resources/config, run the guarded independent preflight in
   its own owned process, retain its material and closure result, then freeze
   the owner selection. Add only a thin owner caller that loads that accepted
   material, constructs `createFixtureCallbacks()` and invokes
   `runOwnedForeground()`. `owner-entry.ts` currently exports a function; it
   does not itself assemble those inputs or call the callback factory.
3. Select the current canonical Linux identity bridge/adapter. Existing
   `real-parent-adapters-v1/adapters.mjs:26` checks its pinned old
   `SOURCE_REVISION`; passing 403da unchanged will refuse. Reuse the reviewed
   sidecar/PID-start/authenticated-instance/shutdown mechanics with an explicit
   current source/build selection, not an identity override or broad bypass.
4. Once Linux is available, complete its actual native/helper/containment
   selection, then run **one** bounded owned-parent fixture: real daemon
   readiness, ordinary sibling CLI, instance-bound shutdown, owned close and
   accounting/publication reconciliation. Set lifecycle sentinel count to zero
   as the owner declares; v6 ACKs go through the existing strict dispatcher.
   Parent reads the fixed durable publisher record before initializing that
   dispatcher, never derives expectations from an ACK, and retains one dispatcher.

Canonical readiness can be a stage of that one fixture; a second generic
startup harness is not a prerequisite. Preserve failure/unknown accounting and
pending cleanup. The existing finalizer is reusable only after its exact
closure/artifact conditions hold; no additional synthetic finalizer proof is
needed merely to start this genuine-client gate.

## What is already done, and what this first run would establish

HANDOFF's current results include the guard, parent-reader, callback/type and
owned-parent checks, plus actual callback-to-unchanged-observer integration in
both financial modes and changed-task refusal. Do not repeat those as new
readiness work. Root's 403da archive build/type/1056-test result and v2 disabled
entry smoke also remain valid within their recorded scope.

A successful next run would add the missing ordinary daemon/CLI preparation,
scoped-session/UUID and physical-EOF joins under canonical Linux startup. It
would still be a **one-call no-tools** diagnostic. The existing owner explicitly
refuses a second selected call; do not describe it as the two-call CLI proof or
the paid 12-task runner. Extend this same recipe with the already declared
native-read continuation only after the one-call path works. No paid launch,
new provider, spending amount or account-balance assertion follows from this note.

## Inspected draft pins

- `preflight.ts`: `fad448e9bff8199ab5881669558a8fc6651f5d96ed69e929c1506059bd69df4f`
- `owner-entry.ts`: `680231dce925644253f02a561f0b5020f13a7b4bb1aebdcd61419f917e8eaef1`
- `preflight-entry.ts`: `cce66cfcd3c2bb0fb3049b93f9f46cc5371f4d71b866d6bc0ac6f0cd687b5c97`
- `PREPARATION-RECIPE.md`: `b4491bc7d7ac7863106c42df4dd5cbad944c2fb7add9b49bc630d85013e60d9e`

## Frozen v3 build-only review addendum

Subsequently read `build-companion.mjs` SHA256
`dd8d1cf5c2d5adcf7c00d11ab2d907a3521cf9a39c851985dd5ce6da70546c58`
through EOF and its full `COMPANION-BUILD.md`, against the actual 403da
`daemon-runtime-info.ts` and classifier asset resolver. No concrete blocker
found within the explicitly selected build-only scope:

- Flat `output/dist` module locations make the canonical resolver's `..`
  candidate the new package root; exact copied package/VERSION bytes supply
  normal identity lookup without a host override.
- The two pinned classifier files are copied to the exact relative path used
  from flat emitted modules. The original destructive asset plugin remains
  excluded. No immutable Core file or native binary is written.
- Both guarded entries participate in the split graph; each static closure
  rejects positive emitted Core source bytes before its selection gate.
  Preflight selection remains external at its original path. The one-emitted-
  ALS check and optional Chrome isolation check remain active.
- Inputs are manifest-bound before and after build; output is newly owned and
  distinct. Source/output hashes, staged assets and unresolved CJS probes are
  recorded without calling them a Linux or full runtime closure.

This is a source review, not a build result. Existing ESM/native/helper/ordinary
CLI and observer/Python deployment limits remain as stated above. No runtime
import, execution approval or benchmark readiness follows from this addendum.
