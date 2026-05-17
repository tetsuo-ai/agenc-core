# AgenC TUI Runtime Notes

This file records the design-handoff decisions from `TUI-RUNTIME-SYNC.md`
so the next implementation pass does not need to rediscover them.

## Design Handoff Open Questions

1. **Theme token overlap.** The existing theme already had the base role
   colors (`agenc`, `briefLabelAgenC`, `briefLabelYou`, `success`, `error`,
   `subtle`, `inactive`, `text`, `bashBorder`, `permission`, `planMode`,
   `userMessageBackground`, `bashMessageBackgroundColor`). The redesign adds
   explicit v2 tokens where the mockup needed separate surface semantics:
   `agencWash`, `worker`, `workerWash`, `successWash`, `errorWash`, `text2`,
   `muted3`, `line`, `lineSoft`, `briefLabelWorker`, and `planModeWash`.

2. **Permission mode enum.** The runtime already supports the 8-mode superset
   in `runtime/src/permissions/types.ts`: `default`, `acceptEdits`, `plan`,
   `bypassPermissions`, `dontAsk`, `auto`, `unattended`, and `bubble`.
   `unattended` and `bubble` are internal-only; they render in the header if
   active but are not shown in the user-facing mode cycle.

3. **Protocol command location.** The current branch registers `/claim`,
   `/delegate`, `/proof`, `/settle`, and `/stake` from
   `runtime/src/commands/protocol.ts` directly into the daemon-TUI registry
   with `source: "plugin"` and plugin metadata name `agenc-core`. This gives
   the slash palette plugin-style attribution without introducing a separate
   plugin manager dependency for built-in protocol commands.

4. **Protocol event schema location.** On-chain lifecycle rows are canonical
   `EventMsg` variants in `runtime/src/session/event-log.ts` under the
   `protocol_*` subgroup: `protocol_claim`, `protocol_settle`,
   `protocol_slash`, and `protocol_stake`. They are included in
   `KNOWN_EVENT_TYPES` and `DURABLE_EVENT_TYPES` because they are durable
   protocol records, not transient UI notifications.

5. **Typed confirmation.** The existing `Confirmation` keybinding context has
   `confirm:yes`, `confirm:no`, navigation, toggles, and field traversal, but
   it does not yet enforce high-risk typed confirmation by itself. The v2
   `ApprovalCard` exposes `requireTypedConfirmation`; the next permission UI
   pass still needs to bind that flag to an input field for mainnet protocol
   writes.

## Runtime Binding Notes

- `/context` is registered in the unified slash registry with `/ctx` as the
  short alias and renders through the v2 context-usage modal when the TUI
  bridge is available. Headless dispatch keeps the existing text fallback.
- The shared v2 `MenuModal` now backs the default interactive views for
  `/model`, `/model-provider` (`/provider`), `/hooks`, `/skills`, `/mcp`,
  `/plugins`, `/permissions`, `/memory`, `/resume`, and `/context`.
- `FullscreenLayout` owns the v2 top chrome and status bar. The header mode
  pill reads `toolPermissionContext.mode` from `AppStateStore` and falls back
  to `default` in static render/test harnesses that do not mount
  `AppStateProvider`.
- Plan mode now has a v2 banner rendered above scrollback whenever
  `permissionMode === "plan"`.
- `BackgroundTasksDialog` remains bound to `AppStateStore.tasks`; only its
  visual layer was replaced with the v2 background-tasks panel chrome. Stop
  actions still route through the existing task helpers and optional
  tool-use-context `setAppState`.
