# AgenC Embedding SDK (`@tetsuo-ai/agenc-sdk`)

Package: `packages/agenc-sdk` · version **0.3.0** · Node **>=26.5 <27** · ESM only · zero runtime dependencies.

The SDK embeds AgenC in another application without importing runtime internals.
It speaks the daemon's JSON-RPC protocol over a hand-mirrored type surface
pinned by a drift test (see [Protocol mirror & drift guard](#protocol-mirror--drift-guard)).

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk   # plain tsc → dist/
```

## Two transports

|                      | daemon transport                                    | subprocess transport                                              |
| -------------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| entry                | `connect()` → `AgencClient`                         | `promptViaSubprocess()`                                           |
| wire                 | JSON-lines over a Unix socket or Windows named pipe | `agenc -p --output-format stream-json --input-format stream-json` |
| sessions             | persistent, resumable, multi-turn                   | one-shot per spawn                                                |
| permission callbacks | yes (approve or deny live)                          | no — CLI auto-denies (exit code 2 = tool-denied giveup)           |
| background agents    | spawn / attach / stop / logs                        | no                                                                |
| daemon required      | attaches, or starts one via the CLI                 | the CLI manages its own daemon                                    |

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
    return request.toolName === "FileRead"
      ? { behavior: "allow", scope: "once" }
      : { behavior: "deny", reason: "not allowed here" };
  },
});

const session = await client.createSession({
  pluginStorageRoot: "/absolute/agenc-home/plugins",
});
const run = session.prompt("Summarize this repo's protocol layer.");

for await (const event of run) {
  switch (event.type) {
    case "text":
      process.stdout.write(event.delta);
      break;
    case "message_committed":
      /* durable assistant message; distinct from text deltas */ break;
    case "tool_call":
      /* event.toolName, event.input */ break;
    case "permission_request":
      /* also routed to onPermissionRequest */ break;
    case "elicitation_request":
      /* also routed to onElicitationRequest */ break;
    case "history_reset":
      /* drop buffered history and turn markers; reload transcriptV2() */ break;
    case "gap":
      /* event.event_gap; do not skip */ break;
    case "session_event":
      /* lifecycle / session status */ break;
    case "status":
      /* event.runStatus */ break;
  }
}

const result = await run.result();
// { stopReason: "completed" | "errored" | "stopped", exitCode, finalMessage,
//   deniedPermissionRequestIds, usage? }

await client.close();
```

Key `AgencClient` methods:

- `createSession(params)` / `resumeSession(sessionId)` → `AgencSession`
  (`prompt`, `transcript`, `transcriptV2`, `snapshot`, `cancelTurn`, `terminate`)
- `spawnAgent(params)` → background agent (`agent.create`)
- `attachAgent(agentId)` → `{ attach, session }` for a running agent
- `listAgents()` / `stopAgent(id)` / `agentLogs(id)`
- `startRun(params)` → start the M5 verified-change workflow as a durable
  daemon run (`run.start`; resolves after the intake commit with
  `{ runId, specDigest, baseCommit, baseDirty }`)
- `runStatus(id)` / `runResult(id)` / `replayRun(params)` /
  `reattachRun(options)` / `runEvidence(params)` / `cancelRun(id, reason?)`
- `listCsvJobReviews` / `showCsvJobReview` / `resolveCsvJobReview`
- `request(method, params)` → raw typed JSON-RPC for any of the **53** daemon methods
- `initialize` (handshake; SDK retries 1.0 through 1.8), `close()`
- `negotiatedProtocolVersion` / `serverProtocolVersion` / `serverCapabilities`
- `onNotification(cb)` / `onSessionNotification(sessionId, cb)` → raw events
- Path helpers: `resolveAgencHome`, `resolveDaemonSocketPath`, `resolveDaemonCookiePath`

The daemon transport validates its home authority before it reads a cookie or
opens a socket. `AGENC_HOME` must be absolute and is canonicalized through its
deepest existing ancestor. Explicit `socketPath` and `cookiePath` overrides do
not bypass home-authority validation.

`createSession()` sends safe runtime options with
`allowUntrustedHooks: false` and the exact `pluginStorageRoot` passed to that
call. `AgencClient` does not reread `AGENC_PLUGIN_CACHE_DIR` or derive a root
from `AGENC_HOME`. The root must be absolute, must not have surrounding
whitespace, and must be at most 4096 UTF-8 bytes. `createSession()` does not
accept `agentId`; use `attachAgent()` for an existing agent. The lower-level
`spawnAgent()` API requires a complete `runtimeOptions` object. Set
`allowUntrustedHooks: true` only when the embedding application has vetted the
workspace and intends to permit command hook effects there. The field never
permits HTTP, prompt, or agent hook effects.

`dangerouslyBypassApprovalsAndSandbox` defaults to `false`. Set it to `true`
only when the embedding application deliberately grants both approval bypass
and unrestricted OS execution to the new session. The daemon retains that
creation-time authority across attachment and cold resume; attaching to an
existing session cannot add or remove it.

When `initialPrompt` is present, `createSession()` submits it as the new
agent's initial input. The method also passes `metadata` unchanged to
`agent.create`. Without `initialPrompt`, the new agent remains idle until the
first `prompt()` call.

`simpleMode: true`, which is the typed form of `--bare`, still suppresses every
session hook extension point.

Generated public contracts must stay synchronized with their authorities. Do
not change their public shapes independently:

- `packages/agenc-sdk/src/transcript-v2.generated.ts` mirrors the daemon
  `SessionTranscriptV2*` result interfaces and is re-exported from `protocol.ts`.
  Verify its exact content with
  `npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types`. See
  [Transcript v2 generated mirror](#transcript-v2-generated-mirror) for the
  manual refresh steps.
- `packages/agenc-sdk/src/workflow-result.generated.ts` mirrors workflow result
  contracts whose source schemas live under `runtime/src/agents/`. The same
  generated-type command checks selected version and outcome markers.
- `packages/agenc-sdk/src/workflow-handoff.generated.ts` mirrors the workflow
  handoff schema under `runtime/src/agents/`. Run
  `npm exec --workspace=@tetsuo-ai/runtime -- vitest run tests/sdk-package/workflow-handoff.contract.test.ts`
  for selected public constant and validator coverage. The generated-type
  command checks runtime handoff markers and does not read this public file.
  No current check proves full structural parity. [#1941](https://github.com/tetsuo-ai/agenc-core/issues/1941)
  tracks that work.

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
`tokenUsage` on the result (`includeUsage: false` to skip). That aggregate is
the live session total. Historical per-turn duration and usage after attach
or restore come from `session.transcript.v2` `turnResults` (see
[daemon.md](reference/daemon.md#closed-turn-results)). Raw daemon snapshot
responses may carry an additive `contextBreakdown` object, but the current
public SDK type does not expose a named field. `SessionTranscriptV2Result`
does name optional `turnResults`, with each row typed as
`SessionTranscriptV2TurnResult`. `prompt()` copies only token usage.

Prompt admission is reserved synchronously per session, before attach or send,
so a second local `prompt()` throws `AgencPromptRunInProgressError`. Every SDK
prompt supplies a stable `clientMessageId` (callers may provide one for retry)
and opts into `ifBusy: "reject"` when requested. That strict option fails
closed before send when protocol 1.2 is unavailable. Stream/status events are
ignored until the matching durable `user_message` is observed and its turn is
bound. Abort before dispatch sends nothing; later abort uses `expectedTurnId`
on protocol 1.2. The SDK never falls back to session-wide prompt cancellation
on an older daemon because it could hit a later turn.

The SDK distinguishes `text` deltas from `message_committed`, reconciles the
final result with committed text, and exposes `history_reset` for clear,
compaction, rewind, and rollback. A duplicate without durable terminal proof
fails with `AgencDuplicateSubmissionIncompleteError`. Initialization retries
against daemons running protocol 1.0 through 1.8 at the reported version and
retains negotiated version and capability information for safe feature
fallback.

### Handshake and autostart

The daemon requires the first message on a socket to be `initialize` carrying
the `authCookie` read from `~/.agenc/daemon.cookie`; `connect()` does this for
you. The local endpoint defaults to `~/.agenc/daemon.sock` (or
`${AGENC_HOME}/daemon.sock`) on Unix and a stable per-home named pipe on
Windows.

When the socket is not accepting connections and `autostart` is enabled
(default), `connect()` runs `<agencCommand> daemon start` and polls the cookie
and socket until ready (45s budget, or `AGENC_DAEMON_READY_TIMEOUT_MS`).

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
const session = await client.createSession({
  pluginStorageRoot: "/absolute/agenc-home/plugins",
});
```

Every transport must pass the exact `pluginStorageRoot` to `createSession()`.
Protocol 1.8 is the first daemon protocol that can bind that root to the new
agent. The SDK does not rebuild the root from the host process environment.

## Subprocess transport

No daemon socket access from your process; the SDK spawns the headless CLI and
adapts its stream-json output onto the same event iterable:

```js
import { promptViaSubprocess } from "@tetsuo-ai/agenc-sdk";

const run = promptViaSubprocess("explain the fee split", {
  agencCommand: "agenc", // or ["/abs/path/agenc"]
  model: "grok-4.5", // optional; also provider/profile/permissionMode
});
for await (const event of run) {
  /* same AgencPromptEvent union */
}
const result = await run.result(); // exitCode/finalMessage/usage from the CLI's result line
```

Under the hood this is
`agenc -p --output-format stream-json --input-format stream-json`, with the
prompt written to stdin as `{"type":"prompt","prompt":"..."}`. Exit code 2
means the run auto-denied a tool permission and gave up (the CLI's
non-interactive contract). `permissionMode: "bypassPermissions"` is an
explicit approval-only opt-in bound to the subprocess workspace; it does not
disable the configured OS sandbox, persist consent, or override managed
policy. `dangerouslyBypassApprovalsAndSandbox: true` emits the separate
combined escape flag. Use the daemon transport when a client must resolve
permission requests interactively.

The subprocess transport invokes `agenc -p`, so
`AGENC_ALLOW_UNTRUSTED_HOOKS` in `options.env`, or in the inherited child
environment when `options.env` is omitted, is captured as automation startup
authority. The child sends the captured typed value to the daemon; it does not
install the variable as mutable daemon environment state.

## Runnable example

`packages/agenc-sdk/examples/one-shot.mjs` exercises both transports:

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk
AGENC_PLUGIN_CACHE_DIR=/absolute/path/to/agenc/plugins \
  node packages/agenc-sdk/examples/one-shot.mjs "say hello in one word"
node packages/agenc-sdk/examples/one-shot.mjs --transport subprocess "say hello"
```

### Starting a verified-change workflow

```ts
const started = await client.startRun({
  goal: "Fix the flaky retry counter in the sync worker.",
  cwd: "/abs/path/to/repo",
  model: "grok-4.6",
  reviewerModel: "grok-4.5",
  permissionMode: "acceptEdits",
  requiredVerification: [{ label: "unit", script: "npm test" }],
});
// started: { runId, specDigest, baseCommit, baseDirty }
```

`startRun` resolves after the durable intake commit; the fixed pipeline
continues in the daemon. `model` and `provider` ride on the run session
bootstrap the same way `agenc run start --model` does. Omitting them uses
the daemon default, including for children that inherit the run's provider.
Follow the run by id with the existing cursor contract: `runStatus` adds a
`workflow` step projection (stage statuses, attempts, verdicts, artifact
pointers, stop reason), `runResult` returns the durable terminal, and
`runEvidence` adds the sealed evidence `bundle` (verified-change record
digest, ledger path, `cas://sha256/...` artifact pointers). The workflow
demands at least one required verification command; `completed` is refused
without passing commands, a `VERDICT: PASS` verification agent, and a
zero-blocker independent review. After finalize, the delivered commit is
`refs/agenc/runs/<runId>` in the repository. Child failures that produce no
assistant text still carry a bounded `error` in the step `finalMessage`.
Operator pitfalls:
[design/verified-change-workflow-m5.md](design/verified-change-workflow-m5.md).

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

## Daemon method surface (54 methods)

Mirrored in `packages/agenc-sdk/src/protocol.ts` as `AGENC_SDK_DAEMON_METHODS`
(order pinned to the runtime registry):

| Group               | Methods                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| lifecycle           | `initialize`, `request.cancel`                                                                                                                                                                                                                          |
| agents              | `agent.create`, `agent.list`, `agent.attach`, `agent.stop`, `agent.logs`                                                                                                                                                                                |
| runs                | `run.start`, `run.status`, `run.result`, `run.replay`, `run.evidence`, `run.cancel`                                                                                                                                                                     |
| CSV review          | `csvJob.review.list`, `csvJob.review.show`, `csvJob.review.resolve`                                                                                                                                                                                     |
| sessions            | `session.create`, `session.list`, `session.attach`, `session.detach`, `session.terminate`, `session.clear`, `session.snapshot`, `session.transcript`, `session.transcript.v2`, `session.cancelTurn`, `session.resolveToolCall`, `session.mcp.status`, `session.mcp.addServer` |
| messaging           | `message.send`, `message.stream`                                                                                                                                                                                                                        |
| realtime            | `thread/realtime/start`, `thread/realtime/appendAudio`, `thread/realtime/appendText`, `thread/realtime/stop`, `thread/realtime/listVoices`                                                                                                              |
| tools / permissions | `tool.approve`, `tool.deny`, `tool.cancel`, `elicitation.respond`, `permission.list`                                                                                                                                                                    |
| exec / fs           | `fs.fuzzy_search`, `commandExec.start`, `commandExec.write`, `commandExec.resize`, `commandExec.terminate`                                                                                                                                              |
| health / daemon     | `health.ping`, `health.ready`, `health.stats`, `daemon.reload`, `daemon.shutdown`                                                                                                                                                                       |
| auth                | `auth.login`, `auth.whoami`, `auth.logout`                                                                                                                                                                                                              |

`fs.fuzzy_search` accepts an optional `limit` from 1 through 1,000 and an
optional `refresh` flag that waits for a verified replacement index
generation. Persistent-index responses expose typed, additive `freshness` and
`matcher` metadata alongside typed file results. Clients should use the
metadata to distinguish an optimal fresh result from a stale, degraded, or
resource-limited one; an older daemon may omit both additive fields.

Raw `session.resolveToolCall` requests use a strict compatibility union. The
earlier `{ sessionId, toolCallId?, reviewer? }` shape can settle only a legacy
in-flight row with no durable effect record. Durable effects require the full
evidence shape (`toolCallId`, `disposition`, `evidenceRef`, and
`evidenceSha256`), and partial mixtures are rejected. An earlier-shape request
leaves durable effects unchanged in `remaining`.

Protocol version constant: **`1.9.0`**
(`AGENC_SDK_DAEMON_PROTOCOL_VERSION`). Handshake rules and
`PROTOCOL_VERSION_UNSUPPORTED` live in [daemon.md](reference/daemon.md).
The SDK retries initialization at a daemon running protocol 1.0 through 1.8 and
uses advertised capabilities for additive fallbacks. Protocol 1.6 made the
owning runtime options and live run-settings snapshot required in `agent.attach`.
Protocol 1.7 adds required inactive auto availability and exact-workspace bypass
capability and consent fields to that snapshot. The SDK rejects attachment
and session creation before dispatch on a negotiated protocol below 1.8. It
does not fall back to `session.create`, because that request cannot bind the
exact plugin storage root. Protocol 1.8 requires that root in the owning runtime
options and binds Core model and config mutation responses to the
runtime-settings event that follows them.
Protocol 1.9 adds the internal `session.shell.execute` method for Core. The
method is not in the SDK request union.

Server→client notifications (`AGENC_SDK_DAEMON_NOTIFICATION_METHODS`, 18 names):

| Group | Methods |
| --- | --- |
| Exec | `commandExec.outputDelta` |
| Turn / tools | `event.message_chunk`, `event.tool_request`, `event.permission_request`, `event.user_input_request`, `event.mcp_elicitation_request` |
| Status | `event.agent_status`, `event.session_event`, `event.mcp_status_changed` |
| Sync | `event.event_gap` (do not skip; resync from the durable cursor) |
| Realtime | `thread/realtime/started`, `itemAdded`, `transcript/delta`, `transcript/done`, `outputAudio/delta`, `sdp`, `error`, `closed` |

`session.mcp.status` is a passive, credential-free projection. The matching
`event.mcp_status_changed` notification carries only `{ sessionId, revision }`;
fetch the method after invalidation rather than treating the event as a tool or
connection object. Protocols 1.0–1.2 advertise the method as unavailable and do
not receive the notification. Invalidations are live-only and coalesced, so a
newly attached client fetches the snapshot instead of replaying status hints.
Reset the revision watermark when reconnecting to a replacement daemon.

The command-exec methods remain typed for protocol compatibility, but
`commandExec.start` currently returns `EXECUTION_ADMISSION_REQUIRED`: it cannot
start work until the RPC carries a daemon session-bound admission identity.
The server therefore advertises `commandExec.start: false`. It also advertises
`thread/realtime/start: false` while realtime provider traffic lacks the same
durable admission and usage contract; clients should use the initialize
capability map instead of treating registry membership as availability.

Important raw protocol additions:

| Shape                                       | Contract                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `EventUserInputRequestParams.clientAction`  | Optional trusted JSON action generated by Core, never by generic `request_user_input` model arguments                 |
| `RequestUserInputResponse.clientResult`     | Typed client result returned through `elicitation.respond`; Ledger receipts are challenge- and field-bound            |
| `ToolApproveParams.allowAllToolsForSession` | Valid only with `scope: "session"`; promotes the daemon session to `bypassPermissions` transactionally                |
| `SessionSetPermissionModeParams.bypassAuthority` | Optional `"operator_tool_approval"` only. Forwards explicit operator consent for a live switch to `bypassPermissions` in the session's exact cwd. Other strings are rejected before the route runs. Stored `/permissions accept-bypass` consent still satisfies the same gate. |
| `AuthWhoamiResult.subscriptionTier`         | Tier from the latest verified remote `/v1/auth/me` snapshot; identity also carries compatibility `plan` data          |
| `AuthLoginResult`                           | App-server login result contains non-secret state/identity only; the backend bearer is never returned over daemon RPC |

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

The SDK does not import runtime internals. These guards cover different parts
of the public surface:

| Layer | Authority | Guard |
| --- | --- | --- |
| Method registry and handwritten params/result maps | `packages/agenc-sdk/src/protocol.ts` | `runtime/tests/sdk-package/protocol-drift.contract.test.ts` compares `AGENC_SDK_DAEMON_METHODS` / `AGENC_SDK_DAEMON_NOTIFICATION_METHODS` to the runtime arrays (names **and** order) and requires a params/result map entry for every method |
| `session.transcript.v2` result shapes | `runtime/src/app-server/protocol/index.ts` | `check:sdk-generated-types` renders `transcript-v2.generated.ts` and compares the complete committed file after newline normalization |
| Workflow result contract markers | `runtime/src/entrypoints/sdk/coreSchemas.ts`, `coreTypes.generated.ts`, and `packages/agenc-sdk/src/workflow-result.generated.ts` | The same check requires selected version and outcome markers. It does not compare the complete file |
| Workflow handoff contract markers | `runtime/src/entrypoints/sdk/coreSchemas.ts` and `coreTypes.generated.ts` | The same check requires selected runtime handoff markers. It does not read or structurally compare `packages/agenc-sdk/src/workflow-handoff.generated.ts` |

`runtime/tests/sdk-package/workflow-handoff.contract.test.ts` supplies separate
behavioral coverage. It compares selected public constants with runtime values
and exercises the public validator against runtime and schema validators. No
current check compares every field, optional marker, union, declaration order,
or export in the public workflow-handoff mirror. [#1941](https://github.com/tetsuo-ai/agenc-core/issues/1941)
tracks a generated structural parity check.

Changes covered by these guards fail the check until the mirrored or
marker-checked content is updated. `SessionTranscriptV2Params` stays
handwritten (`{ sessionId }`); only the four result interfaces are generated.

### Transcript v2 generated mirror

`runtime/scripts/check-sdk-generated-types.mjs` extracts these daemon
interfaces, which must `extend JsonObject`:

- `SessionTranscriptV2Message`
- `SessionTranscriptV2ActiveTurn`
- `SessionTranscriptV2TurnResult`
- `SessionTranscriptV2Result`

It rewrites the heritage to a local `TranscriptV2JsonObject` so the SDK
stays zero-dependency, then compares against
`packages/agenc-sdk/src/transcript-v2.generated.ts`. The checker does **not**
write the file. The current refresh is a synchronized manual replacement from
the runtime authority. The generated header's `Do not edit` instruction means
that its public shapes must not change independently of that authority.

Refresh after a protocol edit:

1. Keep those four interfaces `extends JsonObject`. Any other heritage fails
   the check.
2. Manually replace the committed generated module from the updated runtime
   declaration text. Keep the three-line `@generated` header and the local
   `TranscriptV2Json*` aliases; copy the four declarations in that order,
   changing `extends JsonObject` to `extends TranscriptV2JsonObject`. Preserve
   property order, member comments, optionality, and unions.
3. Run `npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types`.
4. `runtime/tests/sdk-package/transcript-v2.contract.test.ts` also compares
   property names/types of `SessionTranscriptV2TurnResult` and
   `SessionTranscriptV2Result`, and asserts `transcriptV2()` preserves a
   typed `turnResults` payload.

Constraints:

- Comparison is exact after a single `CRLF` / bare `CR` to `LF` pass on both
  the runtime authority and the committed file. Windows checkouts must pass
  the same content. Do not change line endings solely to satisfy the check.
- Changes to fields, optionality, unions, member comments, or ordering inside
  the extracted interface declarations fail until the generated file is
  refreshed. Leading interface JSDoc is outside the extracted declaration
  text and is not mirrored or checked.
- Closed-turn field semantics (omit-when-empty, token sums, placement)
  stay in [daemon.md](reference/daemon.md#closed-turn-results). This page
  only covers how the types stay in sync.

| Symptom | What to check |
| --- | --- |
| `is not the exact generated transcript.v2 mirror` | Protocol interfaces changed and the committed file was not refreshed, or a member comment, property order, or optional marker changed |
| Same failure on Windows only | The check already normalizes `CRLF` / `CR` to `LF` on both sides. A leftover exact-byte compare is the usual cause; checkout line endings are not |
| `must extend JsonObject` | A mirrored interface dropped or changed its heritage |
| `transcriptV2()` type-checks but a new field is only `JsonObject` | The generated file was not refreshed; `protocol.ts` re-exports those interfaces |

Event semantics (streamed text extraction, terminal-status detection) mirror
the CLI's daemon one-shot path in `runtime/src/bin/agenc-main.ts`
(`daemonOneShotMessageChunk` / `daemonOneShotFinalStatus`), so an embedder
sees the same output and completion behavior as `agenc -p`.

## Tests

`runtime/tests/sdk-package/`:

- `protocol-drift.contract.test.ts` — mirror pinned to the runtime registry.
- `transcript-v2.contract.test.ts` compares generated result shapes with the
  daemon protocol and checks that `transcriptV2()` preserves typed `turnResults`.
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

## Errors

Thrown by `connect()`, `AgencClient`, and `promptViaSubprocess`
(`packages/agenc-sdk/src/client.ts`):

| Class | When |
| --- | --- |
| `AgencRpcError` | JSON-RPC error object from the daemon. Fields: `code`, `data`, `method`, `requestId` |
| `AgencMalformedResponseError` | Response body is not a valid result for the method. Field: `response` |
| `AgencPromptRunInProgressError` | Second `prompt()` on a session that already has an active run (`ifBusy: "reject"` or equivalent). Fields: `sessionId`, `clientMessageId` |
| `AgencDuplicateSubmissionIncompleteError` | Reused `clientMessageId` whose prior submit has no durable terminal outcome |
| `AgencCapabilityUnavailableError` | Caller asked for a protocol 1.2 (or later) guarantee the negotiated daemon does not have |
| `AgencRunReplayGapError` | Replay cursor hit an explicit `event_gap` / `cursor_ahead` / retention gap. Do not skip it |
| `AgencRunReplayProtocolError` | Replay page would hide loss or corruption |

Internal workbench RPCs (`workspace.editor.*`) are not on this client. See
[daemon.md](reference/daemon.md) internal methods.

## Related

- Package README: [`packages/agenc-sdk/README.md`](../packages/agenc-sdk/README.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Channel gateway (SDK consumer): [`gateway.md`](gateway.md)
- Env vars: [`reference/env.md`](reference/env.md)
