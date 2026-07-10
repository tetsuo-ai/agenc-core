# AgenC Embedding SDK (`@tetsuo-ai/agenc-sdk`)

Package: `packages/agenc-sdk` · version **0.2.0** · Node ≥ 25 · ESM only · zero runtime dependencies.

The SDK embeds AgenC in another application without importing runtime internals.
It speaks the daemon's JSON-RPC protocol over a hand-mirrored type surface
pinned by a drift test (see [Protocol mirror & drift guard](#protocol-mirror--drift-guard)).

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk   # plain tsc → dist/
```

## Two transports

| | daemon transport | subprocess transport |
|---|---|---|
| entry | `connect()` → `AgencClient` | `promptViaSubprocess()` |
| wire | JSON-lines over `~/.agenc/daemon.sock` | `agenc -p --output-format stream-json --input-format stream-json` |
| sessions | persistent, resumable, multi-turn | one-shot per spawn |
| permission callbacks | yes (approve or deny live) | no — CLI auto-denies (exit code 2 = tool-denied giveup) |
| background agents | spawn / attach / stop / logs | no |
| daemon required | attaches, or starts one via the CLI | the CLI manages its own daemon |

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
- `request(method, params)` → raw typed JSON-RPC for any of the **41** daemon methods
- `onNotification(cb)` / `onSessionNotification(sessionId, cb)` → raw events

Permission requests with no registered handler are **denied** (never granted)
so an unattended embedder can't hang a turn, mirroring `agenc -p`.
Elicitations (`event.user_input_request` / `event.mcp_elicitation_request`)
route to `onElicitationRequest`; return the response object for
`elicitation.respond`, or `null` to leave it unanswered.

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
  agencCommand: "agenc",      // or ["/abs/path/agenc"]
  model: "grok-4",             // optional; also provider/profile/permissionMode
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

## Daemon method surface (41 methods)

Mirrored in `packages/agenc-sdk/src/protocol.ts` as `AGENC_SDK_DAEMON_METHODS`
(order pinned to the runtime registry):

| Group | Methods |
| --- | --- |
| lifecycle | `initialize`, `request.cancel` |
| agents | `agent.create`, `agent.list`, `agent.attach`, `agent.stop`, `agent.logs` |
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

```bash
cd runtime && npx vitest run tests/sdk-package
```

## Related

- Package README: [`packages/agenc-sdk/README.md`](../packages/agenc-sdk/README.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Channel gateway (SDK consumer): [`gateway.md`](gateway.md)
