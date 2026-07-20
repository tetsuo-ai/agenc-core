# Channel gateway

The gateway turns messaging surfaces into conversations with agents owned by
your local daemon. It is a **daemon client**: it talks to the daemon only
through the embedding SDK (`@tetsuo-ai/agenc-sdk`), never runtime internals.
Channels are a client-side addition, not a runtime change.

**Shipped channels (0.7.2):** Telegram, Discord, Slack, WebChat, and stdio.
Signal, WhatsApp, and email **channels** are **not** shipped. (The LIVE
**Browser** tool is a coding-agent capability, not a gateway channel — see
[browser.md](browser.md).)

Related: [quickstart](quickstart.md) · [onboarding](onboarding.md) ·
[remote control](remote-control.md) · [VPS deploy](deploy/vps.md) ·
[managed OpenRouter](managed-openrouter.md).

## CLI

```bash
agenc gateway run [--stdio] [--webchat] [--heartbeat] [--hooks]
agenc gateway status [--json]
agenc gateway pairing list [--json]
agenc gateway pairing pending [--json]
agenc gateway pairing approve <channel> <peerId>
agenc gateway pairing revoke <channel> <peerId>
agenc gateway install-service
```

| Command | Purpose |
|---|---|
| `run` | Connect to the daemon (autostart if needed), load `gateway/config.json`, start enabled channels. Runs until Ctrl-C. |
| `status` | Channels, DM policies, bindings, paired-sender counts |
| `pairing list` | Paired senders per channel |
| `pairing pending` | Pending pairing requests not yet approved |
| `pairing approve` | Approve a pending peer (`<channel> <peerId>`) |
| `pairing revoke` | Remove a paired sender |
| `install-service` | Install + start the always-on user service (systemd on Linux, launchd on macOS); unit reads `gateway/env` |

`run` enables surfaces from flags **and** environment/config:

- `--stdio` — local line-oriented dev channel
- `--webchat` — loopback token-gated browser UI
- `--heartbeat` — force proactive ticks for this process (or enable via `[heartbeat]` / `AGENC_HEARTBEAT`)
- `--hooks` — force inbound `POST /hooks/agent` (or enable via gateway config `hooks.enabled`)
- Telegram when `AGENC_TELEGRAM_BOT_TOKEN` is set
- Discord when `AGENC_DISCORD_BOT_TOKEN` is set
- Slack when **both** `AGENC_SLACK_BOT_TOKEN` and `AGENC_SLACK_APP_TOKEN` are set

Channel tokens belong in `<AGENC_HOME>/gateway/env` (mode `0600`), not in
config JSON. `agenc gateway run` and `install-service` load that file;
explicit shell exports still win. Gateway-only secrets are stripped from the
environment passed to an autostarted daemon so agent sessions cannot inherit
bot tokens or hook tokens.

A heartbeat-only or hooks-only run (no messaging channel) is valid. With no
channel, no heartbeat, and no hooks, `run` errors.

## Quick starts

```bash
# Fastest pipeline smoke (stdio pairing)
agenc gateway run --stdio

# Browser chat (prints loopback URL + token)
agenc gateway run --webchat

# Telegram (token from env or gateway/env)
AGENC_TELEGRAM_BOT_TOKEN=123:ABC agenc gateway run

# Always-on after onboarding
agenc onboard channel
agenc gateway install-service
```

## Channels

### stdio (dev)

`agenc gateway run --stdio` is the fastest way to exercise pairing, framing,
and approvals. On the first line without an allowlist entry you get a pairing
code; confirm with `agenc gateway pairing list`, reply with the code in the
channel, or allowlist peer `local` in config to skip pairing.

### WebChat

Serves a minimal browser chat from the gateway process.

- Binds **loopback (`127.0.0.1`)** and refuses a non-loopback host without an
  explicit override.
- Every request is gated by a shared token. The run command prints
  `http://127.0.0.1:<port>/?token=<token>`.
- Token is persisted at `gateway/webchat-token` (`0600`), or set
  `AGENC_WEBCHAT_TOKEN` (min length 16).
- The web sender is allowlisted by default (no pairing with your own browser
  after presenting the token).
- Streaming replies update in place over SSE; approval requests render
  Approve/Deny controls that still settle only through the exact token
  round-trip.

To reach WebChat from another device, prefer a tailnet or SSH tunnel to the
loopback port — not a non-loopback bind.

### Telegram

Official Bot API only (long-poll; no inbound listener, no reverse-engineered
client). Create a bot with @BotFather, store the token:

```bash
# in <AGENC_HOME>/gateway/env (0600), or export for a one-shot run
AGENC_TELEGRAM_BOT_TOKEN=123:ABC
```

Streaming replies edit one message in place.

**Rich Messages.** Text can use Bot API Rich Messages
(`rich_message.markdown`) so headings, lists, links, code, and tables render
natively. Default is conservative:

| `AGENC_TELEGRAM_RICH_MESSAGES` | Behavior |
|---|---|
| `private` (default) | Rich Messages in DMs; safe HTML in groups |
| `all` | Rich Messages everywhere |
| `off` | Safe HTML only |

If a payload or Bot API deployment rejects Rich Messages, the gateway falls
back to safe HTML (tables become preformatted blocks). Media captions always
use safe HTML (captions do not accept `rich_message`).

**Owner controls.** Optional private-DM control plane:

```bash
AGENC_TELEGRAM_BOT_TOKEN=123:ABC
AGENC_TELEGRAM_OWNER_CLAIM_CODE=<random-one-time-code>
# and/or fixed operators:
AGENC_TELEGRAM_ADMIN_PEER_IDS=123,456
```

The first owner DMs `/owner <code>` to claim the bot. After that:

- private DMs are owner-only; non-owner DMs are ignored;
- `/stop` pauses public group replies without stopping the process;
- `/start` turns public group replies back on;
- `/status` shows live vs paused;
- group traffic bypasses pairing while public replies are on.

Owner/control state lives at `<AGENC_HOME>/gateway/control.json` (`0600`).
Command menus install public media commands in groups; owner controls only on
configured owner/admin chats. `/start` and `/stop` must not be advertised as
public group commands.

**Group addressing.** Mentions-only mode:

```bash
AGENC_TELEGRAM_GROUP_ADDRESSING=mentions
AGENC_TELEGRAM_BOT_USERNAME=<bot_username>
```

The bot then answers when someone mentions `@bot_username`, replies to the
bot, or uses a slash command. BotFather privacy mode must be disabled
(`/setprivacy` → Disable) for normal `@bot hi` mentions; after changing
privacy, remove and re-add the bot (or promote it to admin). When someone
replies to another message and mentions the bot, the gateway forwards both
the user message and the replied-to message as context.

### Discord

Official Gateway WebSocket + REST — **no inbound listener**.

```bash
AGENC_DISCORD_BOT_TOKEN=<bot-token>
# default group addressing is mentions-only; set "all" to hear every message
AGENC_DISCORD_GROUP_ADDRESSING=mentions   # or all
```

Enable the **MESSAGE CONTENT** privileged intent on the Discord developer
portal Bot tab, or the bot receives empty messages. Invite with the `bot`
OAuth2 scope.

### Slack

**Socket Mode** (outbound WebSocket) + Web API — no public URL / inbound
listener. **Both** tokens are required:

```bash
AGENC_SLACK_BOT_TOKEN=xoxb-...    # bot token (Web API)
AGENC_SLACK_APP_TOKEN=xapp-...    # app-level token (Socket Mode, connections:write)
AGENC_SLACK_GROUP_ADDRESSING=mentions   # or all
```

If only one of the two tokens is set, the channel does not start and the
gateway logs a warning.

Typical app setup: enable Socket Mode; bot scopes `chat:write`,
`app_mentions:read`, `im:history`, `channels:history`; event subscriptions
for `message.im`, `message.channels`, `app_mention`.

## Heartbeat (proactive ticks) — live

`agenc gateway run --heartbeat` (or `[heartbeat] enabled = true` /
`AGENC_HEARTBEAT=on`) runs a periodic autonomous turn: each tick the agent
reads `HEARTBEAT.md` from the workspace and acts, replying `HEARTBEAT_OK`
(delivery suppressed) when there is nothing to do.

**Budget-bounded.** Every tick is admitted pre-flight against the agent's
daily/monthly spend envelope. If the cap would be exceeded, the turn is
skipped and a "heartbeat paused" notice is delivered instead of silently
spending — a heartbeat can never become an idle-burn furnace.

Config (`[heartbeat]` / env):

| Key / env | Default | Notes |
|---|---|---|
| `enabled` / `AGENC_HEARTBEAT` | off | `on`/`1`/`true`/`yes` |
| `interval_seconds` / `AGENC_HEARTBEAT_INTERVAL` | `1800` | seconds between ticks |
| `active_hours` / `AGENC_HEARTBEAT_ACTIVE_HOURS` | always | e.g. `8-22` local |
| `model` / `AGENC_HEARTBEAT_MODEL` | — | optional utility model |
| `target_channel` + `target_conversation` (TOML) / `AGENC_HEARTBEAT_TARGET` (env) | `none` | Env uses combined `channelId:conversationId` or `none`; TOML stores the split fields |
| `agent` / `AGENC_HEARTBEAT_AGENT` | `default` | budget envelope + session |

Also: `skip_when_busy`. Disabled by default until you opt in (onboarding Act 3
or config).

## Inbound webhooks (`--hooks`)

```bash
agenc gateway run --hooks
# or gateway/config.json: { "hooks": { "enabled": true } }
```

Serves loopback `POST /hooks/agent` (default port `8377`). Security:

- **Disabled by default.**
- Loopback bind; non-loopback host refused without explicit override.
- Bearer token in the `Authorization` header only — query-string tokens are
  rejected even if the header is also valid.
- Token from `AGENC_HOOKS_TOKEN` or persisted `gateway/hooks-token` (`0600`).
- Payload `message` is sanitized and framed like channel text; hook turns
  deny permission requests (autonomous).
- Every request passes the budget envelope; refusal is HTTP 429, never silent
  spend. `agenc security audit` flags hooks enabled without a token.

Request shape:

```json
{
  "message": "deploy finished — summarize failures",
  "name": "ci",
  "agent": "default",
  "sessionKey": "deploys",
  "deliver": { "channel": "telegram", "to": "<chat-id>" }
}
```

With `deliver`: `202` immediately, result streams to the channel. Without:
wait for the turn, `200` with `{ ok, sessionKey, finalMessage, stopReason }`.

## Cron delivery

Delivery-routed cron jobs (`announceChannel` / webhook on CronCreate) run in
isolated gateway sessions and post results to a channel or webhook. Jobs
re-arm on daemon restart. Spend rides the same budget envelope as other
autonomous surfaces.

## Security model (non-negotiable)

- **Pairing by default.** An unknown DM sender gets a one-time, expiring
  pairing code and **no agent access** until it is redeemed. `dmPolicy`:
  `pairing` (default), `allowlist`, `open`, or `disabled`.
- **`open` requires an explicit `"*"`.** `dmPolicy: "open"` alone still
  denies; the allowlist must literally contain `"*"`.
- **Telegram owner controls override public/private routing** when configured
  (see above).
- **Channel text is untrusted.** Inbound messages cannot change permission
  mode, signer/wallet config, or tool policy. The **only** channel input with
  authority is an exact, single-use approval token. Every participant message
  is sanitized and framed (`trust="external"`) before `session.prompt`: forged
  `<system-reminder>` tags, zero-width/bidi controls, and wrapper-break
  attempts are neutralized. Privilege-escalation directives in chat text are
  inert by architecture, not by prompt hope.
- **Approvals round-trip in-channel.** When a turn needs permission, the
  gateway renders it and blocks on exact `approve <token>` / `deny <token>`.
  Free text containing the token does not authorize; a different sender with
  a leaked token does not authorize; timeout is **deny**.

### Public answer context (Telegram answer-only)

Injected public product context for answer-only Telegram turns lives in code
as `AGENC_TELEGRAM_ANSWER_CONTEXT` in
[`runtime/src/gateway/untrusted.ts`](../runtime/src/gateway/untrusted.ts).
That constant is the **single source of truth** for what public facts the
channel may treat as known AgenC context. Do not maintain a parallel markdown
copy of the same text — edit the TypeScript constant when product facts
change.

### Unattended tool policy

Gateway agents default to a tiny unattended allowlist: `SendUserMessage` and
`Brief`. That answers normally without leaking approval prompts into chat;
privileged tools still pause and are denied by the gateway instead of
rendering `approve <token>` to public users. Override with
`AGENC_GATEWAY_AGENT_UNATTENDED_ALLOW` and
`AGENC_GATEWAY_AGENT_UNATTENDED_DENY` (comma-separated).

## Optional media and research routes

These use **server-side** credentials and never put those keys into model
prompts or autostarted daemon env.

### Generated media (xAI)

```bash
AGENC_GATEWAY_MEME_ENABLED=1
AGENC_GATEWAY_MEME_DAILY_LIMIT=20
AGENC_GATEWAY_VOICE_ENABLED=1
AGENC_GATEWAY_VOICE_DAILY_LIMIT=20
# Grok credentials: OAuth from /grok-login wins; else XAI_API_KEY / GROK_API_KEY
```

Shortcuts and clear natural-language requests (`/image`, `/meme`, `/voice`,
`/song`, `make an image of …`, etc.) are handled before the prompt reaches the
agent. Normal questions (`explain this image`) still go to the agent. Soft
daily caps are local.

### Read-only X research

```bash
AGENC_GATEWAY_X_SEARCH_ENABLED=1
AGENC_GATEWAY_X_SEARCH_MODEL=grok-4.5
AGENC_GATEWAY_X_SEARCH_DAILY_LIMIT=100
AGENC_GATEWAY_X_SEARCH_PER_PEER_LIMIT=4
AGENC_GATEWAY_X_SEARCH_TIMEOUT_MS=90000
```

Uses xAI's hosted `x_search` only — no X write tools, no X Developer OAuth.
Query and X content are untrusted data; citations require structured
`x.com`/`twitter.com` evidence; `store: false` on Responses API.

### Read-only Solana (Helius)

```bash
AGENC_GATEWAY_HELIUS_ENABLED=1
AGENC_GATEWAY_HELIUS_KEY_FILE=/run/credentials/agenc-helius   # production
# AGENC_GATEWAY_HELIUS_API_KEY=...                           # local only
AGENC_GATEWAY_HELIUS_TOKEN_ALIASES=agenc=5yC9BM8KUsJTPbWPLfA2N8qH1s9V8DQ3Vcw1G6Jdpump
```

Key-file path is the production route (regular file, `0600`, no symlink).
Bounded holder/buy/wallet/network reads; unknown tickers are never guessed.

## Configuration

`<AGENC_HOME>/gateway/config.json` (absent → fail-closed defaults):

```json
{
  "defaultAgent": "home",
  "channels": {
    "telegram": { "dmPolicy": "pairing", "allowlist": [] },
    "discord": { "dmPolicy": "pairing", "allowlist": [] },
    "slack": { "dmPolicy": "pairing", "allowlist": [] }
  },
  "bindings": [
    { "agent": "work", "channelId": "telegram", "peerId": "123456789" },
    { "agent": "team", "channelId": "telegram", "groupId": "-100987" }
  ],
  "hooks": { "enabled": false }
}
```

**Binding resolution** (most-specific wins): peer (exact sender) → group
(exact conversation) → channel default → gateway `defaultAgent`. Two agents
never share a session, so bound conversations stay isolated.

Malformed channel policies or bindings are dropped with a warning — never
coerced into something more permissive.

## Operating state

```bash
agenc gateway status
agenc gateway pairing list
agenc gateway pairing revoke telegram 123456789
```

| Path | Mode | Role |
|---|---|---|
| `gateway/config.json` | 0600 | policies, bindings, hooks flag |
| `gateway/env` | 0600 | bot tokens and channel secrets |
| `gateway/pairing.json` | 0600 | paired senders |
| `gateway/sessions.json` | 0600 | channel → daemon session map |
| `gateway/control.json` | 0600 | Telegram owner/public state |
| `gateway/webchat-token` | 0600 | WebChat shared token |
| `gateway/hooks-token` | 0600 | hooks bearer |
| `gateway/conversation-recovery.json` | 0600 | bounded recovery journal |

Session mappings reattach conversations after gateway restart; the daemon
session remains the source of truth for history. The recovery journal
(sanitized channel text + final replies only; six successful turns per
conversation, 24h TTL by default) is replayed only when a daemon session
cannot be reattached. It never stores server evidence, env values, signer
data, or API credentials.

## Writing a channel adapter

Implement `ChannelAdapter` (`runtime/src/gateway/types.ts`): `start` (register
inbound callback), `stop`, and `send` (return the channel-native message id;
`supportsEdit: true` gets streaming edits). Reference adapters:
`StdioChannelAdapter`, `TelegramChannelAdapter`, `DiscordChannelAdapter`,
`SlackChannelAdapter`, `WebChatChannelAdapter`. Register in `startGateway`
(`runtime/src/gateway/run.ts`).
