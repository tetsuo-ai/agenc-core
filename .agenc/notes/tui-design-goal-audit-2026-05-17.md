# TUI Design Goal Completion Audit - 2026-05-17

Objective: execute `goal.md` for the AgenC TUI visual replacement while
preserving the existing runtime systems and local-only git rules.

## Prompt-To-Artifact Checklist

| Requirement | Evidence | Status |
|---|---|---|
| Create `goal.md` from the long prompt. | `goal.md` exists at repo root and contains the decomposed objective, reading order, build sequence, acceptance criteria, repo rules, and final-output requirements. | Done |
| Provide a `/goal` prompt for the goal file. | Prompt was provided in chat and references `/home/tetsuo/git/AgenC/agenc-core/goal.md`. | Done |
| Fetch the live design URL. | Direct API/browser access remains blocked with available local credentials; see `runtime/src/tui/README.md` "Design Source Provenance". | Blocked |
| Read bundle README and docs in order before coding. | Local snapshot `/tmp/agenc-design.bundle` and extracted `/tmp/agenc-tui-handoff/agenc-tui/project` were used. `runtime/src/tui/README.md` records the README, chat transcript, runtime sync, implementation, research, HTML, and JSX source files read from that snapshot. | Done from local snapshot |
| Confirm `TUI-RUNTIME-SYNC.md` read and list five open questions. | Open-question answers are recorded in `runtime/src/tui/README.md` under "Design Handoff Open Questions". | Done |
| Add v2 theme tokens to every theme variant. | `runtime/src/utils/theme.ts` defines and populates `agencWash`, `worker`, `workerWash`, `successWash`, `errorWash`, `text2`, `muted3`, `line`, `lineSoft`, `briefLabelWorker`, and `planModeWash` across all variants. | Done |
| Header mode pill wired to `permissionMode`; Shift+Tab cycle retained. | `runtime/src/tui/components/FullscreenLayout.tsx`, `runtime/src/tui/components/v2/primitives.tsx`, `runtime/src/tui/components/PromptInput/PromptInput.tsx`, and related tests cover mode chrome. | Done |
| Terminal frame matching design state `01` as shared source. | `TerminalFrame`, `TuiHeader`, `StatusBar`, `PromptBar`, and `BrandCells` live in `runtime/src/tui/components/v2/primitives.tsx`; `FullscreenLayout.tsx` uses the v2 top chrome and status bar. | Done |
| Slash registry consolidation: `/model`, `/provider`, `/hooks`, `/compact`, `/plugins`, `/memory`, `/resume`. | `runtime/src/commands/registry.ts`; tests in `registry.test.ts`, `command-surface.test.ts`, `tui-command-list.test.ts`, and `slashCommandSuggestions.test.ts`. | Done |
| Protocol extension commands `/claim`, `/delegate`, `/proof`, `/settle`, `/stake` as `agenc-core` plugin surface. | `runtime/src/commands/protocol.ts`; metadata locked by `runtime/src/commands/registry.test.ts`. | Done |
| One `<MenuModal>` with live menu bindings. | `MenuModal` in `runtime/src/tui/components/v2/primitives.tsx`; bindings documented in `runtime/src/tui/README.md` and exercised by modal/menu tests. | Done |
| Conversation renderer against event log with `<Msg>`, `<Tool>`, `<DiffInline>`, `<PlanList>`, `<ApprovalCard>`. | `runtime/src/tui/message-renderers/*`, `runtime/src/tui/components/v2/messagePrimitives.tsx`, `runtime/src/tui/components/v2/primitives.tsx`; old `components/messages/` subtree deleted. | Done |
| Delete old `messages/` and `permissions/` visual trees rather than refactor them. | `git status` shows `runtime/src/tui/components/messages/**` and `runtime/src/tui/components/permissions/**` deletions/moves. Runtime mismatch for shared controls is documented in `runtime/src/tui/README.md`. | Done with documented exception |
| File picker `@`, shell mode `!`, streaming Markdown renderer. | Covered by design-state source markers in `designStateSmoke.test.tsx`; existing runtime entry points remain in `PromptInput` and Markdown renderer paths. | Done |
| `/ctx` modal bound to token counts and local estimate. | `runtime/src/tui/components/v2/ContextUsageModal.tsx`; tests in `ContextUsageModal.test.tsx` and design state `10`. | Done |
| Replace background task dialog with panel. | `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx`; old dialog deleted; tests in `BackgroundTasksPanel.test.tsx`. | Done |
| Plan-mode banner and accept flow only when `permissionMode === "plan"`. | `PlanModeBanner` in v2 primitives; `FullscreenLayout.tsx` renders it only for plan mode; design state `19b` covered. | Done |
| Add `protocol_claim`, `protocol_settle`, `protocol_slash`, `protocol_stake` event types. | `runtime/src/session/event-log.ts` union, known event types, durable event types; system renderer maps protocol events through `ProtocolEvent`. | Done |
| No inline hex colors in changed TUI visual layer. | Changed-file hex audit and `node scripts/branding-scan.mjs --changed` pass. | Done |
| Smoke tests at `148x40`, `120x30`, and `80x24`. | `designStateSmoke.test.tsx` has 87 viewport cases; full TUI gate also spawns `agenc` and `agenc --yolo` at all three sizes. | Done |
| Duplicate spawned-agent row and React update-depth regressions remain fixed. | `runtime/src/tui/parity/session-transcript.contract.test.ts` directly asserts raw `spawn_agent` tool events do not duplicate structured collab rows; `runtime/src/tui/state/AppState.test.tsx` covers allocating selector snapshots that previously triggered maximum-update-depth crashes. | Done |
| Every numbered window `01a` through `19c` reproduces at `148x40` with no visual drift. | Source-backed and browser-backed tests pass semantic markers, expanded text coverage, anchored cell integrity, curated marker anchor closeness, ANSI styling, and viewport safety. The strict no-drift claim is still not fully proven because dense states retain measurable row/column drift. `techdebt-2026-05-17-tui-design-parity-followup.md` records the remaining evidence gap. | Not complete |

## Latest Evidence

- `cd runtime && AGENC_TUI_DESIGN_HTML='/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot` passed 103 tests.
- `cd runtime && AGENC_TUI_DESIGN_HTML='/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html' AGENC_TUI_DESIGN_BROWSER=1 npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps live browser-rendered design text broadly aligned when enabled'` passed.
- `cd runtime && AGENC_TUI_DESIGN_BROWSER_REPORT=1 npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot --testNamePattern 'keeps curated browser marker anchors close to their design cells'` passed and reports per-state tight anchor coverage.
- `cd runtime && npx vitest run src/commands/command-surface.test.ts src/commands/tui-command-list.test.ts src/tui/components/PromptInput/slashCommandSuggestions.test.ts --reporter=dot` passed.
- `cd runtime && npx vitest run src/tui/components/tasks/BackgroundTasksPanel.test.tsx src/tui/components/v2/ContextUsageModal.test.tsx src/tui/components/v2/primitives.test.tsx src/tui/components/v2/messagePrimitives.test.tsx --reporter=dot` passed.
- `cd runtime && npx vitest run src/tui/parity/session-transcript.contract.test.ts src/tui/state/AppState.test.tsx --reporter=dot` passed 15 tests.
- `cd runtime && npm run typecheck` passed.
- `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full` passed all selected gates.
- Live URL recheck returned HTTP `404` with body `not found`, and no design
  credential environment variable is present.

## Completion Decision

Do not mark the active goal complete yet. Two requirements remain unproven:

1. Live design URL fetch is blocked without a credential that can access the
   design handoff.
2. Exact no-drift parity for every numbered state is not fully proven by the
   current executable checks; the suite proves source markers, browser-derived
   text coverage, curated anchor closeness, bounded row/column drift, ANSI
   styling, viewport safety, and live startup at the required terminal sizes.
