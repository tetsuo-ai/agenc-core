# AgenC TUI Runtime Notes

This file records the design-handoff decisions from `TUI-RUNTIME-SYNC.md`
so the next implementation pass does not need to rediscover them.

## Design Source Provenance

- The implemented source snapshot is the local design handoff bundle at
  `/tmp/agenc-design.bundle`, sha256
  `752001a77e6b125c385fd6abf8c5fe35e77cad534c51b4278a55a873c6bc1068`.
- The bundle README, chat transcript, `TUI-RUNTIME-SYNC.md`,
  `TUI-IMPLEMENTATION.md`, `TUI-UX-RESEARCH.md`, `AgenC TUI.html`, and JSX
  sources were read from that snapshot.
- Direct access to the handoff URL is not available with the credentials on
  this machine: unauthenticated API GET returns `404`, local OAuth API GET
  returns `403 insufficient OAuth scopes`, API `HEAD` returns `405`, API
  `POST` returns `404`, API path variants under `/v1/designs/` return
  `404`, browser URL variants stop on Cloudflare `403`, and the web-fetch
  CLI reports `404 Not Found`. Treat a fresh design-scoped
  credential/current handoff URL or an explicit user decision to accept the
  local snapshot as the remaining source-provenance requirement.

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
   it does not enforce risk tiers by itself. The live daemon permission
   overlay now classifies low, medium, and destructive requests. Destructive
   requests require typed confirmation; low and medium requests still use the
   existing permission-engine allow/reject callbacks and `confirm:yes`
   shortcut.

## Runtime Binding Notes

- Workbench architecture note: `App.tsx` owns `AlternateScreen`.
  `FullscreenLayout` remains the classic chrome, scrollback, and modal host
  only when workbench mode is explicitly disabled with
  `AGENC_TUI_WORKBENCH=0`. `WorkbenchLayout` owns workbench panes and does not
  mount those panes inside the transcript `ScrollBox`.
- Workbench is the default fullscreen TUI. The visible behavior changes are:
  the Explorer pane is interactive, the center pane switches by active work
  surface, diff approvals jump to full hunk review, and the Agents rail is
  visible at wide widths.
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
- `BackgroundTasksPanel` remains bound to `AppStateStore.tasks`; only its
  visual layer was replaced with the v2 background-tasks panel chrome. Stop
  actions still route through the existing task helpers and optional
  tool-use-context `setAppState`.

## Runtime Mismatch Notes

- The archived handoff source uses `CLAUDE.md` in its memory and hooks mock
  rows. AgenC's live instruction surface is `AGENC.md`, so the runtime smoke
  fixture intentionally renders `AGENC.md` and records a source-marker alias in
  `designStateSmoke.test.tsx` for the archived text.
- The design handoff said the previous `runtime/src/tui/components/` tree,
  except `App.tsx`, was being deleted. In the live runtime, that directory is
  still the home for shared controls used by `App.tsx`, command UIs, tool UIs,
  screens, hooks, and the `runtime/src/tui/ink.ts` Box/Text export layer.
  This pass deleted the legacy `messages/` and `permissions/` visual
  subtrees and moved their live transcript/permission rendering behind the v2
  primitives, but it intentionally did not delete shared controls that remain
  imported by live runtime paths.

## Validation Notes

- Numbered design-state viewport smoke:
  `cd runtime && npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'renders numbered design state without overflow'`
- Source-backed numbered design-state suite:
  `cd runtime && AGENC_TUI_DESIGN_HTML='/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html' npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
- Browser-backed local design extraction:
  `cd runtime && AGENC_TUI_DESIGN_HTML='/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html' AGENC_TUI_DESIGN_BROWSER=1 npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps live browser-rendered design text broadly aligned when enabled'`
- Curated browser marker anchor check:
  `cd runtime && AGENC_TUI_DESIGN_BROWSER_REPORT=1 npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps curated browser marker anchors close to their design cells'`
- Browser-derived text fixture parity:
  `cd runtime && AGENC_TUI_DESIGN_BROWSER_REPORT=1 npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps projected browser text cells aligned at exact grid positions'`
- Anchored browser text-cell parity:
  `cd runtime && npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps found browser text markers intact at rendered cell positions'`
- Completion-grade exact projected cell gate:
  `cd runtime && AGENC_TUI_DESIGN_EXACT_CELLS=1 npx vitest run tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'fails closed on projected browser text-cell drift when exact parity is requested'`
  This gate is intentionally fail-closed and must pass before claiming the
  strict "no visual drift" acceptance criterion.
- Focused v2 TUI suite:
  `cd runtime && npx vitest run tests/tui/components/v2/ContextUsageModal.test.tsx tests/tui/components/v2/primitives.test.tsx tests/tui/components/v2/designStateSmoke.test.tsx --reporter=dot`
- Slash-command and v2 panel suites:
  `cd runtime && npx vitest run tests/commands/registry.test.ts tests/commands/command-surface.test.ts tests/commands/tui-command-list.test.ts tests/tui/components/PromptInput/slashCommandSuggestions.test.ts tests/tui/components/tasks/BackgroundTasksPanel.test.tsx tests/tui/components/v2/ContextUsageModal.test.tsx tests/tui/components/v2/primitives.test.tsx tests/tui/components/v2/messagePrimitives.test.tsx --reporter=dot`
- Typecheck:
  `cd runtime && npm run typecheck`
- Repo hygiene:
  `git diff --check`
- Full TUI gate after runtime-code changes:
  `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full`
