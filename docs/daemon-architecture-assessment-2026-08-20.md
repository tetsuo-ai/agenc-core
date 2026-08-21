# Daemon architecture assessment (2026-08-20)

Owner question: users should be able to launch as many AgenC instances as they
want, desktop or CLI, across different projects. Why is there a shared daemon
at all, and why does one bad session take everything down? Comparison target:
`~/git/codex` (OpenAI codex, Rust).

Companion incident work: #1756/#1757 (deferred first-send deadlock), #1758
(bypass consent unreachable over RPC), #1759 (reconcile stop self-deadlock),
#1760 (remaining unbounded-await hardening backlog). All were found live in one
afternoon of desktop dogfooding and all trace back to the same architecture
property: shared mutable state in one process for every project.

## How codex does it

- `codex` (TUI) and `codex exec` are single-process. The agent loop, app
  server, and UI share one process; the app-server logic is hosted over
  in-memory channels (`codex-rs/app-server/src/in_process.rs`). No daemon on
  the default path.
- A separate app-server process exists only as: (a) a per-client stdio child
  for editor integrations (one client, one process), (b) an opt-in
  `--listen unix://` control socket, (c) `codex-app-server-daemon`, which is a
  supervisor/updater for remote control (phone/SSH) and owns no sessions - just
  pidfiles and launch settings.
- The TUI probes the control socket for 50 ms and attaches only when the
  daemon is already running AND the launch config is fully default
  (`tui/src/lib.rs` `app_server_target_for_launch`). Otherwise embedded.
  Shared-process mode is opt-in and degradable, never mandatory.
- Isolation: two codex instances in two projects share no memory. Shared state
  is files under `$CODEX_HOME`: per-thread rollout JSONL, SQLite with WAL and a
  5 s busy timeout, and per-thread advisory writer locks. Request serialization
  inside one server is keyed by resource (`thread_id`, process, config, auth),
  never by connection; `turn/start` returns before the model call, so a slow
  turn holds no queue. A hung conversation in instance A cannot affect
  instance B, because B is a different OS process.

## How agenc does it

- One mandatory daemon per `AGENC_HOME`. TUI, desktop, gateway are clients;
  there is no in-process escape hatch on any CLI path (an in-process transport
  exists - `runtime/src/app-server/transport/in-process.ts`, ported from
  codex's `in_process.rs` - but only SDK embedders use it).
- The daemon singly owns, for all projects at once: the session manager, the
  client multiplexer, the exec service, the execution admission kernel
  (global:64 / workspace:32 / provider:16 concurrency), one config from
  `AGENC_HOME/config.toml` (no per-project layer), one V8 heap (4 GB cap), one
  event loop.
- Cross-project blast radius, verified in source: process-wide `AsyncLock`
  state mutexes with no timeout (agent-lifecycle, client-multiplexer) that
  awaited I/O while held; global admission caps that a stalled provider can
  starve; per-connection FIFO dispatch with a fixed priority allowlist; one
  heap OOM or event-loop stall kills every project; daemon crash drops every
  session everywhere. The 2026-08-20 incidents were these properties
  expressing themselves.

## What genuinely needs a resident process

Three things, and only three: background agents that outlive their terminal,
the channel gateway (Telegram/Discord/cron/heartbeat), and the cumulative
budget/admission ledger. Mobile push also needs a resident listener. Codex has
no local equivalent of these; where codex needs persistence (remote control),
it also runs a daemon - it just keeps the default local path out of it.

Everything else the daemon provides (persistence/resume, transcripts, run
inspection, provider auth, fuzzy index) is achievable in-process, as codex
demonstrates.

## Target shape

Default path: TUI and print mode host the daemon dispatcher in-process via the
existing `transport/in-process.ts`, exactly as codex hosts `MessageProcessor`.
The unix socket becomes an attach path: used when explicitly requested or when
a daemon is already running and the launch config is default. N instances
become N processes; per-project isolation follows from the OS.

The residual daemon keeps: background agents (`agent.create`), gateway
sessions, cron/heartbeat, the durable budget ledger, push fan-out, and
machine-wide discovery (`agent.list` across processes).

The five moves, in order of leverage:

1. In-process host as the default for TUI/print; socket attach opt-in
   (mirror `app_server_target_for_launch`).
2. Per-project config layer (`.agenc/config.toml`), config resolved
   per-session, not per-process.
3. Split the admission kernel: in-process enforcement per instance, durable
   SQLite ledger shared, lease TTLs so a wedged step cannot hold a slot.
4. Re-key request serialization from connection to resource (session id, run
   id, config, auth), retiring the priority-method allowlist.
5. Shrink daemon in-memory authority: per-session locks, no I/O under any
   global lock (the invariant behind #1759/#1760).

Costs, honestly: "desktop attaches to the live TUI session" becomes
cross-process (needs the explicit shared server, like codex), and the budget
ledger needs multi-process-safe writes (the per-project SQLite DBs and the
rollout PID-flock already demonstrate the pattern).

Uncertain, not verified: the Codex Desktop app's internal process model (not
in the repo; per-window stdio app-server is inferred from the VS Code
pattern), and whether an unanswered agenc permission request has any timeout
(none found; relevant to #1760 item 1).
