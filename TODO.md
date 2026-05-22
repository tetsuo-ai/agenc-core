# AgenC TUI Workbench TODO

This plan turns the 2026-05-22 AgenC TUI Workbench design into live runtime code.
It is written against the current `agenc-core` tree, not just the mockup.

## Current Codebase Map

### Existing Pieces To Reuse

- `runtime/src/tui/components/App.tsx`
  - Current interactive TUI shell.
  - Owns transcript rendering, prompt input, permission overlays, local JSX command surfaces, scroll handling, and fullscreen layout.
  - Calls `FullscreenLayout` with `scrollable`, `bottom`, `overlay`, and `modal`.

- `runtime/src/tui/components/FullscreenLayout.tsx`
  - Current fullscreen geometry, top chrome, bottom chrome, scroll box, modal overlay host, plan banner, and a static file-tree gutter.
  - Problem: the current file tree is a render-time static gutter built from `git ls-files` / `readdirSync`. It is not interactive and should be replaced, not extended.
  - Also note: bottom chrome currently derives the git label through cached sync `execFileSync` calls. Workbench chrome should not add new sync process or filesystem calls to React render paths.

- `runtime/src/tui/state/AppStateStore.ts`
  - Current app-wide state store.
  - Already contains task state, permission mode, footer selection, teammate view, agent registry, file history, notifications, and overlay tracking.
  - It does not yet contain workbench focus, active surface, explorer, or agents-rail state.

- `runtime/src/tui/keybindings/*`
  - Existing keybinding registry, context stack, default bindings, user overrides, and chord support.
  - This is the correct place to add Workbench, Explorer, Agent Rail, and Active Work Surface contexts.

- `runtime/src/tui/components/diff/*`
  - Existing structured diff renderer and tests.
  - Reuse this for the `DIFF` Active Work Surface instead of writing a new diff renderer.

- `runtime/src/commands/diff.ts` and `runtime/src/commands/diff-menu.tsx`
  - Existing git snapshot collector and v2 diff menu.
  - `collectDiffSnapshot` is close to the data source the `DIFF` surface needs.
  - The current menu tracks hunk accept/skip locally but does not apply decisions to the working tree. Treat it as a visual/data starting point, not the final diff review engine.

- `runtime/src/tui/permission-requests.tsx`
  - Current permission request queue and approval overlay.
  - Already hides the prompt while a permission/elicitation prompt is active.
  - Currently supports a low/high split with heuristic high-risk detection. The design needs explicit low/medium/destructive tiers with typed confirmation for destructive operations.

- `runtime/src/tui/components/QuickOpenDialog.tsx`
  - Existing fuzzy file picker with preview.
  - Current behavior opens external editor or inserts a path. The workbench needs this same index to open `PREVIEW` inside the Active Work Surface.

- `runtime/src/tui/components/GlobalSearchDialog.tsx`
  - Existing ripgrep-backed search dialog with preview.
  - Current behavior opens external editor or inserts a path. The workbench needs this data model as the `SEARCH` surface.

- `runtime/src/tui/hooks/fileSuggestions.ts`
  - Current async project file index around `FileIndex`.
  - Reuse the indexing/invalidation logic for the explorer and quick-open rather than shelling out in render.

- `runtime/src/file-watcher/index.ts`
  - Existing file watcher abstraction.
  - Use this to refresh project tree/git metadata without blocking the TUI.

- `runtime/src/services/lsp/*`
  - Existing LSP client, diagnostics registry, and passive diagnostic feedback.
  - `PREVIEW` and later `BUFFER` should read diagnostics through this path.

- `runtime/src/tui/components/tasks/*` and `runtime/src/tasks/types.ts`
  - Existing task/agent status model and background tasks panel.
  - Use `AppState.tasks`, `agentNameRegistry`, task output files, and existing stop helpers for task details that exist in this process.
  - Remote viewer mode currently exposes `remoteBackgroundTaskCount`; detailed remote-task rail rows need an event/detail source before they can show more than count/status.

- `runtime/src/tui/tool-jsx-state.ts`
  - Current local JSX command surface channel.
  - Keep compatibility while moving first-class workbench views into Active Work Surface state.

### Existing Tests To Extend

- `runtime/tests/tui/components/FullscreenLayout*.test.tsx`
- `runtime/tests/tui/keybindings/*.test.ts*`
- `runtime/tests/tui/components/QuickOpenDialog*.test.*`
- `runtime/tests/tui/components/GlobalSearchDialog*.test.*`
- `runtime/tests/tui/components/diff/*.test.tsx`
- `runtime/tests/commands/diff.test.ts`
- `runtime/tests/tui/permission-requests*.test.tsx`
- `runtime/tests/tui/components/tasks/BackgroundTasksPanel*.test.tsx`
- `runtime/tests/services/lsp/*.test.ts`

## Product Target

The target is a keyboard-first terminal workbench:

- The center pane is the **Active Work Surface**, not a permanent transcript.
- V1 surfaces: `TRANSCRIPT`, `PREVIEW`, `DIFF`, `TEST`, `SHELL`.
- V1 wide-layout chrome includes a basic `Agents` rail. Near-follow full surfaces: `SEARCH`, `AGENT`.
- Later only: editable `BUFFER`.
- Root focus panes: `Explorer`, `Active Work Surface`, `Agents`, `Composer`.
- The file explorer must be real: expand/collapse, selection, active file, git state, dirty state, attached state, search hits, in-flight agent writes, and narrow popup mode.
- Approvals must be first-class: low/medium/destructive risk tiers, diff jump, blocking overlay, and typed confirmation for destructive actions.

## Non-Negotiables

- Do not ship another static file tree.
- Do not shell out synchronously from React render.
- Do not make `TRANSCRIPT` own editor behavior.
- Do not build an editable buffer in V1.
- Do not let panes call each other directly. Cross-pane changes go through a workbench command bus/state reducer.
- Do not hide destructive approval behind `enter`.
- Do not remove existing command modals until the matching workbench surface is wired and tested.
- Keep the old fullscreen shell as a fallback until the new workbench passes startup, render, and keybinding tests.

## Proposed File Layout

Create a dedicated workbench subtree:

- `runtime/src/tui/workbench/types.ts`
- `runtime/src/tui/workbench/state.ts`
- `runtime/src/tui/workbench/reducer.ts`
- `runtime/src/tui/workbench/commands.ts`
- `runtime/src/tui/workbench/keymap.ts`
- `runtime/src/tui/workbench/WorkbenchLayout.tsx`
- `runtime/src/tui/workbench/WorkbenchFooter.tsx`
- `runtime/src/tui/workbench/WorkbenchStatusBar.tsx`
- `runtime/src/tui/workbench/project-tree/ProjectTreeStore.ts`
- `runtime/src/tui/workbench/project-tree/buildTree.ts`
- `runtime/src/tui/workbench/project-tree/gitStatus.ts`
- `runtime/src/tui/workbench/project-tree/useProjectTree.ts`
- `runtime/src/tui/workbench/project-tree/ProjectExplorer.tsx`
- `runtime/src/tui/workbench/surfaces/ActiveWorkSurface.tsx`
- `runtime/src/tui/workbench/surfaces/TranscriptSurface.tsx`
- `runtime/src/tui/workbench/surfaces/PreviewSurface.tsx`
- `runtime/src/tui/workbench/surfaces/DiffSurface.tsx`
- `runtime/src/tui/workbench/surfaces/TestSurface.tsx`
- `runtime/src/tui/workbench/surfaces/ShellSurface.tsx`
- `runtime/src/tui/workbench/surfaces/SearchSurface.tsx`
- `runtime/src/tui/workbench/surfaces/AgentSurface.tsx`
- `runtime/src/tui/workbench/agents/AgentsRail.tsx`
- `runtime/src/tui/workbench/approvals/risk.ts`
- `runtime/src/tui/workbench/approvals/ApprovalSurfaceBridge.tsx`

Keep existing shared primitives in:

- `runtime/src/tui/components/v2/primitives.tsx`
- `runtime/src/tui/components/design-system/*`
- `runtime/src/tui/components/diff/*`
- `runtime/src/tui/components/tasks/*`

## Runtime State Contract

Add minimal workbench state to `AppStateStore.ts`. Keep large tree/search data in external stores so keystrokes do not re-render the transcript or every tree row.

```ts
type WorkbenchPane = "explorer" | "surface" | "agents" | "composer";

type ActiveSurfaceMode =
  | "transcript"
  | "preview"
  | "diff"
  | "test"
  | "shell"
  | "search"
  | "agent";

type WorkbenchState = {
  focusedPane: WorkbenchPane;
  explorerVisible: boolean;
  agentsVisible: boolean;
  activeSurfaceMode: ActiveSurfaceMode;
  activeFilePath: string | null;
  selectedAgentTaskId: string | null;
  selectedShellTaskId: string | null;
  openDiffId: string | null;
  searchQuery: string;
  selectedSearchMatchId: string | null;
  composerAttachmentIds: readonly string[];
  pendingBlockedOverlay:
    | null
    | { kind: "approval"; requestId: string; attemptedAction: string };
};
```

Rules:

- `AppState.workbench` stores focus, selected IDs, lightweight surface params, and lightweight composer attachment IDs only.
- Attachment payloads live in composer/workbench attachment state and are materialized through the existing prompt attachment pipeline on submit.
- `ProjectTreeStore` owns tree rows, expanded paths, cursor path, git state, dirty state, loading/error state, and filter hits.
- `DiffSurface` owns a surface-local view model derived from `collectDiffSnapshot` or future agent edit proposals.
- `SearchSurface` reuses ripgrep/search result data and stores only the active query and selected match ID in app state.
- `AgentSurface` reads from `AppState.tasks` and task output files.

## Phase 0: Design Contract And Migration Guard

- [x] Add a `workbenchEnabled` gate.
  - Candidate: env flag `AGENC_TUI_WORKBENCH=1` while under development.
  - Existing fullscreen shell remains default until Phase 11 terminal and visual gates pass.
- [x] Add `runtime/src/tui/workbench/types.ts`.
- [x] Add a pure reducer and command enum in `runtime/src/tui/workbench/reducer.ts`.
- [x] Add unit tests for reducer defaults and focus transitions.
- [x] Add a migration note in `runtime/src/tui/README.md`: `App.tsx` owns `AlternateScreen`, `FullscreenLayout` remains the chrome/scroll/modal host, and `WorkbenchLayout` will own workbench panes once the flag is enabled.

Acceptance:

- [x] `AppStateStore.getDefaultAppState()` includes stable workbench defaults.
- [x] No visible UI change when the flag is off.
- [x] `npm run typecheck --workspace=@tetsuo-ai/runtime`.

Rollback:

- Disable the flag. No runtime behavior should depend on workbench state while off.

## Phase 1: Replace Static Gutter With Real Project Tree Store

Current issue:

- `FullscreenLayout.tsx` contains `WorkspaceFileTreeGutter`, `getWorkspaceFileTreeRows`, and render-time sync filesystem/git calls.
- `FullscreenLayout.tsx` also contains cached sync git calls for the bottom chrome label. Keep that separate from the project tree migration, but do not reuse the pattern in new workbench stores.

Tasks:

- [x] Move file tree logic out of `FullscreenLayout.tsx`.
- [x] Create `ProjectTreeStore` as an external store consumed by `useProjectTree` via `useSyncExternalStore`.
- [x] Extract or share project-index logic from `fileSuggestions.ts` where possible; do not depend on that module's private singleton state from the explorer.
- [x] Add async git status collection:
  - tracked files
  - untracked files
  - modified/deleted/renamed/unmerged status
  - ignored/hidden toggle support later
- [x] Subscribe to `runtime/src/file-watcher/index.ts` or timed refresh fallback.
- [x] Store expanded folder paths and cursor path outside render.
- [x] Implement row state rendering:
  - collapsed folder
  - expanded folder
  - selected cursor
  - focused-but-dim cursor
  - active file
  - dirty file
  - git markers
  - untracked
  - conflict
  - ignored/hidden
  - filter match
  - unreadable/error
  - loading
  - agent in-flight edit
  - attached to prompt
  - search hit indicator
  - worktree root
- [x] Delete or deprecate `WorkspaceFileTreeGutter` from `FullscreenLayout.tsx`.

Target files:

- `runtime/src/tui/components/FullscreenLayout.tsx`
- `runtime/src/tui/workbench/project-tree/*`
- `runtime/src/tui/hooks/fileSuggestions.ts`
- `runtime/src/file-watcher/index.ts`

Tests:

- [x] Unit-test tree building from synthetic paths.
- [x] Unit-test git status parsing.
- [x] Render-test explorer rows at 28, 30, and 44 columns.
- [x] Regression-test that React render does not call `execFileSync`, `readdirSync`, or `git`.

Acceptance:

- [x] Explorer expands/collapses folders with `h/l`.
- [x] `j/k`, `g/G`, page up/down, and reveal active file work.
- [x] Tree state survives focus changes.
- [x] Narrow popup can display the same tree rows.

Rollback:

- Restore `fileTreeGutter={false}` and keep `FullscreenLayout` fallback while the store is fixed.

## Phase 2: Workbench Layout Shell

Tasks:

- [x] Create `WorkbenchLayout`.
- [x] Keep `App.tsx` as the `AlternateScreen` owner.
- [x] Keep `FullscreenLayout` as the classic chrome/scroll/modal host while the flag is off.
- [x] Add a workbench body path that bypasses the transcript `ScrollBox` instead of slotting panes inside the existing scrollable transcript content.
- [x] Reuse or extract shared chrome/modal pieces from `FullscreenLayout` only where that does not keep workbench panes coupled to transcript scrolling.
- [x] Implement responsive breakpoints:
  - `>= 130 cols`: Explorer + Active Surface + Agents + Composer.
  - `100-129 cols`: Explorer + Active Surface + Composer; agents as status/popup.
  - `<= 99 cols`: Active Surface + Composer; Explorer and Agents are popups.
  - `< 24 rows`: collapse footer/chrome, never hide approvals.
- [x] Implement root focus state:
  - `ctrl+w h` Explorer
  - `ctrl+w l` Surface/Agents cycle
  - `ctrl+w j` Composer
  - `ctrl+w k` Pane above
  - `ctrl+w w` Next visible pane
- [x] Add context-sensitive footer hints from the focused pane.

Target files:

- `runtime/src/tui/components/App.tsx`
- `runtime/src/tui/components/FullscreenLayout.tsx`
- `runtime/src/tui/workbench/WorkbenchLayout.tsx`
- `runtime/src/tui/workbench/WorkbenchFooter.tsx`
- `runtime/src/tui/workbench/WorkbenchStatusBar.tsx`
- `runtime/src/tui/keybindings/types.ts`
- `runtime/src/tui/keybindings/defaultBindings.ts`

Tests:

- [x] Render smoke at 148x40, 120x30, 80x24.
- [x] Footer changes hints based on focus.
- [x] Composer remains usable when workbench is on.
- [x] Existing fullscreen tests still pass when workbench is off.

Acceptance:

- [x] Layout matches the design structure without behavior regressions.
- [x] The workbench flag can be toggled without changing non-workbench behavior.

Rollback:

- Disable `workbenchEnabled`; `AgenCTuiShell` continues rendering current fullscreen layout.

## Phase 3: Active Work Surface Contract

Tasks:

- [x] Create `ActiveWorkSurface`.
- [x] Define a surface component interface:
  - `mode`
  - `title(state)`
  - `renderBody(state)`
  - `keybindings`
  - `footerHints`
  - `onCommand(command)`
- [x] Add `TRANSCRIPT` as the first live mode by wrapping existing `Messages` output.
- [x] Move only enough transcript rendering into the surface to prove the contract.
- [x] Preserve existing transcript screen behavior and scrollback.
- [x] Add `surface.open(mode, payload)` command.
- [x] Add `surface.close` command returning to `TRANSCRIPT`.

Target files:

- `runtime/src/tui/components/App.tsx`
- `runtime/src/tui/components/Messages.tsx`
- `runtime/src/tui/workbench/surfaces/*`
- `runtime/src/tui/workbench/commands.ts`

Tests:

- [x] Surface mode reducer tests.
- [x] `TRANSCRIPT` render parity against current messages in a small fixture.
- [x] `q` closes non-transcript surfaces back to transcript.
- [x] Surface keybindings only fire when surface holds focus.

Acceptance:

- [x] The center pane is no longer hardcoded as transcript in workbench mode.
- [x] Existing transcript still works with workbench disabled.

Rollback:

- Route all `ActiveWorkSurface` requests to `TRANSCRIPT`.

## Phase 4: PREVIEW Surface

Tasks:

- [x] Create `PreviewSurface`.
- [x] Reuse `readFileInRange` for content.
- [x] Show:
  - path
  - read-only marker
  - git/dirty marker
  - line numbers
  - syntax highlighting fallback using existing markdown/code primitives where practical
  - LSP diagnostics from `peekLSPDiagnosticsForFile`
  - in-flight agent edit banner
- [x] Wire explorer:
  - `enter`: open file in `PREVIEW` and focus surface.
  - `o`: open file in `PREVIEW` while keeping explorer focus.
  - `@`: attach file to composer context.
  - `R`: reveal active file.
- [x] Stop opening external editor from workbench quick-open paths. External editor remains explicit future command only.
- [x] Update Quick Open to dispatch `surface.openPreview(path)` in workbench mode.

Target files:

- `runtime/src/tui/workbench/surfaces/PreviewSurface.tsx`
- `runtime/src/tui/components/QuickOpenDialog.tsx`
- `runtime/src/services/lsp/LSPDiagnosticRegistry.ts`
- `runtime/src/utils/readFileInRange.ts`

Tests:

- [x] Preview renders missing/unreadable file states.
- [x] Preview truncates/wraps without overflowing width.
- [x] LSP diagnostics appear when registry has pending diagnostics for the file.
- [x] Explorer `enter` and `o` dispatch different focus outcomes.

Acceptance:

- [x] Preview is explicitly read-only.
- [x] File open semantics are clear: preview, attach, reveal, ask, later edit.

Rollback:

- Keep explorer file open disabled while retaining tree navigation.

## Phase 5: DIFF Surface And Approval Bridge

Tasks:

- [x] Extract a reusable diff view model from `commands/diff-menu.tsx`.
- [x] Use `collectDiffSnapshot` for working-tree diff mode.
- [x] Add agent-edit proposal mode later when the session can expose pending edit patches directly.
- [x] Create `DiffSurface` with:
  - file rail
  - risk summary
  - queued test summary
  - hunk viewer
  - hunk/file navigation
  - hunk/file decision state
  - jump to preview
- [x] Do not pretend hunk accept/reject applies changes until a real patch application/revert path exists.
- [x] For V1, scope decisions to approval responses and working-tree review:
  - `y/n`: answer current approval when the surface was opened from a pending approval.
  - `Y/N`: answer file-level approval only when backed by a real pending approval.
  - otherwise mark review state locally as non-mutating.
- [x] Replace permission overlay summary with a bridge:
  - inline summary in `TRANSCRIPT`
  - `d` opens `DIFF`
  - pending approval owns focus when required
- [x] Add medium-risk classification.
- [x] Move destructive classification out of TUI heuristic into permissions/risk logic.
- [x] Implement blocked-by-approval overlay for Explorer destructive actions.

Target files:

- `runtime/src/commands/diff.ts`
- `runtime/src/commands/diff-menu.tsx`
- `runtime/src/tui/permission-requests.tsx`
- `runtime/src/permissions/classifier.ts`
- `runtime/src/permissions/evaluator.ts`
- `runtime/src/permissions/review-decision.ts`
- `runtime/src/tui/workbench/surfaces/DiffSurface.tsx`
- `runtime/src/tui/workbench/approvals/*`

Tests:

- [x] Diff view model tests for modified/added/deleted/untracked/conflict files.
- [x] Diff surface render tests at 89x28 and narrow widths.
- [x] Hunk/file navigation key tests.
- [x] Approval bridge tests:
  - low risk allows one-key approval
  - medium risk has no always-allow path
  - destructive requires typed confirmation
  - Explorer file ops are blocked while approval is pending
- [x] Existing permission overlay tests still pass or are replaced by workbench-specific tests.

Acceptance:

- [x] `DIFF` is the default active surface when an edit approval is pending.
- [x] `TRANSCRIPT` shows only a summary and can jump to full hunks.
- [x] No destructive action approves from plain `enter`.

Rollback:

- Restore current `AgenCPermissionOverlay` as the overlay owner and keep `DIFF` read-only.

## Phase 6: TEST And SHELL Surfaces

Tasks:

- [x] Create `ShellSurface`.
- [x] Read task output via existing task output paths and `tailFile`.
- [x] Bind shell controls to existing task helpers:
  - stop/interrupt
  - restart only where a real command replay exists
  - follow tail
  - scroll
- [x] Parse source locations from shell output for `g` jump-to-preview.
- [x] Create `TestSurface`.
- [x] Start with parsed test output from shell/task output.
- [x] Add failure list, selected failure detail, and source jump.
- [x] `f/F` should queue an agent prompt only after the command surface can create a well-scoped prompt and the user can see it.

Target files:

- `runtime/src/tui/workbench/surfaces/ShellSurface.tsx`
- `runtime/src/tui/workbench/surfaces/TestSurface.tsx`
- `runtime/src/tui/components/shell/*`
- `runtime/src/tui/components/tasks/*`
- `runtime/src/tasks/LocalShellTask/*`
- `runtime/src/utils/task/*`

Tests:

- [x] Shell surface renders running/completed/failed task states.
- [x] Large output tails without blocking render.
- [x] Source-location parser unit tests.
- [x] Test failure parser unit tests for Vitest-style output.
- [x] `g` opens source preview at expected file/line.

Acceptance:

- [x] User can inspect shell/test output without leaving the workbench.
- [x] Existing task panel still works until Agents rail replaces it.

Rollback:

- Keep `/tasks` and existing task modal as the task output path.

## Phase 7: SEARCH Surface

Tasks:

- [x] Extract search data model from `GlobalSearchDialog`.
- [x] Create `SearchSurface` grouped by file.
- [x] Use existing `ripGrepStream` and debounce behavior.
- [x] Add key actions:
  - `j/k`: match
  - `J/K`: file group
  - `enter`: open preview
  - `o`: preview without focus change
  - `@`: attach selected match
  - `A`: attach all visible matches
  - `a`: ask agent about matches only after prompt injection is explicit and reviewable
- [x] Keep current `GlobalSearchDialog` as compatibility path until surface is stable.

Target files:

- `runtime/src/tui/components/GlobalSearchDialog.tsx`
- `runtime/src/tui/workbench/surfaces/SearchSurface.tsx`
- `runtime/src/utils/ripgrep.ts`

Tests:

- [x] Search result grouping unit tests.
- [x] Render tests for no results, in-progress, truncated results, and errors.
- [x] Keybinding tests for attach/open behavior.

Acceptance:

- [x] Search results live in the Active Work Surface, not only a transient modal.

Rollback:

- Continue using `GlobalSearchDialog`.

## Phase 8: Agents Rail And AGENT Surface

Tasks:

- [x] Build `AgentsRail` from `AppState.tasks`.
- [x] In remote viewer mode, show the existing remote background count/status until detailed remote task events are available.
- [x] Include:
  - active/background grouping
  - current status
  - current tool/activity
  - elapsed runtime
  - token/tool count
  - diff count when available
  - approval pending marker
- [x] Create `AgentSurface`:
  - task identity
  - worktree/path when available
  - plan/progress from `TaskState.progress`
  - recent activities
  - output tail
  - stop/pause/restart only where real helpers exist
  - steer input only where routing to that agent is already supported
- [x] Integrate with existing teammate/local-agent view helpers.
- [x] Narrow widths use `Agents` popup.

Target files:

- `runtime/src/tui/workbench/agents/AgentsRail.tsx`
- `runtime/src/tui/workbench/surfaces/AgentSurface.tsx`
- `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx`
- `runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx`
- `runtime/src/tui/state/teammateViewHelpers.ts`
- `runtime/src/tasks/types.ts`
- `runtime/src/tools/AgentTool/agentToolUtils.ts`

Tests:

- [x] Agents rail render tests for no agents, one active agent, mixed active/background, failed task, approval pending.
- [x] Agent surface render tests for local agent, in-process teammate, remote agent, shell task exclusion.
- [x] Remote viewer tests for count-only state when no detailed remote task rows are available.
- [x] Stop action routes to existing helpers.
- [x] Popup layout at 80/100/120 cols.

Acceptance:

- [x] Background agent state is visible without opening `/tasks`.
- [x] Agent detail is steerable only where routing is real.

Rollback:

- Hide `AgentsRail` and keep existing background task footer/modal.

## Phase 9: Composer Integration And Attachments

Tasks:

- [x] Define attachment semantics:
  - file path
  - file line range
  - search result
  - diff hunk
  - shell/test error
- [x] Reuse existing `@path` parsing and model-turn attachment generation where possible:
  - `runtime/src/prompts/file-mentions.ts`
  - `runtime/src/prompts/attachments/file-mentions.ts`
  - `runtime/src/utils/attachments.ts`
- [x] Add explicit composer chip state for workbench-originated attachments; the existing attachment pipeline mostly materializes context at submit time.
- [x] Add visible context chips/summary in composer footer.
- [x] Implement `@` attach from explorer/preview/search/shell/test.
- [x] Clear or retain attachments according to existing prompt submission behavior.
- [x] Add `@-` remove behavior only after attachment model supports removal by ID.

Target files:

- `runtime/src/tui/components/PromptInput/*`
- `runtime/src/tui/input/processPromptInput.ts`
- `runtime/src/prompts/file-mentions.ts`
- `runtime/src/prompts/attachments/*`
- `runtime/src/utils/attachments.ts`
- `runtime/src/tui/workbench/state.ts`

Tests:

- [x] Attachment creation tests.
- [x] Prompt submission includes attached context exactly once.
- [x] Attachments render without overflowing prompt footer.
- [x] Workbench focus returns correctly after file picker/attach popup closes.

Acceptance:

- [x] Composer clearly shows what context will be sent.

Rollback:

- Disable cross-surface attach and keep existing prompt `@file` behavior.

## Phase 10: Old Modal Convergence

Tasks:

- [x] Decide which existing slash-command menus remain modals and which become surfaces.
- [x] Convert `/diff` to open `DIFF` in workbench mode and current modal otherwise.
- [x] Convert quick open to open `PREVIEW` in workbench mode and current behavior otherwise.
- [x] Convert global search to open `SEARCH` in workbench mode and current modal otherwise.
- [x] Keep `/model`, `/permissions`, `/mcp`, `/hooks`, `/skills`, `/plugins`, `/resume`, and config menus as modals unless a later design covers them.
- [x] Ensure `toolJSX` local command preservation still works.

Target files:

- `runtime/src/commands/diff.ts`
- `runtime/src/commands/diff-menu.tsx`
- `runtime/src/tui/components/QuickOpenDialog.tsx`
- `runtime/src/tui/components/GlobalSearchDialog.tsx`
- `runtime/src/tui/tool-jsx-state.ts`

Tests:

- [x] Workbench mode command tests.
- [x] Non-workbench mode command tests.
- [x] Local JSX preservation regression tests.

Acceptance:

- [x] No duplicate UI paths for the same workbench action when the flag is on.
- [x] Existing command menus remain stable when the flag is off.

Rollback:

- Commands continue opening existing local JSX modals.

## Phase 11: Visual Parity And Terminal QA

Tasks:

- [x] Add workbench visual smoke fixtures at:
  - 148x40
  - 120x30
  - 80x24
  - 60x20
- [x] Add exact overflow assertions: no line wider than terminal width.
- [x] Add keybinding smoke tests for root focus and per-surface contexts.
- [x] Add a runtime startup gate with workbench flag on.
- [x] Extend `check:tui-command-visual-smoke` or add `check:tui-workbench-visual-smoke`.
- [x] Run full pseudo-terminal validation before enabling by default.

Commands:

```bash
npm run typecheck --workspace=@tetsuo-ai/runtime
npm run build --workspace=@tetsuo-ai/runtime
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
npm --workspace=@tetsuo-ai/runtime run check:tui-command-visual-smoke
node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full
```

Focused test suites:

```bash
cd runtime && npx vitest run \
  tests/tui/components/FullscreenLayout.test.tsx \
  tests/tui/keybindings \
  tests/tui/components/QuickOpenDialog.layout.test.ts \
  tests/tui/components/GlobalSearchDialog.layout.test.ts \
  tests/tui/components/diff/StructuredDiff.test.tsx \
  tests/commands/diff.test.ts \
  tests/tui/permission-requests.coverage.test.tsx \
  tests/tui/components/tasks/BackgroundTasksPanel.test.tsx \
  --reporter=dot
```

Acceptance:

- [x] Workbench renders nonblank at all target sizes.
- [x] No overflow at all target sizes.
- [x] `agenc` and `agenc --yolo` start under a pseudo-terminal.
- [x] No new typecheck errors.
- [x] No branding or public artifact regressions.

## Phase 12: Enable By Default

Tasks:

- [x] Remove or invert the temporary `workbenchEnabled` gate only after Phase 11 passes.
- [x] Update `runtime/src/tui/README.md` with final architecture.
- [x] Delete dead static gutter code.
- [x] Keep compatibility modals only where they still serve a separate command use case.
- [x] Add release notes describing behavior changes:
  - Explorer is now interactive.
  - Center pane switches by active work surface.
  - Diff approvals open full hunk review.
  - Agents rail is visible at wide widths.

Acceptance:

- [x] Fresh `npm run validate:runtime` passes from repo root.
- [x] Full TUI validation passes.
- [x] Workbench is on by default in normal fullscreen TUI.

Rollback:

- Reintroduce the feature gate for one release if startup or terminal compatibility issues appear.

## Deferred: Editable BUFFER

Do not implement full text editing until the workbench ships.

Prerequisites:

- [ ] Text buffer model with undo/redo.
- [ ] Save/revert lifecycle.
- [ ] LSP hover/definition/diagnostic integration.
- [ ] Conflict handling with agent in-flight edits.
- [ ] Clear ownership rules between user edits and agent edits.
- [ ] Tests for multi-line edits, wide characters, selection, scroll, and terminal resize.

Until then:

- `PREVIEW` stays read-only.
- `DIFF` owns edit review.
- Composer remains the way to instruct AgenC to change code.

## Tracking Checklist

- [x] Phase 0 complete: gated workbench state and reducer.
- [x] Phase 1 complete: real Project Explorer store and row states.
- [x] Phase 2 complete: responsive Workbench Layout.
- [x] Phase 3 complete: Active Work Surface shell and `TRANSCRIPT`.
- [x] Phase 4 complete: `PREVIEW`.
- [x] Phase 5 complete: `DIFF` and approval bridge.
- [x] Phase 6 complete: `TEST` and `SHELL`.
- [x] Phase 7 complete: `SEARCH`.
- [x] Phase 8 complete: Agents rail and `AGENT`.
- [x] Phase 9 complete: Composer attachments.
- [x] Phase 10 complete: old modal convergence.
- [x] Phase 11 complete: visual and terminal QA.
- [x] Phase 12 complete: enabled by default.
