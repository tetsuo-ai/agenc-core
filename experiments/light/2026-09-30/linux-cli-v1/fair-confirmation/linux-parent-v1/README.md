# Linux ordinary-CLI one-response recipe — unexecuted draft

Author: XHIGH implementation agent; independent review/execution belongs to root. No self-independent-review claim. No provider, client, build, import, syntax check or test was run while authoring these files.

This composes existing mechanisms, not an SDK replacement: independent canonical preflight → closed preparation child → literal owner selection → canonical foreground daemon with the trusted validator → canonical `runtime/bin/agenc` sibling → one fake response through observer v6 → physical EOF/settlement/publication → authenticated instance-bound shutdown → owned close → existing finalizer. Ordinary permission mode and required sandbox startup remain enabled. The callback refuses a second selected call. This is not a 12-task runner or paid authorization.

## Inputs and commands

All paths refer to the same future non-root Linux container namespace. Root must provide network-none containment, a separate private writable run parent, immutable Core/FAIR/dependencies, no host credentials or Docker socket, and an exact-container outer watchdog of 180 seconds. `offlineLinux()` checks Linux/nonroot and loopback-only interfaces; it does not independently attest Docker configuration or protect against a dishonest trusted launcher. Root owns that boundary. Keep normal canonical sandbox support; no sandbox/permission bypass is present.

`setup.mjs` accepts a root-authored, externally SHA256-pinned JSON manifest:

```
{
  "schemaVersion": 1,
  "executionApproved": true,
  "sourceRevision": "403da04398b55e51d1f4e8814f9a70957b0db5ef",
  "buildRevision": "38d63e586a92c4da8b1e51b31d46f74ee359a55a",
  "version": {
    "commit": "38d63e586a92c4da8b1e51b31d46f74ee359a55a",
    "shortCommit": "38d63e586a92",
    "buildTime": "2026-09-30T11:17:38.000Z",
    "runtimeVersion": "0.18.0"
  },
  "coreRoot": "/gate/source",
  "fairRoot": "/gate/fair",
  "node": "<canonical pinned Linux Node path>",
  "python": "<canonical pinned Linux Python path>",
  "fixedIso": "<independently selected ISO calendar>",
  "protocolId": "<explicit one-response protocol>",
  "runId": "<fresh explicit synthetic run ID>",
  "channelId": "<fresh explicit private channel ID>",
  "spendPolicy": "<explicit credit_exhaustion object OR positive_cap object with capUsd>",
  "containment": {"network":"none","outerWatchdogSeconds":180,"ordinarySandboxRequired":true},
  "files": {"<canonical absolute immutable input path>":"<independently accepted SHA256>"}
}
```

The spendPolicy placeholder is documentation, not executable input: use exactly `{"mode":"credit_exhaustion"}` or `{"mode":"positive_cap","capUsd":"..."}` selected by root. No amount/mode is selected by this recipe. Both apply only to a newly created empty **synthetic** financial root, never the historical API ledger. The cap=0 historical authorization is neither changed nor used to infer a live balance.

```
PINNED_NODE /gate/fair/linux-parent-v1/setup.mjs SETUP_MANIFEST SETUP_MANIFEST_SHA /gate/cli-one
```

This performs no client launch/build. It creates `/gate/cli-one/build-map.json`, `setup.json`, exact config, empty workspace/.git, separate empty homes, empty synthetic finance journal, capture/log/network-attempt directories, and three identity files. Generated adapters/loader are byte-identical to v2; only the identity pins' **build** revision changes explicitly to 38d63, with all five canonical source hashes unchanged. The unchanged 60 binding-source inventory and additional CLI source checks remain 403da. Parent and preflight selections do not silently repin product source.

The generated calendar freezes no-argument `new Date()` only; `Date.now()` and monotonic timers remain real. This makes prompt calendar context deterministic without disabling elapsed deadlines. This fixture is not a startup/performance timing result.

Next root seals the independent build manifest and uses HIGH's `linux-build-v1/build.mjs` with the generated build-map and a fresh output **inside** `/gate/cli-one`, for example `/gate/cli-one/companion`. The owner selection intentionally does not exist at build time and must remain an external module at the exact path in the map. Preflight and identity overlays exist/pin before build. The three output entries are owner-caller, preflight-companion and identity-bridge. Owner, selected validator, Session and provider share one bundled canonical current-session module. The original Darwin source prefix is remapped only to the exact pinned Linux runtime/src graph.

Root then supplies a separately reviewed, externally pinned deployment manifest:

```
{
  "schemaVersion":1,"executionApproved":true,
  "sourceRevision":"403da04398b55e51d1f4e8814f9a70957b0db5ef",
  "buildRevision":"38d63e586a92c4da8b1e51b31d46f74ee359a55a",
  "setupPath":"/gate/cli-one/setup.json","setupSha256":"<actual accepted setup hash>",
  "entries":{
    "owner":"/gate/cli-one/companion/dist/owner-caller.mjs",
    "preflight":"/gate/cli-one/companion/dist/preflight-companion.mjs",
    "bridge":"/gate/cli-one/companion/dist/identity-bridge.mjs"
  },
  "cli":"/gate/source/runtime/bin/agenc",
  "clientArtifactSha256":"<accepted canonical runtime/dist/bin/agenc.js hash>",
  "files":{"<canonical absolute source/dependency/emitted/overlay/Node/Python path>":"<accepted hash>"}
}
```

Include the entire accepted source/dependency/emitted closure, root-authored selections, canonical network-tripwire source, calendar, generated identity/preflight modules, and all parent files. The `clientArtifactSha256` names the primary CLI entry, not a claim that one hash alone attests all dependencies; the deployment manifest binds that larger inventory. Root must verify dependency symlink topology/native ABI and the build's source graph independently. No file scan is itself deployment approval.

```
PINNED_NODE /gate/fair/linux-parent-v1/parent.mjs DEPLOYMENT_MANIFEST DEPLOYMENT_MANIFEST_SHA
```

The parent invokes the canonical network tripwire via explicit `--require` in preparation, foreground owner and ordinary CLI. Only fake credentials are supplied. It does not inherit caller environment/config, disable sandbox, inject a custom runner or invent a readiness sentinel. Readiness and shutdown use real sidecar + Linux /proc start token + authenticated identity, repeated by the existing lifecycle engine. `expectedMessages=0`; real observer ACKs go through the existing strict dispatcher after independently checking the publisher record.

The prepared material is read only after preflight natural exit/close/disconnect and its own canonical shutdown. The private target home receives the canonical trust-file schema for this newly created empty workspace and the exact config. The parent then writes the one-attempt immutable literal owner selection with the independent semantic digest. All files are exclusive-create and retained. A durable `parent-started.json` refuses implicit reruns. A missing owner return does not bypass finalizer accounting when the publisher/identity are available; earlier failures still preserve original journal bytes/hash and no clean token. Nothing clears a stop/lock, drops a hold, retries, derives expected values from ACK/wire, or promotes a surviving-file hash into finalizer authority.

## Staging and result limits

`STAGE-FILES.txt` is the bounded FAIR source list for this path. Preserve directory layout; do not copy fixture result roots, captures, journals, logs, credentials or old deployments. In addition to that source list, the canonical Core build/dependencies/native helpers and selected Python standard library remain real deployment inputs. The list is not a complete OS/library attestation.

Result files stay private in the new run root. `result.json` reports genuine child identity/closure and retained ledger hash. If available, `finalizer-return.json` holds the **actual returned** attempt/clean digest; there is no recovery token derived from surviving artifacts. `code_artifact_pass` stays null, no plan/quality score is fabricated, and `finalPanelReady` remains false even on success. Exactly one fake response proves this join only; native-tool continuation and matched paid-panel orchestration remain subsequent existing-path work.

Remaining inputs before execution are concrete: root review of these files; exact Linux companion build and emitted closure inventory; pinned Linux Node/Python; reviewed root-owned setup/deployment manifests; working ordinary canonical Linux sandbox and outer container containment. No new production change is assumed.
