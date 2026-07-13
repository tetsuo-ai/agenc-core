# Remote control & device pairing

Drive AgenC coding sessions running on your computer from the
[AgenC iOS app](https://github.com/tetsuo-ai/agenc-ios) or
[AgenC Android app](https://github.com/tetsuo-ai/agenc-android) — on the same
network or over cellular, through a signed relay.

Related: [gateway](gateway.md) · [onboarding](onboarding.md) ·
[install](install.md).

## The pieces

| Piece | Role |
|---|---|
| **Daemon** | App-server (`agenc daemon start`, default `ws://127.0.0.1:7766`). Hosts coding agents. Local TUI and remote phones are both clients. |
| **Connector** | `agenc remote on` (or `/remote on` in the TUI). Bridges the loopback daemon to a phone through the relay. Never holds the relay secret; asks the backend for short-lived signed *host tickets*. |
| **Relay** | Cloudflare Worker + per-room Durable Object ([`tetsuo-ai/agenc-relay`](https://github.com/tetsuo-ai/agenc-relay)). Routes frames by ticket room; each pairing is an isolated room keyed by `pairingId`. |
| **Backend** | [`tetsuo-ai/agenc-backend`](https://github.com/tetsuo-ai/agenc-backend) (`id.agenc.ag`). Mints every relay ticket (sole holder of `RELAY_TICKET_SECRET`) and runs device-pairing endpoints. |
| **iOS app** | [`tetsuo-ai/agenc-ios`](https://github.com/tetsuo-ai/agenc-ios). Pairs with code/QR, then connects through the relay. |
| **Android app** | [`tetsuo-ai/agenc-android`](https://github.com/tetsuo-ai/agenc-android). Remote session control, background completion delivery, and optional Ledger Flex approval over BLE. |

## Prerequisites

Remote pairing requires a **signed-in AgenC account on the computer**. If the
TUI/CLI has no valid remote login session, `agenc remote on` and `/remote on`
stop before creating a code, calling the backend, or opening the relay.

That computer login is also the mobile sign-in authority. The Android app does
not start Google OAuth and does not require a second hosted-account login. The
one-time code from `/remote on` signs the app into the same account and pairs it
with this computer in one claim.

```bash
# sign in first
agenc login
# or force remote backend:
AGENC_AUTH_BACKEND=remote agenc login
```

Keep the daemon reachable on loopback (default URL
`ws://127.0.0.1:7766`; override with `AGENC_DAEMON_URL`). Identity backend
defaults to `https://id.agenc.ag` (`AGENC_BACKEND_URL`).

## CLI

```bash
agenc remote on        # pair (first run shows code + QR) and keep the host reachable
agenc remote status    # linked or not
agenc remote off       # forget this machine's pairing locally
```

## Device pairing flow

Production routing pairs by *device*, not by account room:

1. Sign in on the computer with `/login` or
   `AGENC_AUTH_BACKEND=remote agenc login`. Google OAuth, when configured, is
   completed here in the browser opened by Core.
2. Run `agenc remote on`; the connector sends that remote auth bearer to
   authenticated `POST /v1/pair/start`. The backend binds the pending pairing
   to the logged-in account, and Core prints an 8-character code plus a QR
   encoding `agenc://pair?c=<code>`.
3. The connector receives a random 128-bit `pairingId` and hashed host-secret
   credential, then bridges on room `pairingId`.
4. Android starts at its code/QR screen. Scanning or typing the code calls
   `POST /v1/pair/claim` with `{ code, appLabel }`; the phone does not send a
   pre-existing bearer and does not launch Google.
5. The backend atomically consumes the one-time code, activates the pairing,
   and returns the existing pairing fields plus nested mobile authentication:

   ```json
   {
     "pairingId": "pr_...",
     "machineName": "workstation",
     "clientTicket": "...",
     "relayUrl": "wss://...",
     "expiresAt": "...",
     "auth": {
       "token": "...",
       "identity": {
         "accountId": "...",
         "displayName": "..."
       },
       "subscriptionTier": "free",
       "expiresAt": "..."
     }
   }
   ```

   The `auth` token belongs to the same account that authorized
   `/v1/pair/start`; Android stores it for `/v1/auth/me`, ticket refresh, and
   later authenticated operations. Legacy app versions may still send their
   bearer to `/v1/pair/claim`; the additive response remains decodable by them.
6. Both sides share one isolated relay room. The QR surface auto-closes when
   the phone connects.

**Security:** the backend mints every ticket; pair creation requires the
computer's remote auth bearer and records that account as owner; the host is
gated by its secret; the short-lived, single-use code authorizes exactly one
mobile session for that owner; rooms are 128-bit and isolated; there is no
server-side pairing list to enumerate. Core never sends its bearer through the
daemon or relay to the phone.

Local state: `~/.agenc/remote/pair.json` (`0600`). The connector injects the
loopback daemon cookie into the phone's `initialize` so the phone never holds
it. The connector dials **out** to the relay (no inbound ports on your
machine).

## The `/remote` command (TUI)

Inside `agenc`:

- `/remote on` — pairing code + QR on a persistent surface that auto-closes on
  connect; starts the bridge. Reuses an existing pairing if already linked.
- `/remote status` — whether a phone is linked.
- `/remote off` — stop the bridge / forget local pairing.

The bridge runs **silent** inside the TUI (raw stdout would corrupt Ink) and
never calls `process.exit` (that would kill the session).

## Session model

- Sessions are **daemon-hosted**: `agent.create` / `session.create` spin up an
  agent in the daemon; `message.send` (keyed on `sessionId`) drives it; events
  stream back. TUI and phone are both clients.
- **Co-driving**: the daemon broadcasts session events to every attached
  client; `message.send` has no per-client lock, so terminal and phone can
  drive the same live session together.
- **Working directory**: create accepts a `cwd` so a client can start a
  session in any project directory.
- **History on join**: `session.transcript` returns conversation history.
  When no live agent is attached, it falls back to the persisted thread store
  (read-only). A still-running terminal holds an exclusive rollout lock, so
  those `conv-` sessions stay read-only until the terminal exits.

## Authenticated mobile capabilities

After the relay bridge authenticates `initialize`, a phone may advertise
capabilities in addition to attaching to individual sessions:

| Capability | Delivery semantics |
| --- | --- |
| `portal.mobile.status.push.v1` | Observer fan-out for global `event.agent_status` frames, including completion while the phone is not attached to that session |
| `portal.ledger.solana.sign.v1` | Single-consumer typed Ledger action routing to the newest capable phone |

The daemon registers capability clients during initialize, before any
`session.attach`. Logical registrations on one physical socket share a delivery
key, preventing duplicate status notifications. Status replay comes from each
session's ordinary bounded buffer and contains status frames only; joining chat
history still requires `session.attach`/`session.transcript`.

Ledger actions use a separate one-consumer replay buffer so two capable phones
cannot both receive the same signing request. See
[mobile Ledger transfer](security/mobile-ledger-transfer.md).

## Background completion and attention delivery

Android keeps the authenticated relay/Core socket alive with a foreground
`remoteMessaging` service only while all three conditions are true: the app is
backgrounded, the user is signed in, and a host is paired. The Activity remains
the owner in the foreground; moving between the two does not deliberately tear
down the socket. Ticket refreshes reuse the normal single-flight reconnect and
backoff path.

Global status push lets the phone notify about a session without keeping every
chat attached. Android deduplicates event ids and terminal turns, applies the
user's completion/attention settings, mute, quiet-hours, and optional duration
threshold, and suppresses notifications for the session currently visible in
the foreground. Tapping a notification deep-links to that exact session.

The persistent foreground-service notification is operational state, not a
task-completion alert. It is silent, low priority, and uses the AgenC mark.

## Account identity reconciliation

For the remote backend, every `auth.whoami` revalidates the persisted login
bearer with `POST https://id.agenc.ag/v1/auth/me` and returns the canonical
account identity plus subscription tier. Override that endpoint with
`AGENC_REMOTE_AUTH_ME_URL` when running a compatible identity service. A
successful lookup refreshes the identity/tier snapshot in `auth.json`; HTTP
401/403 clears the rejected session and returns signed out. Network, server,
and invalid-response failures surface as RPC errors instead of presenting the
previous snapshot as verified.

The bearer remains private to the Core auth backend. `auth.login` persists it
for subsequent remote calls but the app-server response only exposes the
non-secret login state and identity.

Because `/v1/pair/claim` bootstraps the phone from the authenticated Core code,
new pairings start with the same account identity. The phone still reconciles
its mobile bearer identity with the Core `/login` identity to detect expired,
legacy, or mismatched state:

- stable account ids are authoritative when both sides provide them;
- older records may link through an exact normalized email/handle match;
- conflicting ids are shown as a mismatch and never overwrite the phone
  account;
- the runtime tier is used only when Core marks it as verified.

This means a user already logged in through `/login` sees the linked account in
Android without creating a second runtime identity.

## Permission and elicitation replies

Interactive replies are dispatched outside the connection's ordinary FIFO so
they can resolve a tool or elicitation currently blocking the request at the
front of that FIFO:

- `tool.approve`
- `tool.deny`
- `elicitation.respond`

They still count against the connection's normal overload limits. Cancellation
controls retain their separate overload exemption.

An Android **Allow for session** action sends:

```json
{
  "sessionId": "session-id",
  "requestId": "permission-request-id",
  "scope": "session",
  "allowAllToolsForSession": true
}
```

Core atomically promotes that daemon session to `bypassPermissions` before
releasing the blocked tool. If the request disappeared or settlement fails, it
rolls the permission context back. Plain `scope: "session"` without the opt-in
flag keeps the older, narrower equivalent-rule cache semantics.

## Compatibility and rollout

Capabilities are opt-in and old clients continue to use attachment-bound
events. Deploy Core before relying on Android background status or `@ledger`:

| Combination | Result |
| --- | --- |
| New Core + old phone | Existing pairing/chat works; new capabilities are simply absent |
| Old Core + new phone | Pairing/chat works, but no global status push, typed Ledger action, or all-tools session promotion |
| New Core + new Android | Full background notification, identity, permission, and Ledger protocol |

Provider credentials and model execution remain on the host machine. The phone does not
receive `XAI_API_KEY` or another provider secret.

## Related

- iOS app + UX — [`tetsuo-ai/agenc-ios`](https://github.com/tetsuo-ai/agenc-ios)
- Android app + UX — [`tetsuo-ai/agenc-android`](https://github.com/tetsuo-ai/agenc-android)
- Relay — [`tetsuo-ai/agenc-relay`](https://github.com/tetsuo-ai/agenc-relay)
- Backend pairing API — [`tetsuo-ai/agenc-backend`](https://github.com/tetsuo-ai/agenc-backend)
- Mobile Ledger security contract — [security/mobile-ledger-transfer.md](security/mobile-ledger-transfer.md)
- Provider tool-schema compatibility — [provider-tool-compat.md](provider-tool-compat.md)
