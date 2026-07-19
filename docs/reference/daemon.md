# Daemon reference

The local **app-server** control plane for AgenC **0.7.1**. One daemon per
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

Ready-wait timeout for clients that start the daemon
(`AGENC_DAEMON_READY_TIMEOUT_MS`):

| Client | Default |
| --- | --- |
| Published launcher (`packages/agenc`) | **2000** ms |
| Runtime daemon autostart / `agenc daemon` / SDK socket connect | **45000** ms |

```bash
AGENC_DAEMON_READY_TIMEOUT_MS=45000
```

Per-request RPC timeout (SDK / connect options; also used by some client paths):

```bash
AGENC_DAEMON_REQUEST_TIMEOUT_MS=30000   # optional; connect({ requestTimeoutMs })
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
- **Optional WebSocket transport** (remote control, SSH tunnels, VPS operators)
  defaults to loopback **`ws://127.0.0.1:7766/`** (see
  `AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT`). Env knobs:

  | Env | Role |
  | --- | --- |
  | `AGENC_DAEMON_WEBSOCKET_HOST` | Bind host (default loopback `127.0.0.1`) |
  | `AGENC_DAEMON_WEBSOCKET_PORT` | Port (default **7766**) |
  | `AGENC_DAEMON_WEBSOCKET_PATH` | Path (default `/`) |
  | `AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK` | Set `1` to allow a non-loopback host; otherwise non-loopback binds are **refused** |

  Prefer the Unix socket for local TUI/CLI; WebSocket is what remote/phone and
  tunnel docs mean by `ws://127.0.0.1:7766`. Implementation:
  `runtime/src/app-server/daemon-cli.ts` + `transport/`.
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
| `run.status` / `run.result` / `run.replay` / `run.evidence` / `run.cancel` | Durable run state, canonical journal replay/evidence, terminal result, and tree cancellation |
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
| `commandExec.start` / `write` / `resize` / `terminate` | Reserved PTY/command-exec protocol; direct starts currently fail closed |
| `health.ping` / `health.ready` / `health.stats` | Liveness and stats |
| `daemon.reload` | Reload configuration |
| `auth.login` / `auth.whoami` / `auth.logout` | Auth backend |

`session.list` is page-bounded: `limit` defaults to 50 and is capped at 100.
Pass the returned opaque `nextCursor` back with the same `agentId` filter; a
cursor is scoped to that filter and should not be persisted across daemon
upgrades. Persisted metadata is read with an indexed keyset page rather than a
full thread-history scan.

Run inspection searches discovered project state databases by `runId`:

- `run.status` returns lifecycle status plus aggregate admission step,
  reservation, allocation, fallback, and budget/hold totals. `durableRun`
  carries the compatibility `agent_runs` row when one exists; canonical-only
  v15 runs do not fabricate it. A `run_terminal_results` record is the
  strongest terminal-status source. An admission-only record stays nonterminal
  because admission state cannot prove that no future step will be created.
- `run.replay` pages the canonical append-only rollout journal through its
  rebuildable `thread_rollout_items` projection. `afterSequence` is exclusive,
  `limit` defaults to 100 and accepts 1 through 200, and every response includes
  `hasMore` plus `nextAfterSequence`. Canonical sequences are per-run and pages
  are contiguous. Retention, compaction, or an interior corruption-truncation
  range returns `gap.kind: "event_gap"` without moving the cursor past the
  missing range. A contiguous prefix can still advance `nextAfterSequence` to
  its last delivered event. A cursor beyond the durable tail returns
  `gap.kind: "cursor_ahead"` with the last available sequence. If a run has no
  canonical source, a pre-M4 execution-admission journal remains available as
  a compatibility reader; its sequence scope is explicitly
  `project_state_database`.
- `run.result` succeeds only for a durably terminal run. A v15 result returns
  `output.available: true` with exit code, stop reason, final message, usage,
  and the terminal snapshot sequence. A stopped-session operator review may
  later append leased audit evidence at a higher replay sequence without
  resuming execution or changing the result. A live or admission-only run returns
  `RUN_NOT_TERMINAL`; a missing run returns `RUN_NOT_FOUND`. A legacy terminal
  row with no canonical terminal payload returns `output.available: false`
  rather than fabricating output.
- `run.evidence` returns the same bounded journal page with SHA-256 hashes of
  the run state, admission summary, individual events, and page bundle.
  Canonical pages declare `workflowEvidenceIncluded: true`; completeness is
  `complete`, `partial`, `journal_gap`, or
  `admission_source_unavailable` for a missing compatibility source.

All four methods use the transport priority lane and bounded indexed queries.
Before reading, the daemon refreshes the requested run's rebuildable rollout
projection from its canonical active or archived JSONL source and recovers any
missing v15 effect or terminal projection. This repair writes indexes/state but
does not dispatch work, publish events, or rewrite the journal. If one run id
exists in multiple project databases, the methods fail with
`RUN_ID_AMBIGUOUS` instead of choosing silently.

The full persistence, replay, gap, effect, migration, and crash semantics are
documented in
[`../design/durable-runs-effects-events.md`](../design/durable-runs-effects-events.md).

The stdio and WebSocket transports give cancel operations plus bounded health,
status, attach, and session lookup RPCs a priority lane. They still wait for
`initialize`, but do not wait for a full `message.send` / `message.stream` turn
to finish. Ordinary order-dependent mutations remain FIFO per connection.

### Internal methods (TUI / privileged clients)

Include session rewind/compact, `session.setModel`,
`session.setPermissionMode`, hooks enable/disable, `session.applyConfig`, and
MCP reconnect/enable/disable. Full list:
`AGENC_DAEMON_INTERNAL_METHODS` in the protocol module.

`commandExec.start` is currently fail-closed with
`EXECUTION_ADMISSION_REQUIRED`. Although the underlying service retains its
explicit sandbox-policy contract for internal testing and future wiring, the
daemon RPC has no session-bound run/step identity and therefore cannot start a
process. Use an ordinary admitted session tool. `write`, `resize`, and
`terminate` remain available as cleanup/control operations for an already
owned process; they do not create execution. The initialize capability map
advertises `commandExec.start: false` while this guard is active.

`thread/realtime/start` is likewise fail-closed and advertised as unavailable
until realtime provider traffic has durable admission, bounded reservation,
and authoritative usage reconciliation. The remaining realtime methods stay
typed for protocol compatibility and cleanup of test-only/previously owned
sessions.

### Server → client notifications

Examples: `event.message_chunk`, `event.tool_request`,
`event.permission_request`, `event.user_input_request`,
`event.mcp_elicitation_request`, `event.agent_status`,
`event.session_event`, `commandExec.outputDelta`, realtime deltas.

`initialize.capabilities` can opt an authenticated connection into delivery
outside ordinary session attachment:

| Capability | Behavior |
| --- | --- |
| `portal.mobile.status.push.v1` | Global `event.agent_status` observer feed, deduplicated by physical connection and replayed from bounded session status buffers |
| `portal.ledger.solana.sign.v1` | Single-consumer `event.user_input_request.clientAction` delivery to the newest capable phone, with bounded live-session replay |

Generic SDK clients advertise no such capabilities by default. Conversation
messages and transcripts remain attachment-bound.

`tool.approve`, `tool.deny`, and `elicitation.respond` are preemptive dispatch
methods: they run outside the ordinary per-connection FIFO so they can unblock
its head request. They are not overload-exempt. `request.cancel` and other
control messages keep their existing overload-control semantics.

`tool.approve` accepts `allowAllToolsForSession: true` only with
`scope: "session"`. Core switches the owning live session to
`bypassPermissions` before releasing the pending request and rolls the mode
back if settlement fails or the request disappeared. Without the flag,
session scope remains the narrower equivalent-rule cache.

`event.user_input_request.clientAction` and
`elicitation.respond.clientResult` carry typed client-only interactions. The
current Ledger action is documented in
[`../security/mobile-ledger-transfer.md`](../security/mobile-ledger-transfer.md).

## What the daemon owns

- **Sessions** — create/attach, multi-turn transcripts, rollouts under the
  project `sessions/` tree, cancel/compact/rewind (internal methods).
- **Background agents** — `AgenCDaemonAgentManager` +
  `AgenCDelegateBackgroundAgentRunner` (per-run budget caps from
  `[agent.budget]`, not the cumulative ledger).
- **Permissions** — routes permission requests to the attached client; print
  mode / unattended embeds deny when no handler is registered.
- **Capability delivery** — global mobile status observers and single-consumer
  typed client actions, independent from transcript attachment.
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
