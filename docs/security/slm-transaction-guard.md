# SLM Transaction Guard

The AgenC runtime can run a local CourtGuard-style SLM check before executing
Solana transaction-like tool calls. The guard is designed for prompt-injection
defense: it inspects the normalized transaction/tool intent, asks a local
Ollama-hosted model to classify the intent, and fails closed before the tool is
allowed to sign or submit.

This is integrated at the runtime tool-dispatch layer. The current codebase
does not reintroduce the old Solana SDK transaction scaffold, `@solana/web3.js`,
or Anchor as runtime dependencies.

## Enablement

Install the requested Gemma 4 E4B model:

```bash
ollama pull gemma4:e4b
```

Enable the guard:

```bash
export AGENC_TRANSACTION_GUARD=slm
export AGENC_TRANSACTION_GUARD_MODEL=gemma4:e4b
export AGENC_TRANSACTION_GUARD_OLLAMA_URL=http://127.0.0.1:11434
export AGENC_TRANSACTION_GUARD_TIMEOUT_MS=120000
```

When enabled, malformed verdicts, model timeouts, and Ollama errors block the
transaction-like action before execution.

## What Is Guarded

The guard evaluates mutating Solana-like calls before `Tool.execute()`,
including shell and dynamic tool invocations that look like:

- `solana transfer`, `solana airdrop`, or `solana program deploy`
- `anchor deploy`, `anchor upgrade`, or `anchor send-tx`
- `spl-token transfer`, mint, burn, approve, revoke, close, or authority writes
- `sendTransaction`, `sendRawTransaction`, `sendAndConfirmTransaction`
- wallet signing methods such as `wallet.sign` or `signTransaction`

Read-only lookups such as `solana balance`, `solana address`, and
`solana config get` are not evaluated.

## DevNet Live Validation

Live tests must never rely on ambient Solana CLI defaults. This machine's
default CLI config may point at mainnet-beta, so the live suite refuses any RPC
that does not explicitly contain `devnet`.

The default wallet path is only referenced as a local keypair file:

```bash
/Users/<user>/.config/solana/id.json
```

Run the live suite with explicit DevNet settings:

```bash
AGENC_TRANSACTION_GUARD_LIVE_E2E=1 \
AGENC_TRANSACTION_GUARD=slm \
AGENC_TRANSACTION_GUARD_MODEL=gemma4:e4b \
AGENC_TRANSACTION_GUARD_DEVNET_RPC=https://api.devnet.solana.com \
AGENC_TRANSACTION_GUARD_DEVNET_KEYPAIR=/Users/<user>/.config/solana/id.json \
npm --workspace=@tetsuo-ai/runtime run test:transaction-guard:live
```

The live suite checks DevNet balance, requests a small DevNet airdrop only when
needed, proves an adversarial transaction command is blocked before execution,
and then submits one bounded DevNet transfer through the guarded path.
