# Remote control & device pairing

Drive AgenC coding sessions running on your computer from the
[AgenC iOS app](https://github.com/tetsuo-ai/agenc-ios) — on the same network
or over cellular, through a signed relay.

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

## Prerequisites

Remote pairing requires a **signed-in AgenC account**. If the TUI/CLI has no
valid remote login session, `agenc remote on` and `/remote on` stop before
creating a code, calling the backend, or opening the relay.

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

1. Sign in with `/login` or `AGENC_AUTH_BACKEND=remote agenc login`.
2. Run `agenc remote on`; the connector sends the remote auth bearer to the
   backend, prints an 8-char code, and shows a QR encoding
   `agenc://pair?c=<code>`.
3. The connector registers the pairing (random 128-bit `pairingId` + hashed
   host secret) and bridges on room `pairingId`.
4. In the app: scan the QR or type the code → `/v1/pair/claim` (bearer-gated)
   → backend marks the pairing active and issues a signed *client ticket* for
   the same room.
5. Both sides share one isolated relay room. The QR surface auto-closes when
   the phone connects.

**Security:** the backend mints every ticket; pair creation requires the
computer's remote auth bearer; the host is gated by its secret; claim is gated
by the app bearer; the code is single-use; rooms are 128-bit and isolated;
there is no server-side pairing list to enumerate.

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

## Related

- iOS app + UX — [`tetsuo-ai/agenc-ios`](https://github.com/tetsuo-ai/agenc-ios)
- Relay — [`tetsuo-ai/agenc-relay`](https://github.com/tetsuo-ai/agenc-relay)
- Backend pairing API — [`tetsuo-ai/agenc-backend`](https://github.com/tetsuo-ai/agenc-backend)
- Provider tool-schema compatibility — [provider-tool-compat.md](provider-tool-compat.md)
