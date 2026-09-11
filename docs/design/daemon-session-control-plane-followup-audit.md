# Daemon/session control-plane follow-up audit

Date: 2026-09-11. Baseline: `de33e0185245179a0a7f3f2fcf4e25eeaa3b2689`.

## Scope

Three parallel investigations audited daemon shutdown and transport scheduling,
session attachment authority, and SDK/TUI submission ownership. Integration review
followed those operations across real dispatch, routing, session lifecycle, and
local transports. This extends the [initial audit](daemon-session-control-plane-audit.md).

## Confirmed defects and repairs

| Boundary | Reproduction | Repair |
| --- | --- | --- |
| Attachment acquisition → rollback | A creator blocks on its runner snapshot; another attach succeeds; the creator fails and removes the adopted attachment or entire client. | Session lifecycle tracks pending owners and committed adoption. Routing shares the acquisition token, and client removal checks other sessions and pending attachments atomically. |
| Concurrent acquisition → failure | Two attempts acquire one provisional attachment, then both fail in either order. | The last failing owner releases uncommitted state. A successful adoption remains valid independently of other failures. Revoked attachments cannot commit. |
| Capability replay → session termination | Replay blocks, a session terminates and shifts its buffer, a new action arrives, then replay succeeds. Positional deletion removes the new action. | Completion retires exactly the buffered objects in the replay receipt. New actions survive for the next capable client. |
| SDK attach replay → prompt admission | Historical events for a reused message ID arrive during attach, invoking stale approvals or settling a new prompt before the daemon validates it. | Prompt-scoped listeners become active at that prompt's submission dispatch boundary. Duplicate and conflicting submissions receive the daemon's current decision. |
| TUI submission → input restoration | One submission fails after an editor submission consumes or rolls back entries retained in the shared input queue. | Failure restores only entries drained by that submission and retained entries still present. It preserves later arrivals and queue order. |
| Initialization → priority scheduling | A second initialize queues behind a running stream and replaces the barrier that cancellation waits on. Priority traffic can also accumulate without transport queue accounting during authentication. | The first initialize establishes the barrier once. Separate bounded priority and control lanes preserve cancellation capacity before dispatcher admission. |
| Shutdown acceptance → cleanup | An acknowledgement never settles, or a noncancellable snapshot waits for runner teardown while transport shutdown waits for that snapshot. | Acknowledgement waiting has a deadline. Connection cancellation, command cleanup, and runner shutdown precede transport handler draining, which has a bounded daemon fallback. |

## Ownership rules

The session manager is the attachment authority; multiplexer routes project that
state. Internal symbol tokens never enter protocol payloads. Repeated acquisition
within one attach uses the same token. Commit records successful adoption;
rollback releases only that attempt's claim. Neither route creation nor client
registration alone proves that a failing attempt still owns the resource.

Shutdown fences ingress before draining work. Actor teardown precedes handlers
that can depend on it. Default standalone transport close still waits for its
handlers; the foreground daemon explicitly applies a five-second drain deadline
after actor cleanup. It retains ownership of actor teardown until that work
settles, rather than abandoning live work when a timer expires. Shutdown selects
known actors directly without first waiting for diagnostic runner snapshots.
Cleanup reports drain failures while proceeding through the remaining registry.

## Verification

Regression tests use explicit gates to establish the failing interleavings.
Connected SDK/TUI cases compose in-process transport, dispatcher, multiplexer,
and session lifecycle. Transport cases use real local sockets; foreground tests
exercise daemon cleanup and authority release.

```sh
npm run validate:runtime
npm run build --workspace=@tetsuo-ai/agenc-sdk
npm --workspace=@tetsuo-ai/runtime test -- tests/app-server tests/app-server-client tests/sdk-package tests/tui/daemon-session --maxWorkers=2
```

Final results on Node 26.5.0. The runtime validation and Docker suite were
repeated after rebasing onto `e17f0df990605ade7cd4e49915ac3529bde489b0`:

| Check | Result |
| --- | --- |
| Linux Docker control-plane boundary | 135 files, 1,792 tests passed; expected-red boundary probe passed. |
| Runtime and test-support TypeScript checks | Passed. |
| Runtime build, package entrypoints, generated protocol checks | Passed. |
| SDK build and TypeScript check | Passed. |
| Built runtime/TUI imports and PTY startup | Passed in normal and bypass modes at 148×40, 120×30, and 80×24. |
| Local required-gate tests | 162 passed. |
| Patch whitespace check | `git diff --check` passed. |

The earlier shared checkout's worktree status remained unchanged. Its existing
`AGENTS.md` was preserved. GitHub CI was not run.

These checks exercise local lifecycle behavior with deterministic runner/provider
fixtures; they do not establish live provider reliability or behavior on untested
hosts. An uncooperative runner still requires its actual teardown to settle
before daemon stores close; transport deadlines do not abandon that ownership.
