# Daemon/session control-plane audit

Date: 2026-09-10

## Scope and ownership

This implementation audit followed transport ingress, JSON-RPC dispatch,
session/agent lifecycle, notification routing, TUI cancellation, and SDK prompt
completion. Three parallel investigations covered daemon transports, session
authority, and clients; integration review covered their shared boundaries.

The ownership chain is:

1. A physical connection owns authentication, RPC requests, and logical clients.
2. A logical client owns session attachments and notification delivery.
3. The daemon owns the live agent and its explicitly bound sessions.
4. A turn ID identifies the execution a cancellation may interrupt.
5. Session closure revokes ingress; resource finalization establishes cleanup
   completion and may need retrying.

## Confirmed defects and repairs

| Boundary | Defect | Repaired invariant |
| --- | --- | --- |
| Transport → dispatcher | Queued frames or delayed authentication dispatched after disconnect. | Socket closure and authentication deadlines permanently fence further dispatch. Unix shutdown closes all peers before draining handlers. |
| Dispatcher → attachments | Initialization and registration could complete after close; late cleanup could remove a reconnect's reused client ID. | Connection closure is terminal, initialization is reserved synchronously, registration records ownership before replay, cleanup checks the physical connection identity, and failed repeat attachment preserves preexisting resources. |
| Session → routing | Finalization ran under the global routing mutex. | Resource callbacks run outside that mutex, allowing callbacks and unrelated clients to use routing. |
| Session → resources | Closed sessions skipped a failed finalizer; concurrent termination could report success before cleanup. | Termination closes once, shares pending finalization, and permits retry after failure without replacing the original close reason. |
| Agent → runtime | Concurrent stops could duplicate teardown; stopping state suppressed canonical runner terminal evidence. | Stop has one owner, shutdown drains that owner, and terminal evidence remains authoritative during stopping. |
| Session → agent | An unbound session could name another live agent and reach its runtime. | Runtime operations require membership in the agent's authoritative session list. |
| TUI → turn | Session-wide ESC could cancel a successor; stale status could clear a newer active turn. | Cancellation names an observed turn; pre-start intent waits for its own submission correlation. Stale terminal status cannot clear another turn; a validated terminal RPC result settles missing live completion. |
| SDK → prompt | Client closure left prompt results pending; delayed approval callbacks could act after completion. | Closure settles local waiters, and completion revokes deferred prompt callbacks. Closing a client does not itself request daemon turn termination. |
| Shutdown/eviction → socket | Failed shutdown acknowledgements stranded the daemon; eviction removed maps without closing the socket. | Accepted shutdown completes after acknowledgement attempts settle; eviction terminates the actual transport. |

## Verification strategy

Regression tests control authentication, registration, runner teardown, and
submission ordering with explicit gates. Socket tests exercise real local Unix
and WebSocket connections, including foreground-daemon eviction. SDK composition
tests connect the real SDK, in-process transport, dispatcher, session manager,
and multiplexer with deterministic runner behavior.

Run the connected control-plane suites with the repository's hermetic boundary:

```sh
npm --workspace=@tetsuo-ai/runtime test -- tests/app-server tests/app-server-client tests/sdk-package tests/tui/daemon-session --maxWorkers=2
npm run typecheck
npm run build
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
```

Final verification results:

| Check | Result |
| --- | --- |
| Linux Docker control-plane boundary, command above | 128 files, 1,754 tests passed; expected-red boundary probe also passed. |
| Runtime typecheck and test-support typecheck | Passed. |
| Runtime build, package entrypoints, generated SDK protocol checks | Passed. |
| SDK build and TypeScript check | Passed. |
| Built runtime/TUI import proofs and PTY startup | Passed in normal and bypass modes at 148×40, 120×30, and 80×24. |
| `npm run test:required-gates` | 162 tests passed. |
| Launcher suite | 235 of 236 passed; one preexisting installer-site configuration assertion failed. |

The launcher failure is outside these changes:
[`runtime-release-contract.test.mjs`](../../packages/agenc/test/runtime-release-contract.test.mjs)
expects only `headers` and `redirects`, while the committed
[`installer configuration`](../../packaging/get-agenc-ag/vercel.json) also has
`git`. Both files were unchanged by this work; the same mismatch exists at HEAD.

These checks cover local control-plane behavior. They do not establish live
provider reliability or platform-specific kernel behavior on hosts not exercised
by the test run. Existing detached-session replay and stdio EOF-drain contracts
remain part of the regression suite.
