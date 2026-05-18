# TODO - AgenC TUI v2 Migration Backlog

This file replaces the previous unrelated TODO list. It tracks remaining TUI visual-layer migration work in goal-sized items.

Use one checkbox item as one `/goal`. Do not bundle items unless the dependency field explicitly says to do so.

Goal prompt template:

```text
/goal "Execute TODO.md item TUI-TODO-001 only. Read the item, inspect the listed files, implement the acceptance criteria, run the listed validation, and commit locally on main."
```

Status legend:

- `[ ]` open
- `[~]` in progress
- `[x]` done
- `[?]` needs decision

Global rules for every item:

- Keep the existing runtime stack: `runtime/src/tui/main.tsx`, `runtime/src/tui/components/App.tsx`, `runtime/src/tui/ink/`, `runtime/src/utils/theme.ts`, event log, session store, command registry, MCP manager, keybinding system, permission engine, and `AppStateStore`.
- Use AgenC branding only.
- Do not add inline hex colors. New color needs go through `runtime/src/utils/theme.ts` and every theme variant.
- Keep terminal-renderable visuals only: no shadows, glows, gradients, backdrop blur, pill buttons, or rounded internal panels.
- Prefer v2 primitives already in `runtime/src/tui/components/v2/`: `MenuModal`, `TerminalFrame`, `ThemedBox`, `ThemedText`, `BrandCells`, `StatusBar`, conversation primitives, and related helpers.
- Rich slash commands should open persistent v2 surfaces in the TUI. Text output is acceptable only for explicit non-interactive subcommands or non-TUI fallbacks.
- Menus must fit within 148x40, 120x30, and 80x24. If content exceeds available height, it must scroll and show usable selection state.
- Pressing up from the first visible menu row should wrap to the last available row where that menu supports cyclic keyboard navigation.

Validation for TUI code changes:

```bash
git diff --check
npm run typecheck
node scripts/branding-scan.mjs --changed
node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full
```

For docs-only edits to this file, `git diff --check` is enough.

Known v2 work already landed:

- `/help` opens as a persistent modal instead of disappearing immediately.
- `/skills` has the command-spacing fix and a viewport-aware menu.
- `/model`, `/provider`, `/hooks`, `/mcp`, `/plugins`, `/agents`, `/permissions`, `/memory`, `/resume`, and `/tasks` have at least partial v2 command surfaces.
- The footer spacing and command hint spacing were recently fixed.

## Goal Items

### [x] TUI-TODO-001 - Port `/config` and `/settings` to a v2 persistent config surface

Files to inspect:

- `runtime/src/commands/config.ts`
- `runtime/src/commands/config/index.ts`
- `runtime/src/commands/config/config.tsx`
- `runtime/src/tui/components/Settings/`
- `runtime/src/tui/components/v2/`
- `runtime/src/utils/theme.ts`

Current gap:

- Empty `/config` returns a transient text snapshot.
- The local JSX command path still opens the old `Settings` component.
- `/settings` aliases the same old local JSX surface.

Target:

- Empty `/config` and `/settings` open a persistent v2 modal.
- The modal binds to the existing config store and shows core settings, provider/model defaults, permission mode, configured paths, MCP status summary, and updater/status information where available.
- Keep explicit text subcommands such as `show`, `get`, `reload`, and `edit` usable for CLI and scripting behavior.
- Use v2 menu navigation, scroll behavior, and theme tokens.

Acceptance:

- No TUI slash-command path imports `runtime/src/tui/components/Settings/Settings.tsx`.
- `/config` remains visible until dismissed by the user.
- The modal fits and scrolls at 148x40, 120x30, and 80x24.
- Tests cover empty `/config`, `/settings`, and at least one text subcommand.

Dependencies:

- None.

### [x] TUI-TODO-002 - Port `/diff` from text and old diff dialogs to v2

Files to inspect:

- `runtime/src/commands/diff.ts`
- `runtime/src/commands/diff/index.ts`
- `runtime/src/commands/diff/diff.tsx`
- `runtime/src/tui/components/diff/`
- `runtime/src/tui/components/v2/`

Current gap:

- `/diff` is still mostly text-oriented.
- The local JSX path points at old diff dialog components.

Target:

- `/diff` opens a persistent v2 diff surface with file list, changed-line summary, and selected-file preview.
- Reuse or extend `DiffInline` for terminal-safe diff rendering.
- Preserve text output for explicit non-interactive flags or non-TUI fallback.

Acceptance:

- The command can render no-change, single-file, and multi-file states.
- Large diffs scroll without overflowing the terminal.
- Selection state survives viewport changes.
- Old diff dialog components are no longer reachable from the slash command path.

Dependencies:

- None.

### [x] TUI-TODO-003 - Port `/status` to a v2 status dashboard

Files to inspect:

- `runtime/src/commands/status.ts`
- `runtime/src/commands/status/index.ts`
- `runtime/src/commands/status/status.tsx`
- `runtime/src/tui/startup/StatusLine.tsx`
- `runtime/src/tui/components/v2/`

Current gap:

- `/status` still has an old local JSX path and mixed text output behavior.
- Startup status and command status are visually inconsistent.

Target:

- `/status` opens a v2 status dashboard with cwd, git state, runtime version/build, active provider/model, permission mode, session/context summary, MCP summary, and task summary.
- Keep a compact text fallback for non-TUI execution.

Acceptance:

- `/status` is persistent and dismissible.
- Dirty git, clean git, no git repo, and missing provider states render cleanly.
- The command path no longer opens the old status component.

Dependencies:

- None.

### [x] TUI-TODO-004 - Port `/plan` to the v2 plan-mode banner and accept flow

Files to inspect:

- `runtime/src/commands/plan.ts`
- `runtime/src/commands/plan/index.ts`
- `runtime/src/commands/plan/plan.tsx`
- `runtime/src/tui/components/v2/`
- `runtime/src/permissions/`

Current gap:

- `/plan` still has old local JSX wiring.
- Plan-mode UI should be visually tied to the v2 frame and permission-mode state.

Target:

- `/plan` opens or toggles a v2 plan-mode surface.
- The banner renders only when `permissionMode === "plan"`.
- Accept, reject, and edit flows use v2 components and existing permission/keybinding state.

Acceptance:

- Shift+Tab mode cycling and `/plan` stay consistent.
- Plan accept flow remains keyboard-accessible.
- Old plan local JSX component is no longer reachable.

Dependencies:

- None.

### [x] TUI-TODO-005 - Finish `/context`, `/ctx`, and `/compact` v2 context surfaces

Files to inspect:

- `runtime/src/commands/context/index.ts`
- `runtime/src/commands/context/context.tsx`
- `runtime/src/commands/session-compact.ts`
- `runtime/src/tui/components/v2/ContextUsageModal.tsx`
- Event log token-count event handling

Current gap:

- Context usage has partial v2 rendering, but old local JSX wiring remains.
- `/compact` and `/context` behavior should feel like one system.

Target:

- `/context` and `/ctx` open the v2 context usage modal.
- The modal binds to token-count events when present and falls back to a local estimate when not present.
- `/compact` uses the same context data and renders terminal-safe progress/confirmation states.

Acceptance:

- Context data renders for empty, estimate-only, and event-backed sessions.
- `/compact` does not flash transient help-like text for primary interactive states.
- Old context local JSX component is no longer reachable.

Dependencies:

- None.

### [x] TUI-TODO-006 - Finish `/agents` management parity in v2

Files to inspect:

- `runtime/src/commands/agent-management.tsx`
- `runtime/src/commands/agents-menu.tsx`
- `runtime/src/commands/agents/index.ts`
- `runtime/src/commands/agents/agents.tsx`
- `runtime/src/tui/components/agents/`

Current gap:

- The runtime `/agents` menu is v2 for summary/navigation.
- Create, edit, delete, detail, and permission-like flows still live in old agent menu components.

Target:

- `/agents` uses v2 components for list, detail, create, edit, delete confirmation, and validation feedback.
- Preserve existing agent store behavior and command semantics.
- Remove or disconnect old agent menu paths once no callers remain.

Acceptance:

- Keyboard navigation wraps correctly.
- Agent names, tools, model, provider, and prompt details fit narrow terminals.
- Invalid edits show persistent v2 validation state.
- Old `runtime/src/tui/components/agents/AgentsMenu.tsx` is no longer reachable from command paths.

Dependencies:

- None.

### [ ] TUI-TODO-007 - Finish `/hooks` edit, test, and reload flows in v2

Files to inspect:

- `runtime/src/commands/hooks.ts`
- `runtime/src/commands/hooks-menu.tsx`
- `runtime/src/commands/hooks/index.ts`
- `runtime/src/commands/hooks/hooks.tsx`
- `runtime/src/tui/components/hooks/`

Current gap:

- The v2 hooks menu is mainly an inspection surface.
- Old hook configuration dialogs still own richer interaction flows.

Target:

- `/hooks` opens a v2 menu with list, detail, enable/disable, edit command, test hook, reload, and event-mode selection.
- Existing hook registry/store behavior stays intact.

Acceptance:

- Hook rows show event, matcher, command, enabled state, and last result where available.
- Test/reload feedback persists until dismissed or superseded.
- Old hook dialog components are not reachable from `/hooks`.

Dependencies:

- None.

### [ ] TUI-TODO-008 - Finish `/mcp` server detail and management flows in v2

Files to inspect:

- `runtime/src/commands/mcp.ts`
- `runtime/src/commands/mcp-menu.tsx`
- `runtime/src/tui/components/mcp/`
- MCP manager and config store bindings

Current gap:

- The v2 MCP menu shows summary state.
- Old MCP dialogs still own detail, add, import, approve, and tool-list flows.

Target:

- `/mcp` provides v2 list, server detail, tool detail, enable/disable, add/import, and error states.
- Keep all MCP manager behavior and approval semantics.

Acceptance:

- Connected, disconnected, failed, disabled, and no-server states render distinctly.
- Tool lists scroll within viewport.
- Old MCP menu/dialog components are not reachable from `/mcp`.

Dependencies:

- None.

### [ ] TUI-TODO-009 - Port `/provider` and provider auth flows to v2

Files to inspect:

- `runtime/src/commands/provider.ts`
- `runtime/src/commands/provider-menu.tsx`
- `runtime/src/commands/provider/index.ts`
- `runtime/src/commands/provider/provider.tsx`
- `runtime/src/tui/components/ProviderManager.tsx`
- `runtime/src/tui/components/ConsoleOAuthFlow.tsx`

Current gap:

- `/provider` has a partial v2 summary.
- The old provider manager still owns provider detail and auth flows.

Target:

- `/provider` opens a v2 provider catalog and detail view.
- Auth states, credential presence, active provider, provider errors, and model availability render in v2.
- Preserve existing credential and provider registry behavior.

Acceptance:

- Active, unavailable, unauthenticated, and error states render without old dialogs.
- Provider changes update the footer/header model/provider state.
- Old `ProviderManager` is no longer reachable from `/provider`.

Dependencies:

- TUI-TODO-010 can run before or after this, but the final UX should be consistent across both.

### [ ] TUI-TODO-010 - Finish `/model` switching and remove old model picker paths

Files to inspect:

- `runtime/src/commands/model.ts`
- `runtime/src/commands/model-menu.tsx`
- `runtime/src/commands/model/index.ts`
- `runtime/src/commands/model/model.tsx`
- `runtime/src/tui/components/ModelPicker.tsx`

Current gap:

- `/model` has a v2 menu but old model picker paths remain.
- Provider/model coordination needs one consistent v2 interaction model.

Target:

- `/model` supports provider grouping, active model state, unavailable models, search/filter if already supported by store data, and selection confirmation.
- Remove or disconnect old model picker command paths.

Acceptance:

- Active model updates command state and status/footer display.
- Empty provider model lists render a usable explanation and next action.
- Old `ModelPicker` is no longer reachable from `/model`.

Dependencies:

- TUI-TODO-009 should be considered for shared provider/model state, but either item can land first.

### [ ] TUI-TODO-011 - Finish `/permissions` rules, approval, and trust surfaces in v2

Files to inspect:

- `runtime/src/commands/permissions.ts`
- `runtime/src/commands/permissions-menu.tsx`
- `runtime/src/commands/permissions/index.ts`
- `runtime/src/commands/permissions/permissions.tsx`
- `runtime/src/tui/components/BypassPermissionsModeDialog.tsx`
- `runtime/src/tui/components/TrustDialog.tsx`
- `runtime/src/permissions/`

Current gap:

- `/permissions` has a v2 summary menu.
- Old dialogs still own important trust and bypass interactions.

Target:

- `/permissions` uses v2 for mode state, rules, approvals, trust prompts, bypass warnings, and keyboard actions.
- Preserve the permission engine and mode-cycling behavior.

Acceptance:

- Normal, auto-accept, plan, and bypass states render consistently in header, footer, and modal.
- Risky actions keep explicit confirmation.
- Old permission dialogs are no longer reachable from slash-command permission paths.

Dependencies:

- None.

### [ ] TUI-TODO-012 - Replace remaining old `/tasks` detail dialogs

Files to inspect:

- `runtime/src/commands/tasks.ts`
- `runtime/src/commands/tasks/index.ts`
- `runtime/src/commands/tasks/tasks.tsx`
- `runtime/src/tui/components/BackgroundTasksPanel.tsx`
- `runtime/src/tui/components/tasks/`

Current gap:

- The background tasks panel is v2-oriented.
- Task detail dialogs for async agents, shell tasks, and in-process tasks still use old dialog components.

Target:

- `/tasks` uses v2 list and detail surfaces for every task type.
- Running, completed, failed, cancelled, and empty states render clearly.
- Long logs scroll and preserve selection.

Acceptance:

- In-flight tasks show the allowed running indicator only.
- Details do not overflow at 80x24.
- Old task detail dialogs are no longer reachable from `/tasks`.

Dependencies:

- None.

### [ ] TUI-TODO-013 - Finish `/memory` v2 management flow

Files to inspect:

- `runtime/src/commands/memory/slash.ts`
- `runtime/src/commands/memory/index.ts`
- `runtime/src/commands/memory/memory.tsx`
- `runtime/src/tui/components/memory/`

Current gap:

- `/memory` has partial v2 surface work.
- Old memory command local JSX remains.

Target:

- `/memory` uses v2 for memory list, source/detail view, add/edit/delete or open-file flows supported by the existing implementation.
- Preserve current memory store semantics.

Acceptance:

- Project, user, and absent memory states render distinctly.
- Destructive actions require confirmation.
- Old memory local JSX is no longer reachable.

Dependencies:

- None.

### [ ] TUI-TODO-014 - Port `/theme` and `/color` to v2 or retire from the registry

Files to inspect:

- `runtime/src/commands/theme/`
- `runtime/src/commands/color/`
- `runtime/src/tui/components/ThemePicker.tsx`
- `runtime/src/utils/theme.ts`
- Command registry tests

Current gap:

- Theme/color commands still have old local JSX paths.
- It is unclear whether both should remain user-facing after the v2 migration.

Target:

- Decide whether `/theme` and `/color` are supported commands.
- If supported, port them to a v2 theme selector with preview swatches made from terminal-safe cells.
- If retired, remove them from the user-visible registry and tests while preserving any non-command theme APIs needed by the app.

Acceptance:

- No old theme picker is reachable from command paths.
- Theme changes update the running TUI without inline color literals.
- Command surface tests document the final decision.

Dependencies:

- None.

### [ ] TUI-TODO-015 - Decide and port auxiliary setup dialogs

Files to inspect:

- `runtime/src/commands/ide/`
- `runtime/src/commands/install-github-app/`
- `runtime/src/commands/onboard-github/`
- `runtime/src/commands/terminal-setup/`
- Related components under `runtime/src/tui/components/`

Current gap:

- Several setup commands still use old local JSX dialog surfaces.
- Some may be outside the desired AgenC TUI command surface.

Target:

- For each setup command, choose one of: port to v2, keep as non-TUI text command, or retire from registry.
- Port kept interactive surfaces to v2 components.

Acceptance:

- Each command has an explicit decision recorded in this item or a follow-up note.
- User-visible commands no longer open old dialogs.
- Removed commands are removed from tests and help output.

Dependencies:

- None.

### [ ] TUI-TODO-016 - Clean up residual old local JSX command directories

Files to inspect:

- `runtime/src/commands/*/index.ts`
- `runtime/src/commands/*/*.tsx`
- `runtime/src/commands/registry.ts`
- Command surface tests

Current gap:

- Many command directories still declare `type: "local-jsx"` even when the runtime registry has moved to v2 command handlers.
- This makes it hard to know which visual layer is canonical.

Target:

- Audit every local JSX command directory.
- Remove, redirect, or convert old local JSX entries after their matching v2 commands are complete.
- Keep non-visual command modules intact where they still provide behavior.

Acceptance:

- No user-visible v2 slash command has a conflicting old local JSX implementation.
- Tests assert the intended slash command inventory.
- Deleted old files have no importers.

Dependencies:

- Complete the relevant command-specific items first.

### [ ] TUI-TODO-017 - Audit all remaining old `Dialog` usage

Files to inspect:

- `runtime/src/tui/components/`
- `runtime/src/tui/components/**/*.tsx`
- `runtime/src/commands/`

Current gap:

- Many old `Dialog` usages remain after the v2 frame landed.
- Some may be acceptable low-level confirmation primitives, while command surfaces should move to v2.

Target:

- Produce an inventory of every remaining old `Dialog` usage.
- Classify each as: port now, keep as low-level primitive for now, or delete after caller removal.
- Port command-facing usages to v2 or create follow-up TODO items with exact file ownership.

Acceptance:

- The inventory is committed in this TODO file or a nearby TUI note.
- No rich slash-command surface depends on old dialogs unless a follow-up item explicitly allows it.
- Any retained old dialog has a clear reason and owner.

Dependencies:

- Best done after several command-specific items land.

### [ ] TUI-TODO-018 - Add command-level visual smoke coverage

Files to inspect:

- Existing TUI smoke/parity tests
- `runtime/src/tui/__tests__/`
- `runtime/src/commands/__tests__/`
- Any fixture helpers for terminal dimensions

Current gap:

- The design-state smoke tests cover static states better than live command-opening behavior.
- Regressions like fast-disappearing `/help`, overflowing `/skills`, and text spacing can recur without command-level tests.

Target:

- Add tests or scripted smoke checks that open the major slash command surfaces in a pseudo-terminal.
- Cover 148x40, 120x30, and 80x24 where practical.
- Assert that rich commands remain visible, scroll if needed, and do not emit malformed command hint spacing.

Acceptance:

- Coverage includes `/help`, `/config`, `/skills`, `/model`, `/provider`, `/hooks`, `/mcp`, `/agents`, `/permissions`, `/memory`, `/resume`, `/tasks`, `/context`, and `/diff` where implemented.
- Tests fail on missing space between command hints.
- Tests fail when a menu starts below the visible terminal area.

Dependencies:

- Can start now, but command-specific assertions should be added as each surface is ported.

### [ ] TUI-TODO-019 - Remove unreachable old component subtrees after ports land

Files to inspect:

- `runtime/src/tui/components/Settings/`
- `runtime/src/tui/components/skills/`
- `runtime/src/tui/components/agents/`
- `runtime/src/tui/components/hooks/`
- `runtime/src/tui/components/mcp/`
- `runtime/src/tui/components/diff/`
- `runtime/src/tui/components/tasks/`
- `runtime/src/tui/components/ProviderManager.tsx`
- `runtime/src/tui/components/ModelPicker.tsx`
- `runtime/src/tui/components/ThemePicker.tsx`

Current gap:

- The old component tree remains partially present.
- Keeping unreachable old components increases branding, styling, and regression risk.

Target:

- After command paths are converted, remove unreachable old visual components.
- Keep only shared low-level primitives that are still intentionally used.

Acceptance:

- `rg` finds no importers before deleting each file or directory.
- Typecheck does not gain errors.
- Command smoke tests still pass.

Dependencies:

- Depends on command-specific port items.

### [ ] TUI-TODO-020 - Normalize slash help and command metadata after the v2 ports

Files to inspect:

- `runtime/src/commands/registry.ts`
- `runtime/src/commands/help.tsx`
- `runtime/src/commands/help-renderer.tsx`
- `runtime/src/tui/composer/`
- Command surface tests

Current gap:

- Help output has been fixed for persistence, but command descriptions, aliases, grouping, and old command entries need a final pass after the migration.

Target:

- Ensure help shows only supported AgenC commands.
- Group commands by workflow: session, model/provider, tools/MCP, agents/tasks, permissions, project/context, protocol, utility.
- Ensure command examples have correct spacing and v2 naming.

Acceptance:

- `/help` and filtered help remain persistent.
- No retired command appears in help.
- Help examples do not wrap badly at 80 columns.
- Command surface tests match the final registry.

Dependencies:

- Best done after TUI-TODO-014, TUI-TODO-015, and TUI-TODO-016.

### [ ] TUI-TODO-021 - Add a final v2 parity audit against numbered design states

Files to inspect:

- Design-state fixtures and smoke tests
- `runtime/src/tui/components/App.tsx`
- `runtime/src/tui/components/v2/`
- Command surfaces completed by this backlog

Current gap:

- Individual command ports can pass while the full TUI still drifts from the target visual system.

Target:

- Re-run the numbered state audit against the live TUI.
- Map every missing state to either a completed implementation, a follow-up TODO item, or an explicit product decision.

Acceptance:

- The audit covers 148x40 first, then 120x30 and 80x24 truncation behavior.
- Drift findings are actionable and assigned to exact follow-up items.
- No known high-impact visual drift remains untracked.

Dependencies:

- Run after the command-specific port items are complete.
