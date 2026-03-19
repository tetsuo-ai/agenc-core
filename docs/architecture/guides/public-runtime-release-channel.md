# Public Runtime Release Channel

This guide defines the public release channel for the `agenc` install path.

## Core contract

The public install surface is the `agenc` npm package.

```bash
npm install -g agenc
```

That package does **not** publish the raw runtime workspace as a normal npm
dependency. Instead, it ships:

- a small wrapper/launcher
- an embedded signed runtime manifest
- an embedded manifest signature
- an embedded public verification key
- an embedded trust policy

On first install or first run, the wrapper installs the matching runtime
artifact into the canonical operator home and then launches the real runtime
bins from there.

## Public release channel

The public runtime artifact channel is:

- npm package: `agenc`
- runtime artifact host: GitHub Releases on `tetsuo-ai/agenc-core`

Release flow:

1. `agenc-core` CI builds the runtime artifact for the supported tuple.
2. CI builds the dashboard bundle with base `/ui/` and syncs it into
   `runtime/dist/dashboard/`.
3. CI signs the manifest for that artifact.
4. CI attaches the artifact to the corresponding GitHub Release.
5. CI embeds the signed manifest, signature, public key, and trust policy into
   the published `agenc` wrapper package.

Phase 2 keeps local smoke/rehearsal on `file://` manifests, but the production
release contract is GitHub Releases.

## Supported tuple

Current public wrapper support is intentionally narrow:

- platform: `linux`
- arch: `x64`
- Node: `>=18.0.0`

The current release gate validates that tuple on:

- Node `18` minimum-floor CI
- Node `20` mainline CI

Anything else must fail clearly as unsupported. Broader platform support should
only be added once release CI and smoke coverage exist for those tuples.

## Installed layout

The wrapper installs runtime artifacts under:

- `~/.agenc/runtime/releases/<runtime-version>/<platform>-<arch>/`

It also maintains:

- stable current pointer: `~/.agenc/runtime/current`
- install metadata: `~/.agenc/runtime/install-state.json`

The wrapper always launches the runtime through the stable `current` pointer so
service templates, TUI handoff, dashboard serving, and compatibility bins do
not bind to a stale versioned path.

Runtime packaging requirement:

- each public runtime artifact must include the dashboard assets at
  `runtime/dist/dashboard/`
- `agenc ui` must work against that bundled dashboard without a separate web
  checkout or build step on the user machine
- the base runtime artifact must include the first-party Telegram connector
  lifecycle surface so `agenc connector add telegram` does not require a second
  package install after `npm install -g agenc`

Release-gate requirement:

- fresh install must create `~/.agenc/runtime/current`
- wrapper-managed update must advance `current` to the newer release
- `install-state.json` must converge to the upgraded runtime version

## Trust model

The trust model is:

- SHA-256 verification on every runtime artifact
- Ed25519 signature verification for the manifest
- wrapper-version compatibility lock between the published wrapper and embedded
  trust assets
- embedded trust policy with explicit revocation lists for manifest digests and
  runtime versions

Key rotation model:

- production key rotation is delivered by publishing a new `agenc` wrapper
  version with a new embedded public key and trust policy
- local development can override trust assets explicitly through development
  environment variables

Revocation model:

- runtime revocations are distributed through an updated wrapper release
- the wrapper does not depend on an always-online control plane to run after the
  initial install

## Offline behavior

After the runtime artifact is installed locally, the operator can continue using
`agenc` offline.

Network access is required only when:

- no matching runtime release is installed yet
- the operator explicitly runs `agenc runtime update`

## Development overrides

Local development and release rehearsal may override the embedded trust assets
with:

- `AGENC_RUNTIME_MANIFEST_FILE`
- `AGENC_RUNTIME_SIGNATURE_FILE`
- `AGENC_RUNTIME_PUBLIC_KEY_FILE`
- `AGENC_RUNTIME_TRUST_POLICY_FILE`

These are development-only escape hatches. Production installs should rely on
the embedded release assets shipped in the `agenc` package.
