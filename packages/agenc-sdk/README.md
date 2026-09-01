# @tetsuo-ai/agenc-sdk

**0.3.0** — typed, zero-dependency embedding SDK for the AgenC daemon protocol.

Node **>=26.5 <27** · ESM only · plain `tsc` build · no runtime dependencies.

## Surfaces

| API                                                                          | What it does                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect()`                                                                  | Attach to (or CLI-start) the local daemon over its Unix socket or Windows named pipe. Typed `createSession()` / `prompt()` event streams, permission + elicitation callbacks, background-agent spawn/attach/stop/logs. |
| `promptViaSubprocess()`                                                      | Same event-iterable interface over `agenc -p --output-format stream-json` with no daemon socket access from your process.                                                                                              |
| `client.runStatus` / `runResult` / `replayRun` / `runEvidence` / `cancelRun` | Read durable run/admission state, replay or hash canonical journal evidence, or cancel a run tree.                                                                                                                     |
| `client.reattachRun({ runId, afterSequence })`                               | Catch up from a durable cursor, suppress and report duplicate delivery, stop on any explicit replay gap, and fetch the durable terminal result after reconnect.                                                        |
| `client.request(method, params)`                                             | Raw typed JSON-RPC for all **53** public daemon methods (mirrored in `./protocol`).                                                                                                                                    |
| `client.listCsvJobReviews` / `showCsvJobReview` / `resolveCsvJobReview`      | Typed CSV unknown-outcome review helpers (`csvJob.review.*`).                                                                                                                                                          |

Errors: `AgencRpcError`, `AgencMalformedResponseError`,
`AgencPromptRunInProgressError`, `AgencDuplicateSubmissionIncompleteError`,
`AgencCapabilityUnavailableError` (1.2 fail-closed), `AgencRunReplayGapError`,
`AgencRunReplayProtocolError`. Full table: [`docs/sdk.md`](../../docs/sdk.md).

Prompt events on protocol 1.2 also include `message_committed`,
`history_reset`, `elicitation_request`, `gap`, and `session_event`. The sample
loop below only prints `text`.

The protocol mirror preserves trusted `event.user_input_request.clientAction`
objects, typed `elicitation.respond.clientResult` receipts,
`ToolApproveParams.allowAllToolsForSession`, and remote subscription-tier
identity fields. `connect()` advertises no mobile capabilities by default: it
does not opt a generic embedder into global status or Ledger signing delivery.

Daemon prompts reserve one local run per session synchronously and use a
stable `clientMessageId` for correlation/idempotent retry. Protocol 1.2 adds
opt-in `ifBusy: "reject"`, turn-scoped cancellation, identity-bearing
`transcriptV2()` (including additive closed-turn `turnResults` on current
daemons), distinct delta/committed assistant events, and
`history_reset`. The SDK capability-falls back when initialization discovers a
1.0 through 1.8 daemon. Protocol 1.8 makes complete owning runtime authority,
including the exact plugin storage root, part of `agent.create` and
`agent.attach`. The SDK refuses attachment and session creation before dispatch
on an older daemon. It does not fall back to `session.create`, which cannot bind
that root. Strict admission and scoped prompt cancellation fail closed when
those guarantees are unavailable.
Protocol 1.9 adds a Core-only admitted shell method; it is not exposed by the
SDK request union.

```js
import { connect, promptViaSubprocess } from "@tetsuo-ai/agenc-sdk";

const client = await connect({
  onPermissionRequest: async (req) =>
    req.toolName === "Read"
      ? { behavior: "allow", scope: "once" }
      : { behavior: "deny" },
});
const session = await client.createSession({
  pluginStorageRoot: "/absolute/agenc-home/plugins",
});
const run = session.prompt("Summarize the protocol layer.");
for await (const event of run) {
  if (event.type === "text") process.stdout.write(event.delta);
}
console.log(await run.result());
await client.close();
```

## Defaults

- Local endpoint: `${AGENC_HOME:-~/.agenc}/daemon.sock` on Unix; a stable per-home named pipe on Windows
- Cookie: `${AGENC_HOME:-~/.agenc}/daemon.cookie` (first message must be `initialize` with `authCookie`; `connect()` handles this)
- Plugin storage: `createSession()` requires an exact absolute `pluginStorageRoot` of at most 4096 UTF-8 bytes, with no surrounding whitespace. `AgencClient` does not reread `AGENC_PLUGIN_CACHE_DIR`, derive a root from `AGENC_HOME`, or accept `agentId`; use `attachAgent()` for an existing agent.
- Autostart: runs `agenc daemon start` when the socket is down (disable with `autostart: false`)
- Hook authority: `createSession()` sends `allowUntrustedHooks: false`. A caller using `spawnAgent()` must send complete runtime options and may set the field to `true` only after vetting the workspace. It permits command effects only and cannot override `simpleMode` hook suppression.
- Home authority: `AGENC_HOME` must be absolute and is canonicalized before daemon paths are derived. Explicit socket and cookie paths do not bypass home-authority validation.

`promptViaSubprocess()` invokes `agenc -p`. The child captures
`AGENC_ALLOW_UNTRUSTED_HOOKS` from `options.env`, or from its inherited
environment when `options.env` is omitted, at automation startup.

## Docs & example

- Full documentation: [`docs/sdk.md`](../../docs/sdk.md)
- Doc map: [`docs/INDEX.md`](../../docs/INDEX.md)
- Durable run/effect/replay contract:
  [`docs/design/durable-runs-effects-events.md`](../../docs/design/durable-runs-effects-events.md)
- Runnable example: [`examples/one-shot.mjs`](./examples/one-shot.mjs)

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk
AGENC_PLUGIN_CACHE_DIR=/absolute/path/to/agenc/plugins \
  node packages/agenc-sdk/examples/one-shot.mjs "say hello in one word"
node packages/agenc-sdk/examples/one-shot.mjs --transport subprocess "say hello"
```

Protocol drift is pinned by `runtime/tests/sdk-package/protocol-drift.contract.test.ts`
against the runtime's canonical method registry.
`session.transcript.v2` result shapes are generated from the daemon protocol
into `src/transcript-v2.generated.ts` and checked by
`npm --workspace=@tetsuo-ai/runtime run check:sdk-generated-types`
(see [`docs/sdk.md`](../../docs/sdk.md#transcript-v2-generated-mirror)).
Workflow-result types in `src/workflow-result.generated.ts` are marker-checked
by the same command, not an exact file compare
(see [`docs/sdk.md`](../../docs/sdk.md#workflow-result-generated-mirror)).

## Durable reconnect

Persist the attachment cursor after each processed event (or after finite
catch-up iteration). A new client can resume from that exact exclusive
sequence:

```js
import { AgencRunReplayGapError, connect } from "@tetsuo-ai/agenc-sdk";

const client = await connect();
const attachment = client.reattachRun({
  runId,
  afterSequence: savedAfterSequence ?? 0,
  onDuplicate: ({ event }) => console.warn("duplicate", event.eventId),
});

try {
  for await (const event of attachment) {
    console.log(event.sequence, event.eventId, event.category, event.event);
  }
  await saveCursor(attachment.cursor());
} catch (error) {
  if (error instanceof AgencRunReplayGapError) {
    // The cursor stops at the last event yielded before the gap. Reconcile the
    // missing range before choosing a new cursor; the SDK never jumps it.
    console.error(error.gap);
  } else {
    throw error;
  }
}

const terminal = await attachment.result();
if (terminal.output.available) console.log(terminal.output.finalMessage);
await client.close();
```

Every canonical replay event has a durable `eventId` and root-run `sequence`.
The attachment drops exact duplicates and reports them through `onDuplicate`;
identity reuse with different data, out-of-order pages, and cursor jumps without
an explicit gap fail closed with `AgencRunReplayProtocolError`.

Exact fingerprints for the most recent 1,024 delivered events are retained by
default (`identityWindow` can be 1..100,000). Older event IDs remain in a
fixed-memory fail-closed membership filter: reuse is rejected, while a filter
collision can only reject a new event. A newly reconnected attachment cannot
verify data at or before its supplied exclusive cursor, so such delivery is a
protocol error rather than an assumed duplicate.

For a pre-M4 daemon/run with only the project-scoped admission journal,
`replayRun()` returns the original M3 event fields. Use
`isRunAdmissionReplayResult(page)` to narrow that compatibility source while
canonical M4 pages retain the generalized `RunJournalEvent` envelope.
