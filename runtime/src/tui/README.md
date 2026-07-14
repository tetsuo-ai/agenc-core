# AgenC TUI Runtime Notes

Design and architecture notes for the fullscreen terminal UI under
`runtime/src/tui/`. These are the durable decisions a reader needs before
touching the render stack, the workbench shell, or the v2 design primitives.

## Render stack: custom Ink fork

The TUI does not use upstream Ink. `runtime/src/tui/ink/` is a forked,
in-tree React renderer built on `react-reconciler` plus a native Yoga layout
binding (`ink/native-ts/yoga-layout/`). The reconciler host config lives in
`ink/reconciler.ts`; it maps React fibers onto the DOM-like node tree in
`ink/dom.ts`, attaches/frees Yoga nodes per node, and drives layout, focus,
and event dispatch. `ink/ink.tsx` (`class Ink`) owns the root `FiberRoot`,
schedules frames, and writes to the screen via `ink/render-to-screen.ts` /
`ink/render-node-to-output.ts`.

`runtime/src/tui/ink.ts` is the thin public export layer. It re-exports
`render` / `createRoot` plus the themed `Box` and `Text` primitives (which
resolve from `components/design-system/`), so most call sites import UI
primitives from `../ink.js` and never reach into the fork internals.

`main.tsx` is the process entry: it calls `render(<AgenCTuiApp .../>)` from
`./ink.js`, wires terminal teardown (alt-screen exit, cursor restore, mouse
tracking) via `onExit`, and feeds an `FpsTracker` plus
`backpressure.ts` (`recordTuiBackpressure`) so input/render stalls are
observable.

## App shell and layout selection

`components/App.tsx` is the top component. Its public export is
`AgenCTuiApp`; the internal render body is `App`. The shell:

- Owns `AlternateScreen` (`ink/components/AlternateScreen.js`) and decides
  whether mouse tracking is enabled. The body passed to `AlternateScreen` is
  kept a fragment (not a flex `Box`) so the layout's full-height region
  stays a direct child of the alt-screen `Box`.
- Picks the layout at render time. When fullscreen and
  `isWorkbenchEnabled()` is true (`workbench/state.ts`), it mounts
  `WorkbenchLayout` (`workbench/WorkbenchLayout.tsx`); otherwise it mounts
  `FullscreenLayout` (`components/FullscreenLayout.tsx`). Both receive the
  same transcript / composer / overlay / modal slots.

Workbench is the default fullscreen TUI; `AGENC_TUI_WORKBENCH=0` opts back
into the classic `FullscreenLayout` chrome (scrollback + modal host).
`WorkbenchLayout` owns the workbench panes (Explorer, center work-surface,
Agents rail, approvals, tasks under `workbench/`) and does **not** mount
those panes inside the transcript `ScrollBox`. Visible workbench behavior:
the Explorer pane is interactive, the center pane switches by active work
surface, diff approvals jump to full hunk review, and the Agents rail is
visible at wide widths.

`FullscreenLayout` owns the v2 top chrome and status bar (`BrandCells`,
`TuiHeader`, `StatusBar` from `components/v2/primitives.tsx`). The header mode
pill reads `toolPermissionContext.mode` from app state via
`useAppStateMaybeOutsideOfProvider` and falls back to `default` in static
render/test harnesses that do not mount `AppStateProvider`. A v2
`PlanModeBanner` renders above scrollback whenever the permission mode is
`plan` (`DesignPlanModeBanner` in `FullscreenLayout.tsx`).

## v2 design primitives

`components/v2/` holds the shared design-system primitives the current UI is
built from: `primitives.tsx` (header, status bar, `MenuModal`,
`PlanModeBanner`, brand cells), `messagePrimitives.tsx` (transcript message
chrome), and `ContextUsageModal.tsx`. The legacy `components/messages/` and
`components/permissions/` visual subtrees were removed; live transcript and
permission rendering now go through these v2 primitives. The rest of
`components/` is still the home for shared controls, command UIs, tool UIs,
screens, and hooks imported by live runtime paths.

`MenuModal` backs the default interactive menu views for the slash commands:
`/model`, `/provider`, `/hooks`, `/skills`, `/mcp`,
`/plugins`, `/permissions`, `/memory`, `/resume`, `/config`, `/agents`,
`/status`, `/diff` — see the `*-menu.tsx` files under `runtime/src/commands/`.
(`/provider` is the only provider-switch command; there is no `/model-provider`.)
`/context` (alias `/ctx`, registered in `commands/session-compact.ts`) renders
through `ContextUsageModal` when the TUI bridge is available; headless
dispatch keeps the text fallback.

`BackgroundTasksPanel` (`components/tasks/BackgroundTasksPanel.tsx`) stays
bound to app-state `tasks`; only its visual layer uses the v2 panel chrome.
Stop actions still route through the existing task helpers and optional
tool-use-context `setAppState`.

## Theme tokens

Theme roles are defined in `runtime/src/utils/theme.ts` (truecolor plus
ANSI-256 and 16-color fallback palettes). Beyond the base role colors
(`agenc`, `briefLabelAgenC`, `briefLabelYou`, `success`, `error`, `subtle`,
`inactive`, `text`, etc.), the v2 design adds explicit surface-semantics
tokens: `agencWash`, `worker`, `workerWash`, `successWash`, `errorWash`,
`text2`, `muted3`, `line`, `lineSoft`, `briefLabelWorker`, and `planModeWash`.
Components resolve these through `components/design-system/`
(`ThemeProvider`, `resolveThemedColor`, `ThemedBox`, `ThemedText`).

## Permission modes

The permission mode enum lives in `runtime/src/permissions/types.ts`. The full
set (`ALL_PERMISSION_MODES`) is `default`, `acceptEdits`, `plan`,
`bypassPermissions`, `dontAsk`, `auto`, `unattended`, `bubble`. The last two
are internal-only and excluded from `USER_ADDRESSABLE_PERMISSION_MODES`; they
render in the header if active but are not part of the user-facing mode cycle.

The live daemon permission overlay classifies low, medium, and destructive
requests. Destructive requests require typed confirmation; low and medium
requests use the permission-engine allow/reject callbacks and the
`confirm:yes` keybinding shortcut. The `Confirmation` keybinding context
(`confirm:yes`, `confirm:no`, navigation, toggles, field traversal) does not
enforce risk tiers by itself.

## Protocol commands and events

The protocol slash commands `/claim`, `/delegate`, `/proof`, `/settle`, and
`/stake` are registered from `runtime/src/commands/protocol.ts` directly into
the command registry with `source: "plugin"` and plugin manifest name
`agenc-core`. This gives the slash palette plugin-style attribution without
introducing a separate plugin-manager dependency for built-in protocol
commands.

On-chain lifecycle rows are canonical `EventMsg` variants in
`runtime/src/session/event-log.ts` under the `protocol_*` subgroup:
`protocol_claim`, `protocol_settle`, `protocol_slash`, and `protocol_stake`.
They are included in both `KNOWN_EVENT_TYPES` and `DURABLE_EVENT_TYPES`
because they are durable protocol records, not transient UI notifications.

## Instruction surface

AgenC's live instruction file is `AGENC.md` (loaded tiered by
`runtime/src/prompts/agenc-md.ts`). The numbered design-state smoke fixture
renders `AGENC.md` and records a source-marker alias for legacy text in
`tests/tui/components/v2/designStateSmoke.test.tsx`.

## Validation

The v2 design surface is covered by a numbered design-state smoke suite plus
focused primitive/modal suites under `tests/tui/components/v2/`. The smoke
suite (`designStateSmoke.test.tsx`) has optional environment knobs for
HTML/browser-backed reference checks (`AGENC_TUI_DESIGN_HTML`,
`AGENC_TUI_CHROME_PATH`, `AGENC_TUI_DESIGN_BROWSER`,
`AGENC_TUI_DESIGN_BROWSER_REPORT`, `AGENC_TUI_DESIGN_EXACT_CELLS`,
`AGENC_TUI_DESIGN_DUMP_STATE`, `AGENC_TUI_DESIGN_DUMP_LIVE`); the exact-cells
gate is intentionally fail-closed.

Common local checks:

- Focused v2 TUI suite:
  `cd runtime && node scripts/run-hermetic-vitest.mjs run tests/tui/components/v2/ContextUsageModal.test.tsx tests/tui/components/v2/primitives.test.tsx --reporter=dot`
- HTML/browser-backed design audit (preserves only the documented design env
  inputs): `npm run check:tui-v2-design-audit`, or from `runtime/`,
  `node scripts/run-hermetic-vitest.mjs --design run --config vitest.design.config.ts`
- Stateful real-PTY command smoke (separate from the hermetic design audit):
  `npm run check:tui-command-visual-smoke`
- Slash-command and v2 panel suites:
  `cd runtime && node scripts/run-hermetic-vitest.mjs run tests/commands/registry.test.ts tests/commands/command-surface.test.ts tests/commands/tui-command-list.test.ts tests/tui/components/PromptInput/slashCommandSuggestions.test.ts tests/tui/components/tasks/BackgroundTasksPanel.test.tsx tests/tui/components/v2/ContextUsageModal.test.tsx tests/tui/components/v2/primitives.test.tsx tests/tui/components/v2/messagePrimitives.test.tsx --reporter=dot`
- Typecheck: `cd runtime && npm run typecheck`
- Repo hygiene: `git diff --check`
