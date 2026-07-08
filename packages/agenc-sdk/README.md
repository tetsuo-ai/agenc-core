# @tetsuo-ai/agenc-sdk

Typed, zero-dependency embedding SDK for the AgenC daemon protocol.

- `connect()` — attach to (or CLI-start) the local daemon over
  `~/.agenc/daemon.sock`; typed `createSession()` / `prompt()` event
  streams, permission callbacks, background-agent spawn/attach.
- `promptViaSubprocess()` — same event-iterable interface over
  `agenc -p --output-format stream-json` with no daemon socket access.

Full documentation: [`docs/sdk.md`](../../docs/sdk.md) at the repository
root. Runnable example: [`examples/one-shot.mjs`](./examples/one-shot.mjs).
