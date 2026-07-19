# AgenC Embedding SDK (`@tetsuo-ai/agenc-sdk`)

Package: `packages/agenc-sdk` · version **0.2.0** · Node **>=25.9 <26** · ESM only · zero runtime dependencies.

The SDK embeds AgenC in another application without importing runtime internals.
It speaks the daemon's JSON-RPC protocol over a hand-mirrored type surface
pinned by a drift test (see [Protocol mirror & drift guard](#protocol-mirror--drift-guard)).

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk   # plain tsc → dist/
```

## Two transports

| | daemon transport | subprocess transport |
|---|---|---|
| entry                | `connect()` → `AgencClient`            | `promptViaSubprocess()`                                           |
| wire                 | JSON-lines over `~/.agenc/daemon.sock` | `agenc -p --output-format stream-json --input-format stream-json` |
| sessions             | persistent, resumable, multi-turn      | one-shot per spawn                                                |
| permission callbacks | yes (approve or deny live)             | no — CLI auto-denies (exit code 2 = tool-denied giveup)           |
| background agents    | spawn / attach / stop / logs           | no                                                                |
| daemon required      | attaches, or starts one via the CLI    | the CLI manages its own daemon                                    |

Both produce the same typed event iterable (`AgencPromptEvent`) and the same
final `AgencPromptResult`, so downstream consumption code is shared.

## Daemon transport

```js
import { connect } from "@tetsuo-ai/agenc-sdk";

const client = await connect({
  // all optional:
  // socketPath, cookiePath — default ${AGENC_HOME:-~/.agenc}/daemon.{sock,cookie}
  // autostart: true       — run `agenc daemon start` when not running
  // agencCommand: "agenc" — CLI used for autostart (absolute path when embedding)
  // requestTimeoutMs      — per-RPC timeout (default 30s or AGENC_DAEMON_REQUEST_TIMEOUT_MS)
  onPermissionRequest: async (request) => {
    // request: { sessionId, requestId, toolName?, permissions, input?, reason? }
    return request.toolName === "Read"
      ? { behavior: "allow", scope: "once" }
      : { behavior: "deny", reason: "not allowed here" };
  },
});

const session = await client.createSession();
const run = session.prompt("Summarize this repo's protocol layer.");

for await (const event of run) {
  switch (event.type) {
    case "text":               process.stdout.write(event.delta); break;
    case "tool_call":          /* event.toolName, event.input */ break;
    case "permission_request": /* also routed to onPermissionRequest */ break;
    case "status":             /* event.runStatus */ break;
  }
}

const result = await run.result();
// { stopReason: "completed" | "errored" | "stopped", exitCode, finalMessage,
//   deniedPermissionRequestIds, usage?, cacheStats? }

await client.close();
```

Key `AgencClient` methods:

- `createSession(params?)` / `resumeSession(sessionId)` → `AgencSession`
  (`prompt`, `transcript`, `snapshot`, `cancelTurn`, `terminate`)
- `spawnAgent(params)` → background agent (`agent.create`)
- `attachAgent(agentId)` → `{ attach, session }` for a running agent
- `listAgents()` / `stopAgent(id)` / `agentLogs(id)`
- `runStatus(id)` / `runResult(id)` / `replayRun(params)` /
  `reattachRun(options)` / `runEvidence(params)` / `cancelRun(id, reason?)`
- `request(method, params)` → raw typed JSON-RPC for any of the **45** daemon methods
- `onNotification(cb)` / `onSessionNotification(sessionId, cb)` → raw events

Permission requests with no registered handler are **denied** (never granted)
so an unattended embedder can't hang a turn, mirroring `agenc -p`.
Elicitations (`event.user_input_request` / `event.mcp_elicitation_request`)
route to `onElicitationRequest`; return the response object for
`elicitation.respond`, or `null` to leave it unanswered.

`event.user_input_request` can also carry an optional JSON-object
`clientAction`. The SDK preserves it on `AgencPromptEvent` when present; scalar
or malformed values are not promoted. The current typed action is
`ledger_solana_transfer_v1`, and its response travels in a dedicated
`clientResult` field rather than free-text answers. See the full
[mobile Ledger contract](security/mobile-ledger-transfer.md).

This is a protocol mirror, not automatic signing authority. `connect()` sends
an empty initialize capability set today, so a generic embedder does not opt
into `portal.ledger.solana.sign.v1` or `portal.mobile.status.push.v1`. The
authenticated Android portal client advertises those explicitly. A future SDK
capability option must remain opt-in and bind delivery to a concrete handler.

Usage/cost: after the turn ends the SDK fetches `session.snapshot` and puts
`tokenUsage`/`cacheStats` on the result (`includeUsage: false` to skip).

### Handshake and autostart

The daemon requires the first message on a socket to be `initialize` carrying
the `authCookie` read from `~/.agenc/daemon.cookie`; `connect()` does this for
you. Socket path defaults to `~/.agenc/daemon.sock` (or
`${AGENC_HOME}/daemon.sock`).

When the socket is not accepting connections and `autostart` is enabled
(default), `connect()` runs `<agencCommand> daemon start` and polls the cookie
+ socket until ready (45s budget, or `AGENC_DAEMON_READY_TIMEOUT_MS`).

Deviation from the launcher: the runtime's internal autostart also handles
build-skew respawn and orphan-daemon adoption. Those need runtime-internal
state, so the SDK implements only attach-to-running + spawn-via-CLI. For full
recovery behavior, start the daemon with the CLI first and call
`connect({ autostart: false })`.

The transport is a single persistent connection with no reconnect layer;
call `connect()` again (or use `onDisconnect`) if the daemon restarts.

### Embedding in-process (no socket)

If your process already hosts the runtime's app-server dispatcher, wire the
runtime's `AgenCInProcessDaemonTransport` straight into the client — the tests
in `runtime/tests/sdk-package/` do exactly this:

```ts
let client;
const transport = new AgenCInProcessDaemonTransport({
  dispatcher,
  sendNotification: (n) => client?.dispatchNotification(n),
});
client = createAgencClient({ transport });
await client.initialize();
```

## Subprocess transport

No daemon socket access from your process; the SDK spawns the headless CLI and
adapts its stream-json output onto the same event iterable:

```js
import { promptViaSubprocess } from "@tetsuo-ai/agenc-sdk";

const run = promptViaSubprocess("explain the fee split", {
  agencCommand: "agenc", // or ["/abs/path/agenc"]
  model: "grok-4.5", // optional; also provider/profile/permissionMode
});
for await (const event of run) { /* same AgencPromptEvent union */ }
const result = await run.result(); // exitCode/finalMessage/usage from the CLI's result line
```

Under the hood this is
`agenc -p --output-format stream-json --input-format stream-json`, with the
prompt written to stdin as `{"type":"prompt","prompt":"..."}`. Exit code 2
means the run auto-denied a tool permission and gave up (the CLI's
non-interactive contract); pass `permissionMode: "bypassPermissions"` or use
the daemon transport when tools must run.

## Runnable example

`packages/agenc-sdk/examples/one-shot.mjs` exercises both transports:

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk
node packages/agenc-sdk/examples/one-shot.mjs "say hello in one word"
node packages/agenc-sdk/examples/one-shot.mjs --transport subprocess "say hello"
```

### Durable run inspection

```ts
import { AgencRunReplayGapError } from "@tetsuo-ai/agenc-sdk";

const attachment = client.reattachRun({
  runId,
  afterSequence: savedAfterSequence ?? 0,
  onDuplicate: ({ event }) => console.warn("duplicate", event.eventId),
});

try {
  for await (const event of attachment) {
    await applyEventIdempotently(event);
    // Save only after the application has processed this event.
    await saveAfterSequence(attachment.cursor().afterSequence);
  }
} catch (error) {
  if (error instanceof AgencRunReplayGapError) {
    // The cursor stops at the last event yielded before the gap. Reconcile the
    // missing range before choosing a replacement; the SDK never jumps it.
    console.error(error.gap, attachment.cursor());
  } else {
    throw error;
  }
}

const status = await client.runStatus(runId);
if (status.terminal) {
  const result = await attachment.result();
  console.log(result.outcome, result.output);
}

const evidence = await client.runEvidence({ runId, limit: 100 });
console.log(evidence.source.completeness, evidence.hashes.bundleSha256);
```

`run.result` rejects through `AgencRpcError` with
`error.data.code === "RUN_NOT_TERMINAL"` until the run is durably terminal. A
canonical M4 result returns `output.available: true`; a legacy terminal row
without a canonical terminal payload returns `output.available: false` rather
than inventing one.

Canonical `run.replay` cursors are exclusive, per-run sequences. Pages are
contiguous and expose durable `eventId` values. Retention, compaction,
corruption truncation, a missing source, and a cursor beyond the durable tail
are explicit gaps; none authorizes cursor advancement. The safer
`reattachRun()` helper validates page ordering and identity consistency,
suppresses exact duplicates, throws `AgencRunReplayGapError` without moving
past a gap, and fails closed with `AgencRunReplayProtocolError` on an
unexplained jump or conflicting identity.

Raw `replayRun()` callers must inspect `page.gap` before adopting
`page.nextAfterSequence`. A pre-M4 compatibility page can instead come from
the execution-admission journal; its source declares
`sequenceScope: "project_state_database"`, where skipped numbers may belong to
other runs. `run.evidence` declares
`workflowEvidenceIncluded: true` for canonical journal pages and `false` for
that compatibility source, together with an explicit completeness value and
content hashes.

## Daemon method surface (45 methods)

Mirrored in `packages/agenc-sdk/src/protocol.ts` as `AGENC_SDK_DAEMON_METHODS`
(order pinned to the runtime registry):

| Group | Methods |
| --- | --- |
| lifecycle | `initialize`, `request.cancel` |
| agents | `agent.create`, `agent.list`, `agent.attach`, `agent.stop`, `agent.logs` |
| runs | `run.status`, `run.result`, `run.replay`, `run.evidence`, `run.cancel` |
| sessions | `session.create`, `session.list`, `session.attach`, `session.detach`, `session.terminate`, `session.clear`, `session.snapshot`, `session.transcript`, `session.cancelTurn`, `session.mcp.addServer` |
| messaging | `message.send`, `message.stream` |
| realtime | `thread/realtime/start`, `thread/realtime/appendAudio`, `thread/realtime/appendText`, `thread/realtime/stop`, `thread/realtime/listVoices` |
| tools / permissions | `tool.approve`, `tool.deny`, `tool.cancel`, `elicitation.respond`, `permission.list` |
| exec / fs | `fs.fuzzy_search`, `commandExec.start`, `commandExec.write`, `commandExec.resize`, `commandExec.terminate` |
| health / daemon | `health.ping`, `health.ready`, `health.stats`, `daemon.reload` |
| auth | `auth.login`, `auth.whoami`, `auth.logout` |

Server→client notifications (`AGENC_SDK_DAEMON_NOTIFICATION_METHODS`) cover
command-exec deltas, message chunks, tool/permission/elicitation requests,
agent/session status, and realtime stream events.

The command-exec methods remain typed for protocol compatibility, but
`commandExec.start` currently returns `EXECUTION_ADMISSION_REQUIRED`: it cannot
start work until the RPC carries a daemon session-bound admission identity.
The server therefore advertises `commandExec.start: false`. It also advertises
`thread/realtime/start: false` while realtime provider traffic lacks the same
durable admission and usage contract; clients should use the initialize
capability map instead of treating registry membership as availability.

Important raw protocol additions:

| Shape | Contract |
| --- | --- |
| `EventUserInputRequestParams.clientAction` | Optional trusted JSON action generated by Core, never by generic `request_user_input` model arguments |
| `RequestUserInputResponse.clientResult` | Typed client result returned through `elicitation.respond`; Ledger receipts are challenge- and field-bound |
| `ToolApproveParams.allowAllToolsForSession` | Valid only with `scope: "session"`; promotes the daemon session to `bypassPermissions` transactionally |
| `AuthWhoamiResult.subscriptionTier` | Tier from the latest verified remote `/v1/auth/me` snapshot; identity also carries compatibility `plan` data |
| `AuthLoginResult` | App-server login result contains non-secret state/identity only; the backend bearer is never returned over daemon RPC |

Plain `scope: "session"` without `allowAllToolsForSession: true` keeps the
narrower equivalent-rule approval cache. Interactive approval/deny/elicitation
RPCs are preemptive in daemon transports so a reply cannot queue behind the
turn it must unblock. Cancel, bounded run reads, health/status, attach,
`session.list`, and `session.snapshot` requests use the same transport priority
lane so they remain responsive during a streaming turn. `session.list` returns
at most `limit` rows (default 50, maximum 100); continue with its opaque
`nextCursor` and the
same `agentId` filter.

Use typed helpers when available; fall back to
`client.request("session.snapshot", { sessionId })` (etc.) for anything else.

## Protocol mirror & drift guard

`packages/agenc-sdk/src/protocol.ts` hand-mirrors the daemon protocol
(method registry, params/result shapes, notification params).
`runtime/tests/sdk-package/protocol-drift.contract.test.ts` pins the mirror's
`AGENC_SDK_DAEMON_METHODS` / `AGENC_SDK_DAEMON_NOTIFICATION_METHODS` to the
runtime's canonical `AGENC_DAEMON_METHODS` /
`AGENC_DAEMON_NOTIFICATION_METHODS` (names **and** order) and checks the
params/result maps declare every method. Change the daemon protocol and
`vitest` fails until the mirror is updated.

Event semantics (streamed text extraction, terminal-status detection) mirror
the CLI's daemon one-shot path in `runtime/src/bin/agenc.ts`
(`daemonOneShotMessageChunk` / `daemonOneShotFinalStatus`), so an embedder
sees the same output and completion behavior as `agenc -p`.

## Tests

`runtime/tests/sdk-package/`:

- `protocol-drift.contract.test.ts` — mirror pinned to the runtime registry.
- `client-inprocess.contract.test.ts` — full connect → createSession →
  prompt event stream and permission round-trips against a fake daemon hosted
  on the **real** in-process transport (real dispatcher, session lifecycle,
  and client multiplexer).
- `subprocess-transport.test.ts` — stream-json adaptation with a fake child
  process (argv contract, event mapping, exit-code-2 mapping, error paths).
- `events.contract.test.ts` — trusted object `clientAction` preservation and
  malformed/scalar rejection at the SDK event boundary.
- `replay-safe-client.contract.test.ts` — reconnect cursors, duplicate
  suppression, explicit gaps, protocol-conflict rejection, and durable result
  lookup.

```bash
cd runtime && npx vitest run tests/sdk-package
```

## Related

- Package README: [`packages/agenc-sdk/README.md`](../packages/agenc-sdk/README.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Channel gateway (SDK consumer): [`gateway.md`](gateway.md)
