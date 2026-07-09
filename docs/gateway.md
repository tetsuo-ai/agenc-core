# Channel gateway

The gateway turns messaging surfaces (Telegram, WebChat, stdio, …) into
conversations with agents owned by your local daemon. It is a **daemon
client** — it talks to the daemon only through the embedding SDK
(`@tetsuo-ai/agenc-sdk`), never runtime internals — so channels are a
client-side addition, not a runtime change.

## Running it

```bash
agenc gateway run --stdio          # local dev channel: type to your agent
agenc gateway run --webchat        # browser UI (prints a loopback URL + token)
AGENC_TELEGRAM_BOT_TOKEN=123:ABC \
  agenc gateway run                # start the Telegram channel
```

`agenc gateway run` connects to the daemon (starting one if needed), loads
`gateway/config.json`, and starts the enabled channels: `--stdio` for the
local line-oriented dev channel, `--webchat` for the browser UI, and Telegram
whenever `AGENC_TELEGRAM_BOT_TOKEN` is set. It runs until Ctrl-C.

The **stdio channel** is the fastest way to see the whole pipeline: run
`agenc gateway run --stdio`, and if the `stdio` channel has no allowlist entry
you'll get a pairing code on your first line. Confirm it on the host with
`agenc gateway pairing list`, then reply with the code in the channel to pair
(or allowlist `local` in config to skip pairing).

The **WebChat channel** serves a minimal browser chat from the gateway itself.
It **binds loopback (127.0.0.1) and refuses a non-loopback host** without an
explicit override, and every request is gated by a shared token — the run
command prints `http://127.0.0.1:<port>/?token=<token>`; open that. The token
is persisted under `gateway/webchat-token` (0600) so the URL survives
restarts, or set `AGENC_WEBCHAT_TOKEN`. Because the loopback bind + token is
the auth, the web sender is allowlisted by default (no pairing with your own
browser). Streaming replies update in place over Server-Sent Events, and an
approval request renders Approve/Deny buttons that send the exact token reply
— so the approval still settles only through the round-trip. To reach it from
another device, prefer a tailnet or SSH tunnel to the loopback port, not a
non-loopback bind.

The **Telegram channel** uses the official Bot API (no reverse-engineered
client, no account-ban risk). Create a bot with @BotFather, export the token,
and message it. Streaming replies edit one message in place.

## Heartbeat (proactive ticks)

`agenc gateway run --heartbeat` (or `[heartbeat] enabled = true`) runs a
periodic autonomous turn: on each tick the agent reads `HEARTBEAT.md` from the
workspace and acts, replying `HEARTBEAT_OK` (delivery suppressed) when there is
nothing to do. It is **bounded by the budget layer** (task 15): each tick is
admitted pre-flight, and if the agent's daily/monthly cap would be exceeded the
turn is skipped and a "heartbeat paused" notice is delivered instead of
silently spending — so a heartbeat can never become the idle-burn furnace.

Config (`[heartbeat]` / `AGENC_HEARTBEAT*`): `interval_seconds` (default 1800),
`active_hours` (e.g. `8-22`, local), `skip_when_busy`, `model` (utility model),
`target_channel`/`target_conversation` (or `none` to run without delivering),
and `agent` (the budget envelope this heartbeat draws from). Disabled by
default.

> Note: live heartbeat turns (and live channel turns generally) currently
> require the gateway's daemon-agent provisioning fix — see TODO task 34. The
> heartbeat scheduling, gating, budget enforcement, suppression, and delivery
> are complete and tested against a fake daemon client; the remaining piece is
> the shared gateway↔daemon session-agent bootstrap.

## Security model (non-negotiable)

- **Pairing by default.** An unknown DM sender gets a one-time, expiring
  pairing code and **no agent access** until it is redeemed. `dmPolicy` can be
  `pairing` (default), `allowlist`, `open`, or `disabled`.
- **`open` requires an explicit `"*"`.** Setting `dmPolicy: "open"` alone still
  denies; the allowlist must literally contain `"*"`. A lone config typo can't
  expose the agent.
- **Channel text is untrusted.** Inbound messages can never change permission
  mode, signer/wallet config, or tool policy. The **only** channel input with
  authority is an exact, single-use approval token (below). Every message a
  channel participant sends is **sanitized and framed** before it reaches the
  agent: forged `<system-reminder>` tags, hidden/zero-width/bidi control
  characters, and attempts to forge or close the wrapper are neutralized, and
  the text is wrapped in a `trust="external"` block with guidance that any
  embedded directive to escalate carries no authority. The agent still acts on
  the participant's actual request; only privilege-escalation attempts are
  inert. This is enforced by architecture too: the gateway hands `session.prompt`
  nothing but that framed string, so there is no channel path that carries a
  mode, config, or approval.
- **Approvals round-trip in-channel.** When a turn needs a permission (e.g.
  Bash), the gateway renders it and blocks on an exact reply — `approve <token>`
  or `deny <token>`. Free text containing the token does **not** authorize; a
  different sender replying with a leaked token does **not** authorize; timeout
  resolves to **deny** (fail closed).

## Configuration

`<AGENC_HOME>/gateway/config.json` (absent → fail-closed defaults):

```json
{
  "defaultAgent": "home",
  "channels": {
    "telegram": { "dmPolicy": "pairing", "allowlist": [] }
  },
  "bindings": [
    { "agent": "work", "channelId": "telegram", "peerId": "123456789" },
    { "agent": "team", "channelId": "telegram", "groupId": "-100987" }
  ]
}
```

**Binding resolution** is deterministic, most-specific-wins:
peer (exact sender) > group (exact conversation) > channel default > the
gateway `defaultAgent`. Two different agents never share a session, so bound
conversations stay isolated.

Malformed channel policies or bindings are dropped with a warning — never
coerced into something more permissive.

## Operating it

```bash
agenc gateway run [--stdio]              # start the gateway (Ctrl-C to stop)
agenc gateway status                     # channels, policies, bindings, paired counts
agenc gateway pairing list               # paired senders per channel
agenc gateway pairing revoke <ch> <peer> # remove a paired sender
```

Pairing state persists to `<AGENC_HOME>/gateway/pairing.json` (0600); session
mappings to `gateway/sessions.json`, so a gateway restart reattaches existing
conversations instead of forking their history.

## Writing a channel adapter

Implement `ChannelAdapter` (`runtime/src/gateway/types.ts`): `start` (register
the inbound callback), `stop`, and `send` (return the channel-native message
id; adapters that report `supportsEdit: true` get streaming coalesced into an
edited message, others get one message per completed turn). See
`StdioChannelAdapter` (line-oriented, no edit) and `TelegramChannelAdapter`
(long-poll, edit-in-place, transport injected for testing) for reference
shapes, then register it in `startGateway` (`runtime/src/gateway/run.js`).
