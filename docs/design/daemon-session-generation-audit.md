# Daemon/session generation audit

Date: 2026-09-11. Baseline: `59256ba756e3`.

## Scope

Three parallel investigations followed transport lifecycle, runner/session
authority, and SDK submission handling. Integration review traced those findings
through the dispatcher, multiplexer, persistence callbacks, and connected client
flows. This extends the [previous audit](daemon-session-control-plane-followup-audit.md).

## Confirmed defects and repairs

| Boundary | Reproduction | Repair |
| --- | --- | --- |
| Listener startup → shutdown | Close completes while Unix path preparation or WebSocket address publication is pending; the listener can appear afterwards. Competing Unix startups can both acquire ownership. | Startup reserves ownership synchronously. Close fences admission, joins the pending startup, and releases its listener before completing. |
| Concurrent close → restart | A second close returns while the first still drains handlers; restart can overlap that cleanup. In-process close can hide a pending cleanup failure. | Concurrent closes share completion. Network transports reject restart during cleanup; in-process close retains its terminal cleanup result, including rejection. |
| Retired runner → replacement | A terminal callback outlives the runner's notification deadline or a failed restore, then stops a replacement with the same canonical agent ID. Early callbacks can also overwrite another generation's pending terminal. | Concrete runners attach an internal runtime generation to starts, restores, snapshots, and terminal callbacks. Lifecycle state and pending terminals match that generation before applying observations. |
| Terminal persistence → cold resume | An old terminal finalizer waits on persistence while the canonical agent is resumed, then writes stopped status over the replacement. | Finalizers retain the originating lifecycle object and recheck ownership before starting subsequent status writes. Awaited callbacks run outside the lifecycle lock; captured old sessions still receive cleanup. |
| Request cancellation → runner failure | A cancelled or disconnected legacy message request launches an interruption that later rejects without an observer. | The dispatcher observes this best-effort interruption separately from the already-settled request, containing failures to that operation. |
| Delayed replay → SDK result | Replayed events arrive after submission dispatch. Conflicting content can trigger stale approvals, or a terminal can settle successfully before the submission RPC rejects. | The SDK checks available durable message content against the submitted JSON value and holds terminal completion until RPC validation. Rejection and connection close still settle pending handles; live approvals remain available before RPC completion. |

## Ownership rules

A canonical agent ID and durable run epoch do not identify a live runtime
incarnation. A fresh start receives a random generation; a restore uses its
attempt identity, retained independently after the publication rollback token is
cleared. These fields stay internal and do not change the daemon wire protocol.
Injected legacy runners may omit them for compatibility; generation protection
requires an identity-bearing observation.

Transport ownership spans asynchronous startup and cleanup. Clearing a listener
field alone does not prove that close has finished. Existing handler-drain
semantics remain: standalone network close waits by default, while foreground
daemon shutdown uses its configured deadline after actor cleanup.

SDK notification ownership requires submission dispatch and a matching durable
message marker. JSON comparison must use serialized values because transport can
change object prototypes and omit undefined properties. Terminal notifications
remain provisional until the submission response validates admission. After
validation, a matching live terminal preserves existing result semantics; the
RPC terminal is the fallback. Deferring all notifications would prevent approval
responses that the running submission itself needs.

## Verification

Regressions use explicit gates to establish the failing ordering. Coverage
includes real Unix/WebSocket listeners, dispatcher-backed in-process clients,
the concrete runner's terminal-notification timeout, and a cold resume verified
against a real rollout file. Cancellation cases exercise both message methods
under explicit cancellation and disconnect.

```sh
npm run validate:runtime
npm run build --workspace=@tetsuo-ai/agenc-sdk
node runtime/scripts/run-hermetic-test-boundary.mjs run tests/app-server tests/app-server-client tests/sdk-package tests/tui/daemon-session --maxWorkers=2
npm run test:required-gates
git diff --check
```

Final results on Node 26.5.0. Runtime validation, the SDK build, and the Docker
boundary were repeated after rebasing onto `6f7cb42d2` before publication:

| Check | Result |
| --- | --- |
| Linux Docker control-plane boundary | 139 files, 1,816 tests passed, including 24 new regression cases; no skipped tests. Expected-red boundary probe passed. |
| Runtime and test-support TypeScript checks | Passed locally and inside the Docker boundary. |
| Runtime build, package entrypoints, generated protocol checks | Passed. |
| SDK build, generated types, and TypeScript check | Passed after the final JSON normalization repair. |
| Built runtime/TUI imports and PTY startup | Passed in normal and bypass modes at 148×40, 120×30, and 80×24. |
| Local required-gate tests | 162 passed. |
| Patch whitespace check | `git diff --check` passed. |

The original checkout's status and content hashes for its 57 unrelated modified
files are unchanged; its existing `AGENTS.md` is preserved. All execution was
local; GitHub CI was not run. Hermetic runner/provider
fixtures verify lifecycle behavior, not live provider reliability or untested
platforms.
