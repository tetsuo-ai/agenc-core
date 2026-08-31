# Channel gateway

The gateway turns messaging surfaces into conversations with agents owned by
your local daemon. It is a **daemon client**: it talks to the daemon only
through the embedding SDK (`@tetsuo-ai/agenc-sdk`), never runtime internals.
Channels are a client-side addition, not a runtime change.

**Shipped channels (0.17.0):** Telegram, Discord, Slack, WebChat, and stdio.
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
| `run` | Connect to the daemon (autostart if needed), use canonical `[gateway]` policy, start enabled channels. Runs until Ctrl-C. |
| `status` | Channels, DM policies, bindings, paired-sender counts |
| `pairing list` | Paired senders per channel |
| `pairing pending` | Pending pairing requests not yet approved |
| `pairing approve` | Approve a pending peer (`<channel> <peerId>`) |
| `pairing revoke` | Remove a paired sender |
| `install-service` | Install + start the always-on user service. Both systemd `agenc-gateway.service` and launchd `dev.agenc.gateway` read credentials from home-scoped native secure storage. |

`run` enables surfaces from flags **and** environment/config:

- `--stdio` — local line-oriented dev channel
- `--webchat` — loopback token-gated browser UI
- `--heartbeat` — force proactive ticks for this process (or enable via `[heartbeat]` / `AGENC_HEARTBEAT`)
- `--hooks` — force inbound `POST /hooks/agent` (or enable via `[gateway.hooks]`)
- Telegram when `AGENC_TELEGRAM_BOT_TOKEN` is set
- Discord when `AGENC_DISCORD_BOT_TOKEN` is set
- Slack when **both** `AGENC_SLACK_BOT_TOKEN` and `AGENC_SLACK_APP_TOKEN` are set

Channel tokens saved by onboarding belong to the native secure storage,
under the same `AGENC_HOME` identity as config and daemon state. Explicit
shell exports are supported for one-shot runs and win over stored values.
Gateway-only secrets are stripped from the environment passed to an
autostarted daemon so agent sessions cannot inherit bot or hook tokens.

A heartbeat-only or hooks-only run (no messaging channel) is valid. With no
channel, no heartbeat, and no hooks, `run` errors.

## Quick starts

```bash
# Fastest pipeline smoke (stdio pairing)
agenc gateway run --stdio

# Browser chat (prints loopback URL + token)
agenc gateway run --webchat

# Telegram (explicit env or the native secure storage)
AGENC_TELEGRAM_BOT_TOKEN=123:ABC agenc gateway run

# Always-on after onboarding
agenc onboard channel
agenc gateway install-service
```

## Channels

### stdio (dev)

`agenc gateway run --stdio` is the fastest way to exercise pairing, framing,
and approvals. Pairing codes are **host-only** (logs and
`agenc gateway pairing pending`). They are not printed as a redeemable line
in the channel. TTL is 10 minutes. Allowlist peer `local` (stdio) or `web`
(WebChat with `--webchat`) to skip pairing.

### WebChat

Serves a minimal browser chat from the gateway process.

- Binds **loopback (`127.0.0.1`)** and refuses a non-loopback host without an
  explicit override.
- Every request is gated by a shared token. The run command prints
  `http://127.0.0.1:<port>/?token=<token>`.
- Token is persisted in the native secure storage, or set
  `AGENC_WEBCHAT_TOKEN` for this run (minimum length 16).
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
# export for a one-shot run; onboarding stores it in the native secure storage
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
Public command menus are empty. Owner controls stay on configured owner/admin
chats. `/start` and `/stop` must not be advertised as public group commands.

**Group addressing.** Telegram default is `"all"` (every group message)
unless `AGENC_TELEGRAM_GROUP_ADDRESSING=mentions`. Discord and Slack default
`"mentions"` unless `..._GROUP_ADDRESSING=all`. Mentions-only mode:

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
for `message.im`, `message.channels`. Do not rely on `app_mention`: the Slack
adapter ignores it to avoid double-firing the same message.

## Heartbeat (proactive ticks) — live

`agenc gateway run --heartbeat` (or `[heartbeat] enabled = true` /
`AGENC_HEARTBEAT=on`) runs a periodic autonomous turn: each tick the agent
reads `HEARTBEAT.md` from the workspace and acts, replying `HEARTBEAT_OK`
(delivery suppressed) when there is nothing to do. Env wins over config:
`AGENC_HEARTBEAT=off` plus `--heartbeat` still does not start.

**Budget-bounded.** Each tick is a normal `session.prompt` through daemon
admission. Spend denial is reported as the normal daemon admission error.

Config (`[heartbeat]` / env):

| Key / env | Default | Notes |
|---|---|---|
| `enabled` / `AGENC_HEARTBEAT` | off | `on`/`1`/`true`/`yes` |
| `interval_seconds` / `AGENC_HEARTBEAT_INTERVAL` | `1800` | seconds between ticks |
| `active_hours` / `AGENC_HEARTBEAT_ACTIVE_HOURS` | always | e.g. `8-22` local |
| `target_channel` + `target_conversation` (TOML) / `AGENC_HEARTBEAT_TARGET` (env) | `none` | Env uses combined `channelId:conversationId` or `none`; TOML stores the split fields |

Heartbeat `enabled` is off by default until you opt in (onboarding Act 3 or
config). `skip_when_busy` defaults **true**: a tick is skipped while a session
is already running.

## Inbound webhooks (`--hooks`)

```bash
agenc gateway run --hooks
# or config.toml: [gateway.hooks] enabled = true
```

Serves loopback `POST /hooks/agent` (default port `8377`). Security:

- **Disabled by default.**
- Loopback bind; non-loopback host refused without explicit override.
- Bearer token in the `Authorization` header only — query-string tokens are
  rejected even if the header is also valid.
- Token from `AGENC_HOOKS_TOKEN` or the home-bound native secure storage.
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

The hooks handler waits for the full turn, then returns `202` `{ ok, sessionKey }`
(no `finalMessage`). Immediate-202-then-stream is not implemented. Without
`deliver`, wait for the turn and get `200` `{ ok, sessionKey, finalMessage, stopReason }`.
Body cap 64 KiB, message cap 32 KiB. Optional JSON fields `host`, `port`,
`allowNonLoopback` on the hooks config. Default port `8377`.

## Cron delivery

Delivery-routed cron jobs (`announceChannel` / `announceTo` / webhook on
CronCreate) persist as `deliver.{channel,to,webhook}` in
`.agenc/scheduled_tasks.json`. They run only while **`agenc gateway run`**
is up (`startCronDelivery`), not from a daemon restart alone. Isolated session
key `cron|default|<id>`. Permissions denied. Scan cap 5 minutes. Spend rides the same
budget envelope as other autonomous surfaces.

Webhook POST is **address-pinned**: the gateway resolves the host once, dials
that exact IP, and keeps the original hostname on `Host` / TLS SNI. http(s)
only; URL credentials, `localhost` / `*.localhost`, loopback, private,
link-local, CGNAT, reserved/docs/benchmark/multicast, and cloud-metadata
addresses are rejected (including IPv4-mapped and scoped IPv6 forms). Mixed
public+private DNS answers fail closed. Each redirect hop is re-resolved and
re-pinned (max 5; no scheme change; 15 s budget across DNS and hops).
`CronCreate` only checks the `http(s)` prefix; the pin runs at delivery.
Unlike session HTTP hooks, cron webhooks **do not** allow loopback, and
`[browser].allow_private_network` does not apply.

Full pin table, payload shape, and pitfalls:
[Cron delivery](reference/autonomy.md#cron-delivery-runtimesrcgatewaycron-deliveryts).

## Security model (non-negotiable)

- **Pairing by default.** An unknown sender (DMs **and** groups, unless
  Telegram owner `bypassAccess`) gets no agent access until paired. Codes are
  host-only, 10-minute TTL; see them with `agenc gateway pairing pending`.
  `approve` can pair a peer without the peer seeing a code. `dmPolicy`:
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
- **Approvals.** Discord, Slack, stdio, and WebChat can round-trip
  `approve <token>` / `deny <token>` (timeout 5 minutes is **deny**). Telegram
  always denies privileged tools and never renders those tokens. Free text
  containing the token does not authorize; a different sender with a leaked
  token does not authorize.

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
`SendUserMessage`. That answers normally without leaking approval prompts into chat;
privileged tools still pause and are denied by the gateway instead of
rendering `approve <token>` to public users. Override with
`AGENC_GATEWAY_AGENT_UNATTENDED_ALLOW` and
`AGENC_GATEWAY_AGENT_UNATTENDED_DENY` (comma-separated).

## Optional media and research routes

These use **server-side** credentials and never put those keys into model
prompts or autostarted daemon env.

### Generated media and X search (not installed)

`startGateway` does **not** install meme / voice / X-search features. Env flags
`AGENC_GATEWAY_MEME_ENABLED`, `AGENC_GATEWAY_VOICE_ENABLED`, and
`AGENC_GATEWAY_X_SEARCH_ENABLED` do not turn those routes on. Public Telegram
command menus are empty (`publicTelegramCommands: []`). Owner `/help` may still
list `/image`, `/meme`, `/voice`, `/song`; those commands are not live.

Use the coding-agent `ImagineImage` / `ImagineVideo` tools in a grok session
instead ([imagine.md](imagine.md)). Helius on-chain reads still install when
configured.

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

`<AGENC_HOME>/config.toml` is the sole persistent policy authority. An absent
`[gateway]` block uses fail-closed defaults:

```toml
config_version = 2

[gateway]
defaultAgent = "default"
bindings = [
  { agent = "work", channelId = "telegram", peerId = "123456789" },
  { agent = "team", channelId = "telegram", groupId = "-100987" },
]

[gateway.channels.telegram]
dmPolicy = "pairing"
allowlist = []

[gateway.channels.discord]
dmPolicy = "pairing"
allowlist = []

[gateway.channels.slack]
dmPolicy = "pairing"
allowlist = []

[gateway.hooks]
enabled = false
```

**Binding resolution** (most-specific wins): peer (exact sender) → group
(exact conversation) → channel default → gateway `defaultAgent`. Two agents
never share a session, so bound conversations stay isolated.

Malformed or unknown gateway policy fails the canonical config load. Nothing
is dropped or coerced into a more permissive shape.

## Operating state

```bash
agenc gateway status
agenc gateway pairing list
agenc gateway pairing revoke telegram 123456789
```

| Path | Mode | Role |
|---|---|---|
| `config.toml` `[gateway]` | 0600 | policies, bindings, hooks flag |
| Native secure storage | OS-managed | bot tokens and gateway bearer tokens |
| `gateway/pairing.json` | 0600 | paired senders |
| `gateway/sessions.json` | 0600 | channel → daemon session map |
| `gateway/control.json` | 0600 | Telegram owner/public state |
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
