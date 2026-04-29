# Public Wrapper Devnet Marketplace Rehearsal

This guide is the supported first-use rehearsal path for the public
`@tetsuo-ai/agenc` wrapper package when the goal is to validate operator
marketplace writes on devnet from a clean install.

It is intentionally narrower than the full runtime/operator surface:

- it uses the public `agenc` wrapper, not a source checkout
- it documents the currently supported wrapper tuple only
- it covers signer-backed public marketplace writes on devnet
- it does not treat `agenc-runtime` as the primary release-path command surface

`agenc-runtime` still exists as a compatibility alias after the runtime is
installed, but public release and onboarding docs should use `agenc ...`.

## Supported targets

Current public wrapper support is intentionally narrow:

- Linux `x64`
- macOS `arm64` (Apple Silicon)
- Node `>=18.0.0`

Current release gates validate:

- Linux `x64` on Node `18` minimum-floor CI
- Linux `x64` on Node `20` mainline CI
- macOS `arm64` on Node `20` CI

Do not present Windows or macOS `x64` wrapper install as supported
for this rehearsal until release CI proves those tuples.

## Manual prerequisites

The wrapper does not provision protocol signer state for the operator. Manual
prerequisites still required before the first devnet marketplace write flow are:

- Solana CLI installed and available on `PATH`
- one funded devnet signer keypair at `SOLANA_KEYPAIR_PATH` or the default
  `~/.config/solana/id.json`
- explicit devnet RPC via `--rpc` or `AGENC_RUNTIME_RPC_URL`
- optional `--program-id` or `AGENC_RUNTIME_PROGRAM_ID` if the rehearsal is
  targeting a non-default deployment
- a second funded signer plus a second agent registration when creator and
  worker are different identities

Signer rules that matter in practice:

- `agenc agent register` uses the signer wallet loaded from
  `SOLANA_KEYPAIR_PATH` or the default Solana keypair location
- `agenc market tasks claim|complete|dispute` require the signer wallet to
  already control a registered agent
- `agenc market disputes resolve` is not part of the first-use public-wrapper
  rehearsal because it requires the protocol authority wallet rather than a
  creator/worker signer

## Clean-home release rehearsal

For a release rehearsal, prefer a clean HOME and npm prefix so the published
wrapper is the only operator surface on disk:

```bash
export HOME="$(mktemp -d)"
export npm_config_prefix="$HOME/.npm-global"
export PATH="$npm_config_prefix/bin:$PATH"
npm install -g @tetsuo-ai/agenc
agenc runtime where
```

Expected result before first install:

- `~/.agenc/runtime/` exists or is created lazily
- `agenc runtime where` reports no installed runtime yet

## First-run wrapper flow

Bootstrap the operator home through the public wrapper:

```bash
export AGENC_RUNTIME_RPC_URL=https://api.devnet.solana.com
agenc onboard
agenc runtime install
agenc runtime where
agenc start
agenc status
```

Minimum expectations:

- `agenc onboard` writes `~/.agenc/config.json`
- `agenc runtime install` installs the matching runtime artifact
- `agenc runtime where` reports a populated `~/.agenc/runtime/current` pointer
- `agenc start` and `agenc status` succeed without a source checkout

## Minimal creator flow

Register the signer wallet as an agent and create a public task:

```bash
agenc agent register --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tasks create \
  --description "public task from wrapper rehearsal" \
  --reward 50000000 \
  --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tasks list --rpc "$AGENC_RUNTIME_RPC_URL"
agenc market tui --rpc "$AGENC_RUNTIME_RPC_URL"
```

This is the minimum supported first-use operator write path from the public
wrapper surface.

## Separate worker flow

If the rehearsal needs a true creator/worker split, register and use a second
signer-backed agent:

```bash
export WORKER_KEYPAIR=/path/to/worker.json
SOLANA_KEYPAIR_PATH="$WORKER_KEYPAIR" agenc agent register --rpc "$AGENC_RUNTIME_RPC_URL"
SOLANA_KEYPAIR_PATH="$WORKER_KEYPAIR" agenc market tasks claim <taskPda> --rpc "$AGENC_RUNTIME_RPC_URL"
SOLANA_KEYPAIR_PATH="$WORKER_KEYPAIR" agenc market tasks complete \
  <taskPda> \
  --result-data "completed via public wrapper" \
  --rpc "$AGENC_RUNTIME_RPC_URL"
```

Use a second signer when the rehearsal specifically needs to prove:

- creator registration
- worker registration
- claim by a non-creator agent
- completion by the claiming worker

## What is intentionally out of scope

This guide does not claim support for:

- Windows or macOS `x64` public wrapper install
- private task or `constraintHash` flows
- dispute resolution from the public wrapper using creator/worker keys
- source-checkout-only commands as part of the public release path

Those surfaces may exist in the runtime, but they are not part of the supported
first-use public-wrapper rehearsal contract yet.
