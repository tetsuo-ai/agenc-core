# Remote control & device pairing

Drive AgenC coding sessions running on your computer from the [AgenC iOS app](https://github.com/tetsuo-ai/agenc-ios) — on the same network or anywhere over cellular, through a signed relay.

## The pieces

- **Daemon (this repo)** — the app-server (`agenc daemon start`, `ws://127.0.0.1:7766`). Hosts coding agents. Both the local `agenc` TUI and remote phones are *clients* of it.
- **Connector** — `agenc remote on` (or the `/remote on` slash command inside the TUI). Bridges the loopback daemon to a phone through the relay. It never holds the relay secret; it asks the backend for short-lived, signed *host tickets*.
- **Relay** — one Cloudflare Worker + a per-room Durable Object ([`tetsuo-ai/agenc-relay`](https://github.com/tetsuo-ai/agenc-relay)). Routes frames by the ticket's room; each pairing gets an isolated room keyed by `pairingId`.
- **Backend** — [`tetsuo-ai/agenc-backend`](https://github.com/tetsuo-ai/agenc-backend) (Hono on Vercel, `id.agenc.ag`). Mints every relay ticket (the only holder of `RELAY_TICKET_SECRET`) and runs the device-pairing endpoints.
- **iOS app** — [`tetsuo-ai/agenc-ios`](https://github.com/tetsuo-ai/agenc-ios). Pairs with a code/QR, then connects through the relay and drives sessions.

## Device pairing

Production account identity is a shared mock, so routing by account would put every phone in the same room. Instead we pair by *device*:

1. On the computer: `agenc remote on` prints an 8-char code and a QR encoding `agenc://pair?c=<code>`.
2. The connector registers the pairing with the backend (a random 128-bit `pairingId` + a hashed host secret) and starts bridging on the room `pairingId`.
3. In the app: scan the QR or type the code → the app calls `/v1/pair/claim` (bearer-gated) → the backend marks the pairing active and issues the app a signed *client ticket* for the same room.
4. Both sides now share one isolated relay room. The QR surface auto-closes the moment the phone connects.

**Security:** the backend mints every ticket; the host is gated by its secret, the claim by the app's bearer; the code is single-use; rooms are 128-bit and isolated; there is no server-side pairing list to enumerate.

## The `/remote` command

Inside the `agenc` TUI:

- `/remote on` — render the pairing code + QR on a persistent surface that auto-closes on connect, and start the bridge. Reuses an existing pairing if already linked.
- `/remote status` — show whether a phone is linked.
- `/remote off` — stop the bridge.

The bridge runs **silent** inside the TUI (raw stdout writes would corrupt the Ink render) and never calls `process.exit` (it would kill the session).

## Session model

- Sessions are **daemon-hosted**: `agent.create` / `session.create` spin up an agent in the daemon; `message.send` (keyed on `sessionId`) drives it; events stream back. The local TUI and the phone are both just clients.
- **Co-driving**: the daemon broadcasts session events to *every* attached client and `message.send` has no per-client lock, so a terminal and a phone can drive the same live session together.
- **Working directory**: `agent.create` / `session.create` accept a `cwd`, so a client can start a session in any project directory. The app surfaces this as *new session → working directory*.
- **History on join**: `session.transcript` returns a session's conversation. When no live agent is attached (a persisted or terminal-started session), it falls back to the persisted thread store so a joining client still sees history (read-only). A still-running terminal holds an exclusive rollout lock, so those `conv-` sessions are read-only until the terminal exits.

## Related

- iOS app + UX — [`tetsuo-ai/agenc-ios`](https://github.com/tetsuo-ai/agenc-ios) (`README.md`, `REMOTE_ACCESS_ARCHITECTURE.md`).
- Relay — [`tetsuo-ai/agenc-relay`](https://github.com/tetsuo-ai/agenc-relay).
- Backend pairing API — [`tetsuo-ai/agenc-backend`](https://github.com/tetsuo-ai/agenc-backend) (`docs/api.md`).
- Provider tool-schema compatibility — [provider-tool-compat.md](./provider-tool-compat.md).
