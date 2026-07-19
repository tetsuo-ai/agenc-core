# @tetsuo-ai/agenc-sdk

**0.2.0** — typed, zero-dependency embedding SDK for the AgenC daemon protocol.

Node **>=25.9 <26** · ESM only · plain `tsc` build · no runtime dependencies.

## Surfaces

| API | What it does |
| --- | --- |
| `connect()` | Attach to (or CLI-start) the local daemon over `~/.agenc/daemon.sock`. Typed `createSession()` / `prompt()` event streams, permission + elicitation callbacks, background-agent spawn/attach/stop/logs. |
| `promptViaSubprocess()` | Same event-iterable interface over `agenc -p --output-format stream-json` with no daemon socket access from your process. |
| `client.runStatus` / `runResult` / `replayRun` / `runEvidence` / `cancelRun` | Read durable run/admission state, replay or hash canonical journal evidence, or cancel a run tree. |
| `client.reattachRun({ runId, afterSequence })` | Catch up from a durable cursor, suppress and report duplicate delivery, stop on any explicit replay gap, and fetch the durable terminal result after reconnect. |
| `client.request(method, params)` | Raw typed JSON-RPC for all **45** public daemon methods (mirrored in `./protocol`). |

The protocol mirror preserves trusted `event.user_input_request.clientAction`
objects, typed `elicitation.respond.clientResult` receipts,
`ToolApproveParams.allowAllToolsForSession`, and remote subscription-tier
identity fields. `connect()` advertises no mobile capabilities by default: it
does not opt a generic embedder into global status or Ledger signing delivery.

```js
import { connect, promptViaSubprocess } from "@tetsuo-ai/agenc-sdk";

const client = await connect({
  onPermissionRequest: async (req) =>
    req.toolName === "Read"
      ? { behavior: "allow", scope: "once" }
      : { behavior: "deny" },
});
const session = await client.createSession();
const run = session.prompt("Summarize the protocol layer.");
for await (const event of run) {
  if (event.type === "text") process.stdout.write(event.delta);
}
console.log(await run.result());
await client.close();
```

## Defaults

- Socket: `${AGENC_HOME:-~/.agenc}/daemon.sock`
- Cookie: `${AGENC_HOME:-~/.agenc}/daemon.cookie` (first message must be `initialize` with `authCookie`; `connect()` handles this)
- Autostart: runs `agenc daemon start` when the socket is down (disable with `autostart: false`)

## Docs & example

- Full documentation: [`docs/sdk.md`](../../docs/sdk.md)
- Durable run/effect/replay contract:
  [`docs/design/durable-runs-effects-events.md`](../../docs/design/durable-runs-effects-events.md)
- Runnable example: [`examples/one-shot.mjs`](./examples/one-shot.mjs)

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk
node packages/agenc-sdk/examples/one-shot.mjs "say hello in one word"
node packages/agenc-sdk/examples/one-shot.mjs --transport subprocess "say hello"
```

Protocol drift is pinned by `runtime/tests/sdk-package/protocol-drift.contract.test.ts`
against the runtime's canonical method registry.

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
