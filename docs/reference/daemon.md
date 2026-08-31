# Daemon reference

The local **app-server** control plane for AgenC **0.17.0**. One daemon per
`AGENC_HOME`. Clients (TUI, print CLI, gateway, remote, SDK, background
agents) attach over a local socket and speak JSON-RPC.

Architecture map: [`../ARCHITECTURE.md`](../ARCHITECTURE.md). Embedding API:
[`../sdk.md`](../sdk.md).

## Process ownership

| Piece       | Package / path                        | Role                                                                                |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| Launcher    | `packages/agenc` (`@tetsuo-ai/agenc`) | Installs `agenc`, ensures runtime tarball, optional daemon autostart, execs runtime |
| Daemon      | `runtime/src/app-server`              | Owns sessions, agents, tools, permissions, health, recovery                         |
| Runtime CLI | `runtime/bin/agenc`                   | Daemon subcommands for start, stop, status, reload, and restart                     |

Autostart is **on by default**. Disable with:

```bash
AGENC_DAEMON_AUTOSTART=0
```

If autostart has to replace a running daemon (legacy process with no instance
identity, or a build-identity skew), it re-enters the start cycle at most
**3** times (`AGENC_DAEMON_AUTOSTART_MAX_RESTART_CYCLES` in
`runtime/src/app-server/daemon-autostart.ts`). The first restart is immediate.
Further restarts wait 250 ms, then 1 s, then 4 s. After the cap it throws
`AgenCDaemonAutostartError` with the repeating reason. In a TTY the CLI still
opens the TUI and shows the `daemon-autostart-failed` status notice. Background
agents and reconnectable sessions stay unavailable until `agenc daemon start`
succeeds. Inspect with `agenc daemon status`; stop a wedged process with
`agenc daemon stop`.

Ready-wait timeout for clients that start the daemon
(`AGENC_DAEMON_READY_TIMEOUT_MS`):

| Client                                                         | Default      |
| -------------------------------------------------------------- | ------------ |
| Published launcher (`packages/agenc`)                          | **2000** ms  |
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

| File                   | Mode / notes                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `daemon.sock`          | Unix domain socket path clients connect to; Windows uses a stable per-home named pipe instead |
| `daemon.cookie`        | Shared secret; cookie auth for local clients                                                  |
| `daemon.pid`           | Detached process id                                                                           |
| `daemon.log`           | Size-capped log sink                                                                          |
| `daemon-snapshot.json` | Lifecycle / recovery snapshot                                                                 |
| runtime-info files     | Version/path metadata for attach and doctor                                                   |

Override home:

```bash
export AGENC_HOME=/var/lib/agenc
```

## Transports & auth

- **Default local transport:** Unix socket at `$AGENC_HOME/daemon.sock`, or a
  stable pipe derived from `AGENC_HOME` on Windows.
- **Auth:** cookie file `$AGENC_HOME/daemon.cookie` (ensured on start; private
  socket owner identity + peer UID checks on supported platforms).
- **Optional WebSocket transport** (remote control, SSH tunnels, VPS operators)
  defaults to loopback **`ws://127.0.0.1:7766/`** (see
  `AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT`). Env knobs:

  | Env                                        | Role                                                                               |
  | ------------------------------------------ | ---------------------------------------------------------------------------------- |
  | `AGENC_DAEMON_WEBSOCKET_HOST`              | Bind host (default loopback `127.0.0.1`)                                           |
  | `AGENC_DAEMON_WEBSOCKET_PORT`              | Port (default **7766**)                                                            |
  | `AGENC_DAEMON_WEBSOCKET_PATH`              | Path (default `/`)                                                                 |
  | `AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK` | Set `1` to allow a non-loopback host; otherwise non-loopback binds are **refused** |

  Prefer the local socket/named pipe for TUI/CLI; WebSocket is what remote/phone
  and tunnel docs mean by `ws://127.0.0.1:7766`. Implementation:
  `runtime/src/app-server/daemon-cli.ts` + `transport/`.

- Config block `[daemon]` has one active setting: `autostart = true` by default.
  The platform runtime owns the local transport; it is not configurable.
  (`runtime/src/config/schema.ts`).

The embedding SDK (`@tetsuo-ai/agenc-sdk`) attaches the same way:

```js
import { connect } from "@tetsuo-ai/agenc-sdk";
const client = await connect(); // socket + cookie under AGENC_HOME
```

## Protocol

- Envelope: **JSON-RPC 2.0** over newline-delimited messages.
- Protocol version constant: **`1.9.0`**
  (`AGENC_DAEMON_PROTOCOL_VERSION` in `runtime/src/app-server/protocol/index.ts`).
- Clients send `initialize` with the protocol version. Negotiation compares the
  numeric major and minor versions: the server accepts the same major when the
  client minor is less than or equal to the server minor; the patch component
  does not affect compatibility. Malformed versions, different majors, and a
  client minor newer than the server are rejected with
  `PROTOCOL_VERSION_UNSUPPORTED`.
- Consequently, a 1.4 daemon accepts 1.0 through 1.3 clients, while a client
  that requires 1.4 is rejected by a still-running 1.0 through 1.3 daemon. The
  embedding SDK retries initialization at the reported older server version and
  uses advertised capabilities for additive fallbacks. Core/TUI callers may
  still fail closed. Protocol 1.6 made the owning runtime options and the live
  canonical run-settings snapshot required in `agent.attach`. Protocol 1.7
  adds required inactive auto availability and exact-workspace bypass
  capability and consent fields to that snapshot. Core/TUI callers reject an
  older daemon during initialize. The SDK rejects `agent.attach` and
  `createSession()` before dispatch on a negotiated protocol older than 1.8;
  it does not fall back to `session.create`, because that request cannot bind
  the caller's exact plugin storage root. Protocol 1.8 requires
  `runtimeOptions.pluginStorageRoot` in owning agent authority. It also makes
  successful `session.setModel` and `session.applyConfig` responses identify
  the exact canonical settings event and provider/model pair. Core/TUI clients
  wait for that event before they report success.
  Protocol 1.9 adds the internal `session.shell.execute` method for admitted
  shell commands on the live daemon-owned session.
  Protocols 1.0 through 1.2 advertise `session.mcp.status: false`,
  reject that method, and never receive `event.mcp_status_changed`. Update if
  necessary, then run `agenc daemon restart` so the daemon uses the installed
  protocol version.

### Public methods (`AGENC_DAEMON_METHODS`)

| Method                                                                                                      | Purpose                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `initialize`                                                                                                | Handshake + capability advertisement                                                                               |
| `request.cancel`                                                                                            | Cancel an in-flight request                                                                                        |
| `agent.create` / `agent.list` / `agent.attach` / `agent.stop` / `agent.logs`                                | Background agents                                                                                                  |
| `run.start` / `run.status` / `run.result` / `run.replay` / `run.evidence` / `run.cancel`                    | Start a verified-change run; inspect durable state, journal replay/evidence, terminal result, or tree cancellation |
| `csvJob.review.list` / `csvJob.review.show` / `csvJob.review.resolve`                                       | Inspect and settle durable CSV batch-review items                                                                  |
| `session.create` / `session.list` / `session.attach` / `session.detach`                                     | Session lifecycle                                                                                                  |
| `session.terminate` / `session.clear` / `session.snapshot` / `session.transcript` / `session.transcript.v2` | Session control and identity-bearing history sync                                                                  |
| `session.cancelTurn`                                                                                        | Abort the current turn, optionally only when `expectedTurnId` still matches                                        |
| `session.resolveToolCall`                                                                                   | Resolve a tool call whose durable outcome requires review                                                          |
| `session.mcp.status`                                                                                        | Read the owning session's revisioned, credential-free MCP status projection                                        |
| `session.mcp.addServer`                                                                                     | Attach MCP server to a session                                                                                     |
| `message.send` / `message.stream`                                                                           | Prompt turns                                                                                                       |
| `thread/realtime/start` / `appendAudio` / `appendText` / `stop` / `listVoices`                              | Realtime voice/thread. `start` is advertised `false` (fail-closed)                                                 |
| `tool.approve` / `tool.deny` / `tool.cancel`                                                                | Permission settlement                                                                                              |
| `elicitation.respond`                                                                                       | User-input / MCP elicitation reply                                                                                 |
| `permission.list`                                                                                           | List pending / granted permissions                                                                                 |
| `fs.fuzzy_search`                                                                                           | Workspace fuzzy file search                                                                                        |
| `commandExec.start` / `commandExec.write` / `commandExec.resize` / `commandExec.terminate`                  | Reserved PTY/command-exec. `start` is advertised `false`                                                           |
| `health.ping` / `health.ready` / `health.stats`                                                             | Liveness and stats                                                                                                 |
| `daemon.reload`                                                                                             | Reload configuration                                                                                               |
| `daemon.shutdown`                                                                                           | Ask the daemon process to exit                                                                                     |
| `auth.login` / `auth.whoami` / `auth.logout`                                                                | Auth backend                                                                                                       |

`session.snapshot` may include `contextBreakdown`, a rough estimate for
resident, MCP, and deferred tools, readable memory files, history, the system
prompt, and the session's effective window. The field is omitted when a
top-level measurement fails; individual unreadable or unserializable inputs
are skipped. The public SDK's `SessionSnapshotResult` does not currently type
this raw daemon field. `session.resolveToolCall` runs in a live session: resume
a settled `completed`, `failed`, or `cancelled` epoch even when unknown-outcome
reviews are still pending. See
[durable-runs-effects-events.md](../design/durable-runs-effects-events.md#resume-and-effect-review)
and
[provider-aware-token-accounting.md](../design/provider-aware-token-accounting.md#session-context-estimate).

### Internal methods (`AGENC_DAEMON_INTERNAL_METHODS`)

Not part of the public 54-method SDK surface. The TUI and workbench use them
over the same JSON-RPC socket. Embedders should not call these unless they are
reimplementing the workbench. Source:
`runtime/src/app-server/protocol/index.ts`.

| Group | Methods |
| --- | --- |
| Editor lock / sync | `workspace.editor.acquire`, `sync`, `staleAuthority.refresh`, `heartbeat`, `release` |
| Topology | `workspace.editor.topology.reserve`, `complete`, `release`, `recovered.list`, `recovered.resolve` |
| Proposals / changes | `workspace.editor.proposal.get`, `status`, `apply`, `discard`, `changes.list` |
| Code prediction | `workspace.editor.predict`, `cancelPrediction`, `predictionFeedback` |
| Compaction / rewind | `session.partialCompactFromMessage`, `rollbackCompaction`, `extendCompactionRollbackRetention`, `rewindConversationToMessage`, `previewFileRewind`, `rewindFilesToMessage` |
| Session controls | `session.setModel`, `setPermissionMode`, `applyConfig`, `session.permissions.mutateRule`, `session.shell.execute` |
| Hooks / MCP | `session.hooks.status`, `session.hooks.setDisabled`, `session.mcp.reconnectServer`, `session.mcp.enableServer`, `session.mcp.disableServer` |

Workbench BUFFER and Neovim behavior: [`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md).

`session.setPermissionMode` mutates the live session permission registry.
Switching to `bypassPermissions` requires explicit consent for the
session's exact canonical cwd (`authorizeBypassPermissionsConsent` /
`loadBypassPermissionsConsent` in
`runtime/src/app-server/background-agent-runner.ts`). A missing or
mismatched workspace throws
`Switching to bypassPermissions requires explicit consent for this exact cwd`
(or `Switching to bypassPermissions requires explicit consent for a stable
canonical cwd`). In-process `bypassAuthority:
"operator_tool_approval"` (Core `tool.approve` with
`allowAllToolsForSession`) can authorize that cwd for the transition. The
public JSON result stays `{ applied, previousMode, mode }`; a rollback
hook is attached only as a non-enumerable property and is not part of the
wire contract. Persisted bypass authority is refused on restore unless
consent still matches that exact workspace.

Protocol 1.7 adds `session.permissions.mutateRule` for authenticated Core
clients. It adds or removes one live session permission rule through the
daemon's permission registry. It is not a public SDK method.

Protocol 1.8 requires `runtimeOptions.pluginStorageRoot` on `agent.create` and
in the owning authority returned by `agent.attach`. It also adds the provider,
model, and runtime-settings event ID to successful model and config mutation
responses. Core waits for that exact event before updating the TUI or accepting
the next runtime-dependent action.

Protocol 1.9 adds `session.shell.execute` for the Core TUI. It accepts only
`sessionId`, `commandId`, and `command`. Callers cannot choose a working
directory, shell, environment, tool, or permission bypass. Session and command
IDs are limited to 1,024 UTF-8 bytes, and the command is limited to 65,536
UTF-8 bytes. The result contains `commandId`, `content`, `stdout`, `stderr`,
`exitCode`, `timedOut`, `truncated`, and `isError`. Each text result field is
limited to 100,000 UTF-8 bytes. The method supports `request.cancel` and is not
part of the public SDK method set.

### Race-safe turns and transcript sync (protocol 1.2+)

`message.send` and `message.stream` accept a caller-stable
`clientMessageId`. Reusing it with the same content is idempotent; reusing it
with different content is rejected. A retry response reports
`duplicateState: "completed" | "incomplete"` and never invents success for a
crash tail without a durable terminal event. Callers that require strict
single-turn admission pass `ifBusy: "reject"`. That flag refuses only an
in-flight or queued turn (`pendingMessageSubmissionCount`,
`pendingShellExecutionCount`, or a live `session.activeTurn`). It does
**not** treat a `pending_init` deferred session as busy. `agent.create`
with `deferInitialTurn: true` (Editor cold-start, restored agents with no
initial content) parks the thread in `pending_init` until the first
accepted message; refusing that message deadlocks the session. The flag
cannot be combined with `initialContent` or other first-turn metadata
(`runtime/src/app-server/daemon-dispatcher.ts`). Without `ifBusy`, the
legacy FIFO/co-driving behavior is unchanged for 1.0/1.1 clients.
Hidden-user submissions persist a non-rendering `message_submission` marker
with a SHA-256 content fingerprint, so their idempotency identity also survives
a process crash without duplicating the hidden prompt in that marker.

`session.transcript.v2` returns `schemaVersion: 2`, `runId`, `historyEpoch`,
`asOfSequence`, and stable identity-bearing messages. Canonical messages carry
`messageId`, `commitEventId`, `turnId`/`clientMessageId` when known, and
`committedSequence`. Migrated `response_item` rows use
`committedSequence: 0`; this explicitly means they predate the canonical event
cursor. Compaction, rewind, rollback, and clear each advance `historyEpoch` and
replace the active projection.

Live notifications carry the same `eventId`, `sequence`, `runId`,
`historyEpoch`, `turnId`, `clientMessageId`, and `messageId` correlation where
available. `event.message_chunk` is an assistant delta only; a durable
`agent_message` is a distinct committed message. Consumers buffer live events
while loading the snapshot, discard only events at or before
`asOfSequence` in the same epoch, and resync when the epoch changes.

`session.resolveToolCall` accepts two strict protocol-1.0 request shapes. The
earlier `{ sessionId, toolCallId?, reviewer? }` shape can settle only a legacy
in-flight tool call with no durable effect record. Durable effect records
require `toolCallId`, `disposition`, `evidenceRef`, and `evidenceSha256`; an
earlier-shape request leaves them unchanged in `remaining`. Partial mixtures of
the two shapes are invalid.

`session.list` is page-bounded: `limit` defaults to 50 and is capped at 100.
Pass the returned opaque `nextCursor` back with the same `agentId` filter; a
cursor is scoped to that filter and should not be persisted across daemon
upgrades. Persisted metadata is read with an indexed keyset page rather than a
full thread-history scan.

`fs.fuzzy_search` builds bounded path-only generations. Git worktrees use
Git's NUL-delimited tracked-plus-standard-untracked surface, including global,
repository, and common-worktree excludes; tracked-but-deleted entries are
removed. Non-Git roots use the packaged ripgrep byte protocol. The daemon
publishes a generation only after its count, byte count, and digest verify.
Unchanged warm requests search the immutable in-memory generation and do not
walk the workspace again. A caller may pass `refresh: true` to wait for a
complete replacement generation; otherwise a verified older generation may be
served while a rebuild is running.

The request's optional `limit` defaults to 50 and accepts integers from 1
through 1,000. The daemon rejects malformed Unicode, queries over 256 Unicode
code points, more than 64 raw roots, more than 32 canonical roots, roots over
16,384 UTF-8 bytes, and aggregate root text over 262,144 bytes. Requested roots
are canonicalized and intersected with the authenticated connection's trusted
workspace capability; request data is never treated as its own authorization.

The additive `freshness` response reports each root's generation, age, watcher
state, audit time, directory coverage, and stale/degraded/truncated flags.
`directoryCoverage: "nonempty_only"` is explicit for both Git and non-Git
generations: Git cannot represent a directory whose last tracked file was
deleted, while ripgrep cannot provide exact ignored empty-directory parity.
Callers must inspect these fields: watcher loss, a daemon restart gap, and
incomplete directory coverage are never presented as proof of full freshness.
Additive `matcher` metadata reports optimal versus full-query degraded
matching, resource-limit truncation, and the evaluated/total candidate counts.
No query prefix is silently discarded.

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

All 18 names in `AGENC_DAEMON_NOTIFICATION_METHODS`:

| Group | Methods |
| --- | --- |
| Exec | `commandExec.outputDelta` |
| Turn / tools | `event.message_chunk`, `event.tool_request`, `event.permission_request`, `event.user_input_request`, `event.mcp_elicitation_request` |
| Status | `event.agent_status`, `event.session_event`, `event.mcp_status_changed` |
| Sync | `event.event_gap` (retention eviction or replay required; do not skip) |
| Realtime (typed; start is advertised `false`) | `thread/realtime/started`, `itemAdded`, `transcript/delta`, `transcript/done`, `outputAudio/delta`, `sdp`, `error`, `closed` |

`event.mcp_status_changed` is an invalidation, not a state dump. Its strict
payload is `{ sessionId, revision }`. Fetch `session.mcp.status` for the
sanitized server/tool projection. A daemon replacement starts a new revision
epoch, so reconnecting clients discard the prior connection's watermark. The
invalidation is live-only and coalesced: it never enters transcript or detached
replay buffers, and a newly attached client fetches the current snapshot.

`initialize.capabilities` can opt an authenticated connection into delivery
outside ordinary session attachment:

| Capability                     | Behavior                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `portal.mobile.status.push.v1` | Global `event.agent_status` observer feed, deduplicated by physical connection and replayed from bounded session status buffers |
| `portal.ledger.solana.sign.v1` | Single-consumer `event.user_input_request.clientAction` delivery to the newest capable phone, with bounded live-session replay  |

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

`session.setPermissionMode` accepts optional
`bypassAuthority: "operator_tool_approval"` (the only legal value; the
dispatcher rejects any other string). The runner treats that as explicit
consent to enter `bypassPermissions` in the session's **exact**
canonical cwd. Without the field, a live switch still requires a prior
`/permissions accept-bypass` (or equivalent stored consent) for that
same path and directory identity. Startup `--permission-mode
bypassPermissions` does not write durable consent. Managed policy can
disable bypass entirely. See
[tools-permissions-sandbox.md](tools-permissions-sandbox.md#permission-modes).

`event.user_input_request.clientAction` and
`elicitation.respond.clientResult` carry typed client-only interactions. The
current Ledger action is documented in
[`../security/mobile-ledger-transfer.md`](../security/mobile-ledger-transfer.md).

## Interactive session survival

A keep-alive (interactive / desktop) session must stay promptable after
a capped turn. Bounded stops (`no_progress`, `max_turns`, and
`max_budget_usd`) complete the **turn** with an honest message and
leave the run available. The daemon mapper used to promote those stops
to `run_error`, after which every later prompt answered
`no longer running (status: error)` while the durable run might still
be healthy underneath.

One-shot / `--print` / `--no-tui` agents still fail the run on a
bounded stop: nobody is left to continue them.

`TaskCreate` accepts a subject-only call. `description` defaults to the
subject instead of failing validation. A model that retried a missing
description used to walk into the no-progress backstop and brick the
session.

The lifecycle refresh path may briefly report `runtimeAvailable=false`
(registration race, post-turn snapshot gap). The reaper waits
**60 seconds** (`RUNTIME_UNAVAILABLE_GRACE_MS`) of continuous
unavailability before treating a live agent as stale. Any successful
snapshot clears the stamp. A daemon-restart recovery that restored the
record without an attached runtime (`recovered === true` and no
runtime) is immediately reapable because it cannot resume on its own.

### Admission step identity on keep-alive turns

Daemon sessions set `admissionRequired`. Each streamed sample is admitted
under `(runId, stepId)`. Stream-model builds:

```text
model:<subId>:<turnCount>:<recoveryReentryCount>:<attempt>
```

Recovery re-entries bump `recoveryReentryCount`, so they get a new id.
Every successful nonterminal response also advances a durable sample ordinal.
Ordinal zero keeps the format above. Later physical samples add
`:sample-<ordinal>` before `:<attempt>`. This covers continuation nudges,
mid-turn compaction, an empty-response retry, tool follow-up, and stop-hook
re-entry without relying on whether the prompt token estimate changed.

Before the next admission, the runtime fsyncs a turn checkpoint containing the
ordinal. Runtime-only nudge and empty-response prompts are named in that
checkpoint and reconstructed after a crash. A resumed in-flight sample
therefore uses the exact same id and request, while a new physical sample gets
a new id.

See [execution-admission-kernel.md](../design/execution-admission-kernel.md#model-step-identity).

| Symptom | What to check |
| --- | --- |
| `AdmissionStepConflictError` | The same `(runId, stepId)` was acquired with different normalized admission data. Compare the `stepId`, provider, model, token bounds, and budget identity in `agenc run evidence`. |
| A crash-resumed nudge or empty-response retry conflicts | Verify the latest turn checkpoint contains the expected sample ordinal and resume-prompt kind. |
| A later model call lacks `sample-<ordinal>` | Check whether the prior response was terminal. Only successful nonterminal responses reserve another physical sample. |

## What the daemon owns

- **Sessions** — create/attach, multi-turn transcripts, rollouts under the
  project `sessions/` tree, cancel/compact/rewind (internal methods).
- **Background agents** — `AgenCDaemonAgentManager` +
  `AgenCDelegateBackgroundAgentRunner`; sessions bind `[agent.budget]` caps
  into the shared execution-admission allocation tree. The runner has no
  separate budget enforcement monitor or allocation ledger.
- **Permissions** — routes permission requests to the attached client; print
  mode / unattended embeds deny when no handler is registered.
- **Capability delivery** — global mobile status observers and single-consumer
  typed client actions, independent from transcript attachment.
- **Command exec / PTY** — `commandExec.*` for interactive shell surfaces.
- **Health & recovery** — `health.*`, startup recovery of in-flight tool
  calls and agent runs (`runtime/src/state/recovery.ts`), pruning policies.
  Journal quarantine/deferred (schema v18, live DB through v27) is operator
  CLI `agenc state recovery …`, not a daemon RPC. See [cli.md](cli.md).
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
agenc budget status    # configured policy only; usage is agenc run status <run-id>
```

## Source map

| Concern                           | Path                                                |
| --------------------------------- | --------------------------------------------------- |
| CLI                               | `runtime/src/app-server/daemon-cli.ts`              |
| JSON-RPC dispatch                 | `runtime/src/app-server/daemon-dispatcher.ts`       |
| Protocol constants                | `runtime/src/app-server/protocol/index.ts`          |
| Session lifecycle                 | `runtime/src/app-server/session-lifecycle.ts`       |
| Agent lifecycle                   | `runtime/src/app-server/agent-lifecycle.ts`         |
| Background runs                   | `runtime/src/app-server/background-agent-runner.ts` |
| Local socket / Windows named pipe | `runtime/src/app-server/transport/unix-socket.ts`   |
| Cookie auth                       | `runtime/src/app-server/transport/auth.ts`          |
| Health                            | `runtime/src/app-server/health.ts`                  |
| Model admission step id           | `runtime/src/phases/stream-model.ts`                |
| Continuation nudge                | `runtime/src/phases/continuation-nudge.ts`          |
| Mid-turn compact continue         | `runtime/src/session/run-turn.ts`                   |
| Step uniqueness / conflict        | `runtime/src/state/execution-admission.ts`          |
| Launcher autostart                | `packages/agenc/src/launcher.mjs`                   |
| SDK connect                       | `packages/agenc-sdk/src/socket.ts`                  |
