# Daemon reference

The local **app-server** control plane for AgenC **0.3.0**. One daemon per
`AGENC_HOME`. Clients (TUI, print CLI, gateway, remote, SDK, background
agents) attach over a local socket and speak JSON-RPC.

Architecture map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Embedding API:
[`../sdk.md`](../sdk.md).

## Process ownership

| Piece | Package / path | Role |
| --- | --- | --- |
| Launcher | `packages/agenc` (`@tetsuo-ai/agenc`) | Installs `agenc`, ensures runtime tarball, optional daemon autostart, execs runtime |
| Daemon | `runtime/src/app-server` | Owns sessions, agents, tools, permissions, health, recovery |
| Runtime CLI | `runtime/bin/agenc` | Subcommands including `daemon start|stop|status|reload|restart` |

Autostart is **on by default**. Disable with:

```bash
AGENC_DAEMON_AUTOSTART=0
```

Ready-wait timeout for clients that start the daemon:

```bash
AGENC_DAEMON_READY_TIMEOUT_MS=2000   # default 2000
```

Detached daemon V8 heap cap (MB):

```bash
AGENC_DAEMON_MAX_OLD_SPACE_MB=4096   # default 4096
```

## CLI

```bash
agenc daemon status
agenc daemon start                 # detached
agenc daemon start --foreground    # current process (systemd/launchd/docker)
agenc daemon reload                # in-place config reload
agenc daemon restart
agenc daemon stop
```

Packaging units under `packaging/` (systemd, launchd, Windows service) run
`agenc daemon start --foreground`.

## Files under `AGENC_HOME` (default `~/.agenc`)

| File | Mode / notes |
| --- | --- |
| `daemon.sock` | Unix domain socket path clients connect to |
| `daemon.cookie` | Shared secret; cookie auth for local clients |
| `daemon.pid` | Detached process id |
| `daemon.log` | Size-capped log sink |
| `daemon-snapshot.json` | Lifecycle / recovery snapshot |
| runtime-info files | Version/path metadata for attach and doctor |

Override home:

```bash
export AGENC_HOME=/var/lib/agenc
```

## Transports & auth

- **Default transport:** Unix socket at `$AGENC_HOME/daemon.sock`.
- **Auth:** cookie file `$AGENC_HOME/daemon.cookie` (ensured on start; private
  socket owner identity + peer UID checks on supported platforms).
- **Optional WebSocket transport** is implemented in
  `runtime/src/app-server/transport/` for non-Unix topologies; prefer the
  Unix socket for local use.
- Config block `[daemon]` defaults: `transport = "unix"`, `autostart = true`
  (`runtime/src/config/schema.ts`).

The embedding SDK (`@tetsuo-ai/agenc-sdk`) attaches the same way:

```js
import { connect } from "@tetsuo-ai/agenc-sdk";
const client = await connect(); // socket + cookie under AGENC_HOME
```

## Protocol

- Envelope: **JSON-RPC 2.0** over newline-delimited messages.
- Protocol version constant: **`1.0.0`**
  (`AGENC_DAEMON_PROTOCOL_VERSION` in `runtime/src/app-server/protocol/index.ts`).
- Clients send `initialize` with the protocol version; mismatch → error.

### Public methods (`AGENC_DAEMON_METHODS`)

| Method | Purpose |
| --- | --- |
| `initialize` | Handshake + capability advertisement |
| `request.cancel` | Cancel an in-flight request |
| `agent.create` / `agent.list` / `agent.attach` / `agent.stop` / `agent.logs` | Background agents |
| `session.create` / `session.list` / `session.attach` / `session.detach` | Session lifecycle |
| `session.terminate` / `session.clear` / `session.snapshot` / `session.transcript` | Session control |
| `session.cancelTurn` | Abort current turn |
| `session.mcp.addServer` | Attach MCP server to a session |
| `message.send` / `message.stream` | Prompt turns |
| `thread/realtime/*` | Realtime voice/thread methods |
| `tool.approve` / `tool.deny` / `tool.cancel` | Permission settlement |
| `elicitation.respond` | User-input / MCP elicitation reply |
| `permission.list` | List pending / granted permissions |
| `fs.fuzzy_search` | Workspace fuzzy file search |
| `commandExec.start` / `write` / `resize` / `terminate` | PTY/command exec |
| `health.ping` / `health.ready` / `health.stats` | Liveness and stats |
| `daemon.reload` | Reload configuration |
| `auth.login` / `auth.whoami` / `auth.logout` | Auth backend |

### Internal methods (TUI / privileged clients)

Include session rewind/compact, `session.setModel`,
`session.setPermissionMode`, hooks enable/disable, `session.applyConfig`, and
MCP reconnect/enable/disable. Full list:
`AGENC_DAEMON_INTERNAL_METHODS` in the protocol module.

### Server → client notifications

Examples: `event.message_chunk`, `event.tool_request`,
`event.permission_request`, `event.user_input_request`,
`event.mcp_elicitation_request`, `event.agent_status`,
`event.session_event`, `commandExec.outputDelta`, realtime deltas.

## What the daemon owns

- **Sessions** — create/attach, multi-turn transcripts, rollouts under the
  project `sessions/` tree, cancel/compact/rewind (internal methods).
- **Background agents** — `AgenCDaemonAgentManager` +
  `AgenCDelegateBackgroundAgentRunner` (per-run budget caps from
  `[agent.budget]`, not the cumulative ledger).
- **Permissions** — routes permission requests to the attached client; print
  mode / unattended embeds deny when no handler is registered.
- **Command exec / PTY** — `commandExec.*` for interactive shell surfaces.
- **Health & recovery** — `health.*`, startup recovery of in-flight tool
  calls and agent runs (`runtime/src/state/recovery.ts`), pruning policies.
- **Auth / key vending** — auth handlers + provider-key vending for managed
  backends (`provider-key-vending.ts`).
- **Realtime** — thread realtime RPC + WebSocket connector.

The channel **gateway does not run inside the daemon process**. It is a
separate client (`agenc gateway run`) that connects via the SDK. Heartbeat,
cron delivery, and hooks HTTP start from that gateway process and still
spend against daemon-owned sessions.

## Lifecycle sketch

1. `agenc daemon start` (or launcher autostart) ensures home, cookie, and
   socket; writes `daemon.pid`.
2. Dispatcher advertises method capabilities on `initialize`.
3. Clients open the socket, authenticate, create or attach sessions.
4. `daemon.reload` reloads config without tearing down the process.
5. `daemon stop` / signals run the cleanup registry and remove pid/socket
   ownership cleanly.

## Related CLI

```bash
agenc doctor           # install + daemon + provider diagnostics
agenc security audit   # exposure / permission posture
agenc state …          # project state inspection
agenc budget status    # cumulative autonomy ledger (not daemon-internal only)
```

## Source map

| Concern | Path |
| --- | --- |
| CLI | `runtime/src/app-server/daemon-cli.ts` |
| JSON-RPC dispatch | `runtime/src/app-server/daemon-dispatcher.ts` |
| Protocol constants | `runtime/src/app-server/protocol/index.ts` |
| Session lifecycle | `runtime/src/app-server/session-lifecycle.ts` |
| Agent lifecycle | `runtime/src/app-server/agent-lifecycle.ts` |
| Background runs | `runtime/src/app-server/background-agent-runner.ts` |
| Unix socket | `runtime/src/app-server/transport/unix-socket.ts` |
| Cookie auth | `runtime/src/app-server/transport/auth.ts` |
| Health | `runtime/src/app-server/health.ts` |
| Launcher autostart | `packages/agenc/src/launcher.mjs` |
| SDK connect | `packages/agenc-sdk/src/socket.ts` |
