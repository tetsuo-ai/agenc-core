# Channel gateway

The gateway turns messaging surfaces (Telegram, Discord, WebChat, …) into
conversations with agents owned by your local daemon. It is a **daemon
client** — it talks to the daemon only through the embedding SDK
(`@tetsuo-ai/agenc-sdk`), never runtime internals — so channels are a
client-side addition, not a runtime change.

This page documents the **core** (task 6). The first real channel adapter
(Telegram) and the `agenc gateway run` daemon loop arrive next; today the core
is exercised by the in-memory adapter in tests, and the pairing/status surface
is operable via `agenc gateway`.

## Security model (non-negotiable)

- **Pairing by default.** An unknown DM sender gets a one-time, expiring
  pairing code and **no agent access** until it is redeemed. `dmPolicy` can be
  `pairing` (default), `allowlist`, `open`, or `disabled`.
- **`open` requires an explicit `"*"`.** Setting `dmPolicy: "open"` alone still
  denies; the allowlist must literally contain `"*"`. A lone config typo can't
  expose the agent.
- **Channel text is untrusted.** Inbound messages can never change permission
  mode, signer/wallet config, or tool policy. The **only** channel input with
  authority is an exact, single-use approval token (below).
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
`InMemoryChannelAdapter` for the reference shape.
