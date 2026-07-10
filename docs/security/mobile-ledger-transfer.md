# Mobile Ledger transfer protocol

This document is the security and recovery contract for the AgenC Android
`@ledger` flow. The host runtime prepares one typed Solana transfer request,
the paired phone presents it to a Ledger Flex over BLE, and the phone returns a
correlated receipt. Core never receives a private key and never signs or
broadcasts the transaction.

## Supported surface

Version 1 supports one operation only:

- network: Solana `mainnet-beta`;
- asset: native SOL;
- action: transfer from the default Ledger account selected on the phone;
- amount: positive lamports encoded as decimal text;
- result: `submitted` or `cancelled`.

Tokens, swaps, staking, arbitrary instructions, devnet, and choosing the source
account from model output are out of scope. They require separate typed action
versions and review rules. `submitted` means the exact signed bytes were handed
to Solana RPC. It does not mean confirmed or finalized.

## Trust boundary

| Component | Authority |
| --- | --- |
| Root human turn | Authorizes routing once by containing the exact `@ledger` token |
| Model | May propose `to`, `lamports`, and a short note; cannot select the source wallet or manufacture a client action |
| Core | Validates the active turn, creates the intent/challenge, routes one typed action, validates the receipt |
| Relay/backend | Authenticates and transports frames for the paired room; never signs |
| Android app | Validates the action, binds it to the pairing/default account, persists recovery state, builds and broadcasts the transaction |
| Ledger Flex | Holds the private key and asks the human to physically approve the clear-sign review |

The standalone Ledger `wallet-cli` is not part of this path. Core does not call
it and the Mac is not a second signer. The Android native BLE/APDU path is the
only transaction signer and broadcaster in v1.

## Authorization before model sampling

Core binds trusted root-human text to the active turn before tools can execute.
When that exact text contains `@ledger` as a case-insensitive token boundary:

1. trusted, non-durable system guidance tells the model to call
   `request_ledger_transfer` only for an unambiguous SOL transfer;
2. the tool is valid only on that same active root turn;
3. a turn-owned atomic claim permits one transfer attempt only;
4. subagent and autonomous/synthetic turns have no `@ledger` authority;
5. every other model tool is denied unless it is explicitly read-only and has
   no contradictory mutating, interactive, or side-effecting metadata;
6. generic `request_user_input` rejects a model-supplied `clientAction`.

Strings such as `email@ledger`, `@ledger_wallet`, and `@ledgered` do not grant
authority. A prior message containing the token does not authorize a later
turn. Read-only balance or context checks may occur, but no competing mutation
may run during the authorized transfer turn.

## Capability negotiation and delivery

The phone advertises this initialize capability:

```text
portal.ledger.solana.sign.v1
```

Core sends Ledger actions through the client multiplexer instead of broadcasting
them to every session attachment. The newest live capable physical connection
is the single consumer. Multiple logical registrations on the same socket share
one delivery key and therefore do not receive duplicates.

If no capable phone is live, or delivery fails after selection, Core retains a
bounded replay entry while the daemon session remains live. Registration and
replay use a one-consumer lease so two phones reconnecting concurrently cannot
both drain the same action. This host buffer improves delivery; Android's
durable inbox and tombstones provide the signing idempotency boundary.

## Action contract

Core creates a random intent id, a 256-bit base64url response challenge, and a
10-minute expiry. Android rejects actions that are expired or more than 15
minutes in the future.

```json
{
  "type": "ledger_solana_transfer_v1",
  "source": "agenc-core",
  "targetCapability": "portal.ledger.solana.sign.v1",
  "network": "mainnet-beta",
  "intentId": "ledger_2d5c...",
  "responseNonce": "43-character-base64url-challenge",
  "to": "Base58SolanaRecipient",
  "lamports": "50000000",
  "note": "optional display text, at most 240 characters",
  "expiresAt": "2026-07-10T12:10:00.000Z"
}
```

Validation is fail-closed:

- `source`, action type, capability, network, and expiry must match v1;
- `intentId` is restricted to an Android-safe identifier;
- `responseNonce` is 32–128 URL-safe characters;
- `to` decodes to exactly 32 bytes;
- `lamports` is a positive base-10 integer string and fits the mobile signed
  64-bit boundary;
- no floating-point SOL conversion crosses the wire.

The phone selects the persisted source account. Neither model output nor the
action may override it.

## Receipt contract

After physical review, Android answers `elicitation.respond` using a dedicated
`clientResult`, not free-text answers.

Submitted:

```json
{
  "type": "ledger_solana_transfer_receipt_v1",
  "intentId": "ledger_2d5c...",
  "responseNonce": "43-character-base64url-challenge",
  "status": "submitted",
  "network": "mainnet-beta",
  "to": "Base58SolanaRecipient",
  "lamports": "50000000",
  "from": "Base58DefaultLedgerAccount",
  "signature": "Base58TransactionSignature"
}
```

Cancelled:

```json
{
  "type": "ledger_solana_transfer_receipt_v1",
  "intentId": "ledger_2d5c...",
  "responseNonce": "43-character-base64url-challenge",
  "status": "cancelled",
  "network": "mainnet-beta",
  "to": "Base58SolanaRecipient",
  "lamports": "50000000",
  "from": "Base58DefaultLedgerAccount",
  "reason": "rejected_on_device"
}
```

The daemon response normalizer accepts only the declared fields and status
shape. The tool then binds intent, challenge, network, recipient, and lamports
to the original action; validates 32-byte source/recipient keys and a 64-byte
submitted signature; and strips the challenge before exposing a result to the
model. The model-visible result always includes `confirmed: false`.

## Android durable state machine

The phone maintains three independent durable structures:

1. **Capability inbox** — FIFO of at most eight actions across sessions.
   Intent tombstones survive consumption until expiry so relay/Core replays
   cannot create a second signing prompt.
2. **Active hardware slot** — one exact host/session/request/intent/challenge/
   wallet/recipient/amount tuple. A monotonic `hardwareReviewStarted` fence is
   committed immediately before the Ledger signing APDU. Once set, a restart
   must recover or fail closed; it must never ask the device to sign that intent
   again.
3. **Receipt outbox** — append-only, host-bound terminal receipts awaiting an
   authoritative Core acknowledgement. Production intentionally does not cap
   this small public-metadata archive: losing an unacknowledged financial
   receipt is worse than gradual local growth. Exact acknowledgement compacts
   it.

The irreversible ordering is:

```text
persist correlation
  -> persist hardware-review fence
  -> show Ledger clear-sign review
  -> persist signed transaction bytes + signature + last-valid height
  -> broadcast those exact bytes
  -> persist terminal receipt
  -> send typed receipt to Core
  -> remove only after correlated acknowledgement
```

An ambiguous RPC result never triggers a new signature. Android rebroadcasts
the same persisted bytes. It may abandon them only after the blockhash window
has expired and the same RPC proves that the signature is absent. A stale
cancellation callback cannot overwrite a submitted receipt.

If Core has already settled the elicitation but Android cannot prove that the
exact receipt was accepted, the receipt remains in the outbox and retries
independently. This releases the active hardware slot without losing recovery
evidence.

## Pairing, logout, and host changes

Every durable record carries the pairing/host binding. Android never rebinds a
receipt from one Mac to another.

- Unsigned actions are removed on logout/host change, but tombstones remain
  until expiry.
- A valid terminal receipt is archived before switching identity or host.
- Logout/host change is blocked while signing, broadcasting, or ambiguous
  recovery is in progress.
- If archival persistence fails, the operation aborts and the UI asks the user
  to stay paired and retry.
- Forgetting the Ledger removes the app's saved device/account association; it
  does not delete funds, keys, or the Android Bluetooth bond.

Android disables cloud backup and device-to-device extraction for pairing,
identity, and Ledger recovery state. A new phone must authenticate and pair
again.

## Failure and UI semantics

- An expired, malformed, mismatched, missing-challenge, or already-consumed
  action fails without BLE signing.
- Device rejection produces a typed cancellation reason.
- Missing default account pauses before the irreversible boundary and directs
  the user to select one.
- The chat renders `@ledger` and the terminal receipt in violet.
- A submitted receipt is labeled as submitted/awaiting confirmation, never as
  finalized.

## Verification checklist

Automated coverage must include exact-token matching, current-turn binding,
one-shot claims, subagent rejection, non-read-only tool blocking, capability
single-consumer/replay behavior, strict action/result parsing, nonce and field
binding, receipt monotonicity, hardware-review fences, same-byte rebroadcast,
host exit policy, and outbox reconciliation.

Safe device rehearsal can use a real request followed by rejection on the
Ledger. A broadcast-path mainnet rehearsal moves real funds and must never be
treated as a routine test.

## Source map

| Layer | Source |
| --- | --- |
| Core tool and binding | `runtime/src/elicitation/request-ledger-transfer.ts` |
| Core action/result types | `runtime/src/elicitation/types.ts`, `respond.ts` |
| Root-turn policy | `runtime/src/session/run-turn.ts`, `session.ts`, `tools/router.ts` |
| Capability routing | `runtime/src/app-server/client-multiplexer.ts`, `daemon-dispatcher.ts` |
| SDK mirror | `packages/agenc-sdk/src/events.ts`, `protocol.ts` |
| Android implementation | [`tetsuo-ai/agenc-android`](https://github.com/tetsuo-ai/agenc-android) |
