# Managed Connections in Core

Connections is opt-in agent session control on macOS, Linux, and Windows. It is
not an OS desktop, terminal, or filesystem sandbox. The existing standalone
gateway and mobile pairing remain separate surfaces.

## Browser access

The daemon owns browser pairing and outbound relay sockets. Authenticated local
clients use `remote.capabilities`, `remote.status`, `remote.start`, `remote.stop`,
`remote.pair.begin`, `remote.pair.refresh`, `remote.pair.cancel`, `remote.devices`,
`remote.pending`, `remote.approve`, and `remote.revoke`.

`remote.pair.begin` selects an absolute `workspacePath`, explicit `sessionIds`,
a `view` or `control` role, and optional `allowFiles` and `allowApprovals` flags.
Core maps an opaque workspace ID to that canonical path. A browser claiming the
code remains pending until the host approves its exact device ID. Pairing and
device grants are in memory: restarting Core requires fresh pairing and approval.

The browser receives a scoped, in-process Core connection, never the daemon
cookie, a general IPC endpoint, or the host account bearer. Its methods are:

- `session.list` and `session.transcript.v2` for approved sessions;
- `session.create` with only an optional title, for control grants;
- `message.send` with a stable client message ID and `ifBusy: "reject"`;
- `session.cancelTurn`;
- `remote.pendingApprovals`, `tool.approve` with `scope: "once"`, and `tool.deny`,
  only when the host enabled approvals;
- `files.list` and `files.read`, only when the host enabled file browsing.

New sessions use default permission prompts and no bypass or untrusted-hook
authority. Existing sessions in bypass, accept-edits, auto, or unknown permission
modes cannot receive remote prompts or approvals. Core rechecks this policy for
every remote prompt or approval. Agent tools still operate under the host's
ordinary permission policy; selecting a workspace does not create an OS sandbox.
Direct browser file reads are separately restricted to the canonical shared
root, excluding Core's private home, hidden configuration, common credential
files, symlinks, junctions, hard links, binary files, and files over 256 KiB.

Requests remain bounded while long turns run, so polling, cancellation, and
approval can proceed concurrently. Mutation request IDs cannot be replayed across
relay reconnects. The grant retains its most recent 4,096 mutation IDs and forgets
the oldest when full; a new explicit pairing resets the ledger. Read polling does
not consume that limit. Responses
exceeding the relay's 1 MiB envelope limit return `REMOTE_RESPONSE_LIMIT`; transcript
pagination is not implemented yet. Short-lived browser tickets reconnect normally.

Stopping or revoking closes sockets and timers synchronously and invalidates
pending pairing, approval, and reconnect work. Local account logout also stops
browser access. Backend revocation is attempted after the local boundary closes.

## Private Telegram agents (contract v2)

`telegram.capabilities` advertises `contractVersion: 2`, `multiAgent: true`, and
`accountLinking: "local-confirmation"`. Authenticated local clients manage up to
100 independent agents through:

- `telegram.agents.list` → `{ agents }` (never credentials).
- `telegram.agents.create` with `name`, `token`, `workspacePath`, and optional
  `instructions`; Telegram validates the credential, but no agent work starts.
- `telegram.agents.update` with `agentId` and changed profile fields. Updating
  stops the selected agent. Changing the Telegram identity requires relinking.
- `telegram.agents.pair.begin` with `agentId` returns `challengeId`, `url`,
  `qrDataUrl`, and `expiresAt`. A new call replaces the previous link.
- `telegram.agents.pair.confirm` with `agentId` and `challengeId` approves the
  exact account shown in `status.pairing.candidate` on the host.
- `telegram.agents.pair.cancel` invalidates the pending link/candidate.
- `telegram.agents.start`, `telegram.agents.stop`, and `telegram.agents.remove`
  each select one `agentId`. Confirmation does not automatically start work.

Create the Telegram identity with BotFather and paste its token locally. The
QR links to that identity using a random 256-bit `/start` payload, never the
credential. A link expires after five minutes. Only a fresh, private, unforwarded
message carrying the exact one-time nonce can nominate an account. The candidate
is frozen, polling stops, and local confirmation is still required. Neither a
scan nor a message can authorize itself. Challenges are memory-only and do not
survive cancel, refresh, removal, or Core restart.

Each agent has one exact owner account, one canonical workspace, its own native
credential entry, update cursor, Core session, and lifecycle. Two credentials for
the same Telegram identity cannot be registered as separate agents. Metadata in
`gateway/telegram-agents.json` contains token fingerprints but no credentials.
Metadata creation precedes native credential storage so a failed write cannot
leave an undiscoverable credential. Existing `owner-telegram.json` configuration
is migrated read-only as a stopped agent; its original native token remains a
fallback until explicitly replaced or removed. Unrelated credentials are preserved.

Agents accept plain chat, `/new`, `/status`, and `/cancel`, reject other users,
groups, channels, edited/forwarded messages, automated senders and stale updates,
and persist update progress before admitting work. Instructions are included in
the first prompt of each new agent session. New sessions use the restricted
browser-control factory and default permissions. Telegram cannot approve tools;
approval requests notify the owner to approve on the host. Replies are correlated
to the submitted turn; an older assistant answer is never used as its replacement.

Stop immediately aborts polling and closes that agent's scoped connection. It
does **not** cancel already accepted Core work; `/cancel` does that explicitly.
Remove also deletes that agent's credential and local configuration; it does not
delete the Telegram identity itself. List, stop, cancel-link and remove remain
responsive during pending credential validation. Agents do not auto-start after
Core restarts. macOS, Linux and Windows use the same service and their existing
native secure-storage adapters; Core must remain online.

The legacy `telegram.status/configure/start/stop/revoke` methods remain available
for older authenticated local clients. Legacy configuration still accepts an
explicit numeric owner, validates identity uniqueness, and never starts work.
Legacy no-argument stop stops all managed agents; modern Desktop shuts down only
the identities it started. The standalone Telegram gateway is unchanged.

After building Core, `node runtime/scripts/check-telegram-agents.mjs` starts an
owned temporary daemon and checks the authenticated v2 contract, an empty agent
catalog, unknown-agent errors and invalid input. It never supplies a Telegram
credential or makes a Telegram request, and tears down its private state.
Add `--corrupt-state` to verify that unreadable Telegram metadata disables only
Telegram management while Core remains healthy and preserves the original file.
