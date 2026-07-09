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

Text replies can use Telegram Bot API Rich Messages (`sendRichMessage` and
`editMessageText` with `rich_message.markdown`) so headings, lists, links,
inline code, and Markdown tables render as native Telegram rich content. Because
some current Telegram clients still show unsupported-message banners for Rich
Messages in groups/forwards, the default is conservative:
`AGENC_TELEGRAM_RICH_MESSAGES=private` (Rich Messages in DMs, safe HTML in
groups). Set `AGENC_TELEGRAM_RICH_MESSAGES=all` to force Rich Messages
everywhere, or `off` to disable them completely. If a Bot API deployment or a
specific payload rejects Rich Messages, the gateway falls back to the legacy
safe HTML renderer; in that fallback, Markdown tables are escaped and rendered
as preformatted blocks. Native media captions still use the safe HTML renderer
because Telegram captions do not accept `rich_message`.

Telegram can also run with **owner controls**:

```bash
AGENC_TELEGRAM_BOT_TOKEN=123:ABC \
AGENC_TELEGRAM_OWNER_CLAIM_CODE=<random-one-time-code> \
  agenc gateway run
```

The first owner DMs `/owner <code>` to claim the bot. After that, owner
controls are private-DM controls:

- private DMs are owner-only; non-owner DMs are ignored silently;
- `/stop` pauses public group replies without stopping the process;
- `/start` turns public group replies back on;
- `/status` shows whether the public group is live or paused;
- group traffic bypasses pairing while public replies are on, so the bot works
  naturally in the public chat you added it to.

For fixed operators, set `AGENC_TELEGRAM_ADMIN_PEER_IDS=123,456`. Owner/control
state is stored at `<AGENC_HOME>/gateway/control.json` (0600). Telegram command
menus install public media commands in groups, and owner controls only for
configured owner/admin chats when the Bot API allows it. `/start` and `/stop`
must not be advertised as public group commands.

Optional generated media routes are available when the server-side xAI key and
feature flags are configured:

```bash
AGENC_GATEWAY_MEME_ENABLED=1
AGENC_GATEWAY_MEME_DAILY_LIMIT=20
AGENC_GATEWAY_VOICE_ENABLED=1
AGENC_GATEWAY_VOICE_DAILY_LIMIT=20
```

The gateway then handles explicit shortcuts such as `/image <idea>`,
`image: <idea>`, `/meme <idea>`, `meme: <idea>`, `/voice <line>`,
`voice: <line>`, `/song <idea>`, and `song: <idea>` before the prompt reaches
the agent. It also detects clear natural-language media requests like
`make an image of ...`, `haz una imagen de ...`, `generate a 10 second song
with female voice about ...`, or `haz un audio con voz masculina diciendo ...`.
Normal questions such as `explain this image` or `what is a song?` still route
to the agent. Image routes generate a native Telegram photo through the xAI
image API; voice routes generate a native Telegram audio file through the xAI
TTS API. Both enforce local soft daily caps.

### Read-only Solana research

The gateway can enrich crypto questions with bounded, server-side Helius reads.
The credential stays outside the model process context: production should use
an absolute `0600` regular file, not a key pasted into prompts, config JSON, or
client-side code.

```bash
AGENC_GATEWAY_HELIUS_ENABLED=1
AGENC_GATEWAY_HELIUS_KEY_FILE=/run/credentials/agenc-helius
AGENC_GATEWAY_HELIUS_DAILY_LIMIT=500
AGENC_GATEWAY_HELIUS_PER_PEER_LIMIT=4
AGENC_GATEWAY_HELIUS_REQUESTS_PER_SECOND=8
AGENC_GATEWAY_HELIUS_MAX_TOKEN_ACCOUNTS=50000
AGENC_GATEWAY_HELIUS_TOKEN_ALIASES=agenc=<official-mint>,usdc=<official-mint>
```

`AGENC_GATEWAY_HELIUS_API_KEY` exists for local development, but the key-file
path is the production route. The gateway refuses symlinks, non-regular files,
group/world-readable permissions, malformed keys, arbitrary RPC methods, and
arbitrary upstream URLs. Configure IP restrictions for the production key in
the Helius dashboard as a second boundary.

The natural-language read surface currently covers:

- token holder snapshots and top-10/top-25/top-50 concentration;
- estimated top-10/top-25/top-50 holder age with observed-history coverage;
- token supply/metadata summaries;
- wallet SOL balance, token accounts, and recent normalized transfers;
- bounded transaction summaries without raw logs or arbitrary instruction text;
- Solana mainnet health, finalized slot, block height, and epoch.

Unknown tickers are never guessed; the bot asks for an exact mint or verified
explorer link. Configured aliases are explicit operator mappings. Reads use a
short shared cache, per-peer throttling, a persistent daily analysis budget,
timeouts, bounded retries, bounded response sizes, and a fixed method surface.
The API key is used only in the private outbound Helius request. Prompts,
Telegram replies, and logs receive normalized results and safe error codes.
Gateway-only credentials, including the Helius key and key-file path, are
removed from the environment passed to an autostarted AgenC daemon, so agent
sessions cannot discover them through inherited process configuration.

The holder-age result is deliberately labeled an estimate: it uses the current
top owner snapshot and each owner's earliest inbound transfer for that mint.
It is not FIFO lot accounting, and Helius `getTransfersByAddress` currently has
one-year retention, so the answer includes observed coverage instead of
inventing ages for holders with no returned history. Exact top-50 owner ranking
requires a complete bounded token-account scan. If a token exceeds that cap,
the gateway falls back to Solana's exact top-20 token-account method and
withholds top-25/top-50 metrics instead of presenting a partial page as global.
If the upstream index rejects both bounded paths for an exceptionally large
mint, holder ranking is reported as unavailable; metadata and supply can still
be returned without a fabricated concentration value.

Telegram gateway agents are spawned with a tiny unattended tool allowlist by
default: `SendUserMessage` and `Brief`. That lets the bot answer normally
without leaking approval prompts into chat, while privileged tools still pause
and are denied by the Telegram gateway instead of rendering `approve <token>`
to public users. Operators may override the list with
`AGENC_GATEWAY_AGENT_UNATTENDED_ALLOW` and
`AGENC_GATEWAY_AGENT_UNATTENDED_DENY`.

For group chats, set `AGENC_TELEGRAM_GROUP_ADDRESSING=mentions` and
`AGENC_TELEGRAM_BOT_USERNAME=<bot_username>` to respond only when someone
mentions `@bot_username`, replies to the bot, or uses a slash command. Telegram
must have BotFather privacy mode disabled (`/setprivacy` → Disable) for normal
`@bot_username hi` mention messages to be delivered to the bot; otherwise only
slash commands and replies are delivered by Telegram.
When someone replies to another user's message and mentions the bot, the
gateway forwards both the user's message and the replied-to message as context,
so the agent can answer the actual thread instead of seeing only the mention.

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
- **Telegram owner controls override public/private routing.** When configured,
  non-owner private DMs are blocked before they reach pairing or the agent.
  Public group messages can reach the agent only while the owner-controlled
  public state is on; `/stop` pauses them process-wide, but owner controls are
  accepted only from the owner's private DM.
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
