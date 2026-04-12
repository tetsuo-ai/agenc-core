# Public Runtime Release Channel

This guide defines the public release channel for the `agenc` install path.

## Core contract

The public install surface is the `@tetsuo-ai/agenc` npm package, which exposes
the `agenc` CLI binary.

The unscoped `agenc` package name is not part of this public release channel.

```bash
npm install -g @tetsuo-ai/agenc
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

- npm package: `@tetsuo-ai/agenc`
- runtime artifact host: GitHub Releases on `tetsuo-ai/agenc-core`

Release flow:

1. `agenc-core` CI builds runtime artifacts for each supported tuple.
2. CI builds the dashboard bundle with base `/ui/` and syncs it into
   `runtime/dist/dashboard/`.
3. CI signs the manifest for the complete artifact set.
4. CI attaches the artifacts to the corresponding GitHub Release.
5. CI embeds the signed manifest, signature, public key, and trust policy into
   the published `@tetsuo-ai/agenc` wrapper package.

Phase 2 keeps local smoke/rehearsal on `file://` manifests, but the production
release contract is GitHub Releases.

## Supported tuples

Current public wrapper support is intentionally narrow:

- Linux `x64`
- macOS `arm64` (Apple Silicon)
- Node: `>=18.0.0`

The current release gate validates:

- Linux `x64` on Node `18` minimum-floor CI
- Linux `x64` on Node `20` mainline CI
- macOS `arm64` on Node `20` CI

Anything else must fail clearly as unsupported. Broader platform support should
only be added once release CI and smoke coverage exist for those tuples.

## First-use devnet marketplace rehearsal boundary

The public release-path docs should describe first-use operator marketplace
writes through `agenc`, not through the compatibility alias `agenc-runtime`.
That boundary currently includes:

- `agenc agent register`
- `agenc market tasks create|list|claim|complete`
- `agenc market tui`

Manual prerequisites still remain outside the wrapper:

- Solana CLI installation
- funded devnet signer keypair(s)
- `--rpc` or `AGENC_RUNTIME_RPC_URL`
- optional `--program-id` or `AGENC_RUNTIME_PROGRAM_ID`

If creator and worker are different identities, both signers must be funded and
registered separately before `claim` or `complete`.

See [public-wrapper-devnet-marketplace-rehearsal.md](public-wrapper-devnet-marketplace-rehearsal.md)
for the supported runbook.

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
  package install after `npm install -g @tetsuo-ai/agenc`

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

- production key rotation is delivered by publishing a new `@tetsuo-ai/agenc` wrapper
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
the embedded release assets shipped in the `@tetsuo-ai/agenc` package.
