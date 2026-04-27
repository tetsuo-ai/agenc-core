# Runtime Sidecar / Observer Compatibility Gate

This note freezes the current sidecar and observer ordering contract
for the AgenC runtime replacement work. It is a compatibility record,
not a redesign document: if a future change wants different semantics,
it must do so intentionally and update the tests named below.

## Scope

This gate covers the live behavior currently implemented in:

- `runtime/src/session/sidecar.ts`
- `runtime/src/session/observer-wiring.ts`
- `runtime/src/session/mcp-startup.ts`
- `runtime/src/session/cost.ts`
- `runtime/src/session/session-store.ts`
- `runtime/src/bin/agenc.ts`

The risky edges are attach order, startup/shutdown ordering, degraded
mode isolation, and the drop/duplicate rules around observer-produced
events.

## Frozen Semantics

### 1. Sidecar subscriptions are live-only; there is no backfill

- `EventLog.subscribe()` only registers a listener for future emits.
- `SidecarManager.start()` runs `sidecar.start()` before it installs the
  event-log subscription for that sidecar.

Consequences:

- events emitted before `SidecarManager.start(log)` are invisible to all
  sidecars
- events emitted during a sidecar's own `start()` are invisible to that
  same sidecar
- later sidecars do not receive startup-time events retroactively
- earlier sidecars can observe startup-time events emitted by later
  sidecars because those earlier sidecars are already subscribed

Pinned by:

- `runtime/src/session/sidecar.test.ts`

### 2. Registration order is the startup, dispatch, and shutdown order

- `SidecarManager` stores sidecars in insertion order.
- `EventLog` listener dispatch preserves listener insertion order.
- `SidecarManager.stop()` unsubscribes each sidecar before calling that
  sidecar's `stop()` hook.

Consequences:

- steady-state event delivery is registration ordered
- earlier sidecars do not observe their own shutdown-time emissions once
  `stop()` begins
- later sidecars may still observe shutdown-time emissions from earlier
  sidecars because those later listeners have not yet been removed

Pinned by:

- `runtime/src/session/sidecar.test.ts`
- `runtime/src/session/cost-persistence.test.ts`

### 3. Observer slots drop while empty and never replay

- Slot-bound observers are allowed to exist before a `Session` exists.
- `slot.current === null` means "drop now".
- Filling the slot later only affects future observer callbacks.

Consequences:

- there is no queue, retry, or replay for `mcp_tool_call_*` /
  `exec_command_*` events dropped before the session is bound
- observer dispatch uses the slot contents at callback time, not at
  observer-construction time

Pinned by:

- `runtime/src/session/observer-wiring.test.ts`

### 4. MCP observer attach must happen before manager startup

- `attachMcpManagerToSession()` is the canonical attach seam.
- It fills an empty slot, but it does not overwrite a non-null slot.
- `MCPManager.connectServer()` passes the current `callObserver` into
  `createToolBridge()`.
- Each bridge's tool `execute()` closure captures that observer at
  bridge-creation time.

Consequences:

- attaching before `manager.start()` covers the first bridge and every
  bridge created during that startup
- attaching after `manager.start()` does not retrofit already-created
  bridges; it only affects bridges created later

Pinned by:

- `runtime/src/session/mcp-startup.test.ts`

### 5. Sidecars stop before the session closes the event log

- The CLI shutdown path in `runtime/src/bin/agenc.ts` stops the
  `SidecarManager` before calling `session.shutdown()`.
- `CostSidecar.stop()` finalizes the current session and writes its
  snapshot during that sidecar-manager stop phase.

Consequences:

- sidecar shutdown-time diagnostics can still land in the event log
- cost persistence sees the final pre-shutdown event stream
- events emitted after sidecar shutdown are intentionally ignored by the
  cost sidecar because it has already unsubscribed

Pinned by:

- `runtime/src/session/cost-persistence.test.ts`

### 6. Degraded mode and duplicate/drop behavior stay local

- Sidecar degraded mode is per-sidecar (`I-43`); one sidecar going
  degraded does not imply another sidecar is degraded.
- `CostSidecar.saveToDisk()` flags only the cost sidecar degraded on
  save failure and keeps the in-memory totals intact for a later retry.
- `SessionStore.append()` keeps the existing duplicate/drop rules:
  monotonic `seq` governs sequenced events, and unsequenced events are
  deduped by `event.id`.

Consequences:

- sidecar/observer compatibility work must not add replay or synthetic
  duplication that bypasses the existing `SessionStore` dedupe path
- dropped pre-attach or pre-slot events stay dropped; they are not
  recovered later as synthetic duplicates

Pinned by:

- `runtime/src/session/sidecar.test.ts`
- `runtime/src/session/observer-wiring.test.ts`
- `runtime/src/session/cost-persistence.test.ts`

## Change Rule

If a change wants different startup, attach, shutdown, degraded, or
drop semantics than the list above, it must:

1. update this document
2. update the named tests
3. call out the compatibility break explicitly in the runtime
   replacement notes
