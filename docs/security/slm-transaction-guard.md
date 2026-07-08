# SLM Transaction Guard

The AgenC runtime can run a local CourtGuard-style SLM check before executing
Solana transaction-like tool calls. The guard is designed for prompt-injection
defense: it builds a normalized, redacted "docket" of the transaction/tool
intent and runs it through a local Ollama-hosted model, then fails closed before
the tool is allowed to sign or submit.

Classification is a four-prompt court pipeline against Ollama's `/api/chat`
endpoint (temperature 0): a defense and a prosecution argument over the docket,
a conservative deny-by-default judge, and a final strict classifier that emits
exactly `benign` or `adversarial`. The guard lives in
`runtime/src/transaction-guard/` (`OllamaCourtGuard` in `ollama-courtguard.ts`,
docket construction in `docket.ts`, intent detection in `tool-intent.ts`).

This is integrated at the unified tool-execution path (`runToolUse` in
`runtime/src/tools/execution.ts`), which calls the guard gate
(`evaluateToolInvocationTransactionGuard`) immediately before `Tool.execute()`.
The current codebase does not reintroduce the old Solana SDK transaction
scaffold, `@solana/web3.js`, or Anchor as runtime dependencies.

## Enablement

Install the requested Gemma 4 E4B model:

```bash
ollama pull gemma4:e4b
```

Enable the guard in `~/.agenc/config.toml`:

```toml
[transaction_guard]
enabled = true
model = "gemma4:e4b"
endpoint = "http://127.0.0.1:11434"
fail_mode = "closed"   # "closed" (default) blocks when the guard is
                       # unavailable; "open" lets the call proceed unguarded
```

Environment variables remain overrides on top of the config block
(precedence: env > config > built-in defaults):

```bash
export AGENC_TRANSACTION_GUARD=slm            # "slm" enables; any other value disables
export AGENC_TRANSACTION_GUARD_MODEL=gemma4:e4b
export AGENC_TRANSACTION_GUARD_OLLAMA_URL=http://127.0.0.1:11434
export AGENC_TRANSACTION_GUARD_FAIL_MODE=closed
export AGENC_TRANSACTION_GUARD_TIMEOUT_MS=120000
```

`agenc doctor` reports the effective guard status (enabled/disabled, the
source of that decision, model, endpoint) and probes endpoint reachability
with a short timeout, warning when the guard is enabled but its endpoint is
down.

When enabled with the default `fail_mode = "closed"`, malformed verdicts,
model timeouts, and Ollama errors all resolve to an `unavailable` decision
that blocks the transaction-like action before execution (fail-closed).
Sensitive-looking fields (keys, secrets, mnemonics, seeds, tokens, passwords,
authorization headers) are redacted before the intent is serialized into the
docket.

## What Is Guarded

The guard evaluates mutating Solana-like calls before `Tool.execute()`,
including shell and dynamic tool invocations that look like:

- `solana transfer`, `solana airdrop`, or `solana program deploy`
- `anchor deploy`, `anchor upgrade`, or `anchor send-tx`
- `spl-token transfer`, mint, burn, approve, revoke, close, or authority writes
- `sendTransaction`, `sendRawTransaction`, `sendAndConfirmTransaction`
- wallet signing methods such as `wallet.sign` or `signTransaction`

A dynamic or MCP tool is also evaluated when its metadata declares a Solana
`family`/keyword and `mutating: true`, even without a matching command string.

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
