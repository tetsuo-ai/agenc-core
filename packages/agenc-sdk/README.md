# @tetsuo-ai/agenc-sdk

**0.2.0** — typed, zero-dependency embedding SDK for the AgenC daemon protocol.

Node ≥ 25 · ESM only · plain `tsc` build · no runtime dependencies.

## Surfaces

| API | What it does |
| --- | --- |
| `connect()` | Attach to (or CLI-start) the local daemon over `~/.agenc/daemon.sock`. Typed `createSession()` / `prompt()` event streams, permission + elicitation callbacks, background-agent spawn/attach/stop/logs. |
| `promptViaSubprocess()` | Same event-iterable interface over `agenc -p --output-format stream-json` with no daemon socket access from your process. |
| `client.request(method, params)` | Raw typed JSON-RPC for all **41** public daemon methods (mirrored in `./protocol`). |

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
- Runnable example: [`examples/one-shot.mjs`](./examples/one-shot.mjs)

```bash
npm run build --workspace=@tetsuo-ai/agenc-sdk
node packages/agenc-sdk/examples/one-shot.mjs "say hello in one word"
node packages/agenc-sdk/examples/one-shot.mjs --transport subprocess "say hello"
```

Protocol drift is pinned by `runtime/tests/sdk-package/protocol-drift.contract.test.ts`
against the runtime's canonical method registry.
