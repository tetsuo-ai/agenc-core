# Runtime stabilization goals - 2026-05-12

## Rule for this tranche

Do not hide broken or unsupported UI. Either make a surface work end-to-end with live runtime tests, or remove it completely from registry, palette, help text, tips, tests, and dead helper code.

This tranche intentionally replaces the previous broad functional-gap list. The goal is a smaller working AgenC runtime: agents, skills, hooks, and a minimal reliable TUI command surface first; optional commands can be reintroduced later as clean, tested work.

## Minimal TUI slash surface

Keep these commands, and make them work through one canonical live dispatch path:

- `/help`
- `/status`
- `/model`
- `/provider`
- `/permissions`
- `/config`
- `/hooks`
- `/skills`
- `/mcp`
- `/clear`
- `/compact`
- `/diff`
- `/exit`

Remove every other TUI slash command unless the same goal fully wires it through the live App path and adds targeted tests that exercise it from the live TUI/daemon surface. Removal means no registry entry, no picker entry, no help/menu/tip mention, no stale tests expecting it, and no orphan helper/module kept only for that removed command.

## Goal list

### RS-01 Runtime load blockers

Fix hard import/load failures so runtime command, hook, and TUI tests can actually execute behavior.

Subgoals:

- Replace the broken `runtime/src/utils/collapseReadSearch.ts` `./teamMemoryOps.js` require with a bundler/test-safe import path.
- Fix `runtime/src/tools.ts` cron tool `.js` requires so source tests and bundled runtime agree.
- Fix the `clearCommandMemoizationCaches` initialization-order failure triggered by `/reload-plugins` tests, or remove the reload command if plugin command reload is not retained in this tranche.
- Remove any test mocks that only hide these load failures once the production path is fixed.

Gates:

- `npm test -- src/bin/agenc.user-prompt-submit.test.ts`
- `npm test -- src/bin/slash.test.ts src/commands/reload-plugins.test.ts`
- `npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/commands/dispatcher.test.ts`
- `npm test -- src/tui/components/App.render.test.tsx`

Reviewer focus:

- No new lazy shim modules or re-export wrappers.
- No feature flag workaround that disables real behavior in tests only.
- Production imports must work in both source-test and bundled runtime contexts.

### RS-02 Canonical slash dispatcher and minimal command surface

Collapse live TUI, daemon wrapper, palette, and command tests onto one command registry/dispatch path.

Subgoals:

- Remove `buildDefaultRegistry()` creation from the live submit handler in `runtime/src/tui/components/App.tsx`; the TUI must use a session-owned registry snapshot or equivalent canonical registry object.
- Remove or rewrite the old `runtime/src/tui/input/processSlashCommand.tsx` and `processUserInput.ts` slash path if it is no longer live. Do not leave it as a parallel implementation.
- Remove stale slash commands not in the minimal set from registry, palette, help text, footer/help menu, spinner tips, tests, and helper code.
- Remove `/btw` completely: command expectations, `sideQuestion` helper, highlighting, help text, tips, and tests.
- Remove `/buddy` completely: command expectations, footer submission path, highlighting, comments, dead imports, and tests.
- Decide `/plugin` and `/reload-plugins` in code, not by hiding: either make them fully live through the canonical registry with tests, or remove them from the TUI slash surface completely.
- Ensure unknown user-invocable skill slash commands behave consistently across TUI and daemon entrypoints, or remove that syntax and make `/skills` + model-facing `Skill` the only supported path.

Gates:

- `npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/commands/dispatcher.test.ts`
- `npm test -- src/bin/slash.test.ts`
- `npm test -- src/tui/components/App.render.test.tsx`
- `rg -n "btw|buddy" runtime/src --glob '*.ts' --glob '*.tsx'` must return no production references except intentional changelog/audit docs.
- `rg -n "processSlashCommand|processUserInput" runtime/src/tui runtime/src/commands runtime/src/bin --glob '*.ts' --glob '*.tsx'` must show no live duplicate slash dispatch path.

Reviewer focus:

- The command set is smaller because code was removed, not hidden behind `isHidden`, `isEnabled`, or environment gates.
- There is one slash dispatch model, not App-specific plus daemon-specific plus legacy input-specific behavior.
- Palette/help/listing and actual dispatch agree.

### RS-03 Skills discovery and invocation

Make skills work from the locations this repo actually uses, or explicitly migrate the installed skills into the AgenC-owned roots and remove compatibility assumptions.

Subgoals:

- Decide the supported skill roots for AgenC. For this machine, expected installed skills currently exist under `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`; AgenC currently discovers only part of that.
- Either add intentional compatibility discovery for `~/.claude/skills` and `~/.codex/skills`, or migrate/symlink/copy the expected skills into `.agenc`/`.agents` roots and document that only AgenC roots are supported.
- Make `/skills` show the same skills the model-facing `Skill` tool can load.
- Make skill cache invalidation work after file changes without relying on `/reload-plugins` unless that command is retained and fully fixed.
- Add tests for root discovery, rendering a skill from each supported root class, cache clear, and "skill not found" diagnostics listing the same available set as `/skills`.

Gates:

- `npm test -- src/skills/local-loader.test.ts src/commands/skills.test.ts src/bin/model-facing-tools.test.ts`
- A targeted test proving a skill under the chosen user root is visible to both `/skills` and the model-facing `Skill` tool.
- `rg -n "\\.claude/skills|\\.codex/skills" runtime/src runtime/test --glob '*.ts' --glob '*.tsx'` must either show intentional tested compatibility or no runtime dependency at all.

Reviewer focus:

- Skill discovery policy is explicit and tested.
- The model, slash command, and watcher/cache paths agree.
- No silent fallback that makes local dev pass while packaged AgenC cannot find skills.

### RS-04 Agents canonicalization

Make MultiAgentV2 the only model-facing agent system and remove old AgentTool crossover.

Subgoals:

- Keep canonical model-facing tools in `runtime/src/bin/model-facing-tools.ts`: `spawn_agent`, `send_message`/follow-up tools, wait/list/close, and `Skill`.
- Remove old `AgentTool` and `SkillTool` from `runtime/src/tools.ts` base tool exposure if they are not the canonical model-facing surface.
- Decide custom agent source roots. If markdown agents are supported, load them into `runtime/src/agents/role.ts` so `spawn_agent` can use them. If they are not supported, remove the old markdown loader from live paths and tests that imply support.
- Make `listAgentRoleDefinitions()` and the TUI agent picker reflect the same role registry that `spawn_agent` uses.
- Add tests for custom role discovery/registration if retained, unknown role rejection, role list projection, and no old `AgentTool` exposure.

Gates:

- `npm test -- src/agents/role-definitions.test.ts src/agents/role.test.ts src/tools/AgentTool/loadAgentsDir.test.ts src/bin/model-facing-tools.test.ts`
- A targeted `spawn_agent` test that proves a supported custom role works, or a targeted test that proves custom markdown agents are intentionally not supported and old surfaces are absent.
- `rg -n "AgentTool|agent_tool|SkillTool" runtime/src --glob '*.ts' --glob '*.tsx'` must show no live model-facing exposure of retired tools.

Reviewer focus:

- There is one agent role registry.
- TUI presentation and model-facing execution agree.
- Old loaders are removed from live paths rather than left as misleading dead support.

### RS-05 Hooks lifecycle correctness

Make configured hooks either fully live or fully absent from supported configuration.

Subgoals:

- Verify live wiring for PreToolUse, PostToolUse, UserPromptSubmit, Stop, StopFailure, PreCompact, and PostCompact.
- Wire `SessionStart` through the live session bootstrap path, or remove `SessionStart` from supported hook config/schema/docs/tests.
- If `SessionStart` is retained, dispatch it exactly once for startup/resume with the correct source and blocking behavior.
- Add live bootstrap tests, not only isolated configured-hooks unit tests.
- Remove old duplicate hook systems under moved-source utility paths if no live caller remains.

Gates:

- `npm test -- src/hooks/configured-hooks.test.ts src/commands/hooks.test.ts src/bin/bootstrap-services.test.ts`
- `npm test -- src/bin/agenc.user-prompt-submit.test.ts`
- A targeted bootstrap test proving retained lifecycle hook events fire in the live path.
- `rg -n "processSessionStart\\(|dispatchSessionStart\\(|pendingSessionStartSource" runtime/src --glob '*.ts' --glob '*.tsx'` must show a coherent live dispatch path if SessionStart is retained.

Reviewer focus:

- Supported hook events are not aspirational.
- No event is listed in config/help unless there is an end-to-end live path.
- Old hook systems are deleted or isolated from production runtime.

### RS-06 Runtime dead-path and duplicate cleanup

Remove completed-but-unwired and crossover code that keeps causing false confidence.

Subgoals:

- Delete or de-live old TUI/REPL paths that are no longer mounted by the live App.
- Delete moved-source command modules no longer in the minimal slash surface.
- Delete orphan helpers introduced only for removed commands.
- Remove stale comments that claim unsupported commands exist.
- Reduce `@ts-nocheck` and moved-source markers in touched areas.
- Remove dead tests that assert deleted behavior; replace them with tests asserting the new smaller live surface.

Gates:

- `rg -l "@ts-nocheck" runtime/src --glob '*.ts' --glob '*.tsx' | wc -l` must not increase.
- `rg -l "moved-source|donor-purge|placeholder|not implemented|DEPRECATED" runtime/src --glob '*.ts' --glob '*.tsx' | wc -l` must not increase.
- `npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/tui/components/App.render.test.tsx`
- Run `npm run typecheck` or the repo goal verify gate if this is executed as a formal checklist item.

Reviewer focus:

- Deleted code is not replaced with wrappers.
- Tests prove the new smaller surface, not the old broad broken surface.
- No stale UI text advertises removed capabilities.

## Parallel execution plan

Use three sessions with disjoint ownership. Each session should work in its own branch/worktree. Do not edit the same files across sessions unless one session has already merged and the next has rebased/started from the updated main checkout.

### Session A - loader and slash core

Owns:

- RS-01
- RS-02 core dispatcher work

Primary files likely touched:

- `runtime/src/utils/collapseReadSearch.ts`
- `runtime/src/tools.ts`
- `runtime/src/commands/registry.ts`
- `runtime/src/commands/dispatcher.ts`
- `runtime/src/commands/reload-plugins.ts`
- `runtime/src/commands.ts`
- `runtime/src/tui/components/App.tsx`
- `runtime/src/bin/slash.ts`
- slash command tests

### Session B - TUI pruning, skills, hooks

Owns:

- RS-02 command removal sweep
- RS-03
- RS-05

Primary files likely touched:

- `runtime/src/tui/components/PromptInput/**`
- `runtime/src/tui/components/spinner/Spinner.tsx`
- `runtime/src/tui/components/PromptInput/PromptInputHelpMenu.tsx`
- `runtime/src/utils/sideQuestion.ts`
- `runtime/src/skills/local-loader.ts`
- `runtime/src/commands/skills.ts`
- `runtime/src/hooks/configured-hooks.ts`
- `runtime/src/bin/bootstrap-services.ts`
- `runtime/src/session/bootstrap.ts`
- hook/skill/TUI tests

### Session C - agents and dead-path cleanup

Owns:

- RS-04
- RS-06

Primary files likely touched:

- `runtime/src/bin/model-facing-tools.ts`
- `runtime/src/tool-registry.ts`
- `runtime/src/tools.ts`
- `runtime/src/agents/**`
- `runtime/src/tools/AgentTool/**`
- old TUI/REPL/input paths after Session A/B land
- agent/dead-path tests

## Shared final gate

After all sessions merge locally, run a final integration pass:

- `npm test -- src/bin/agenc.user-prompt-submit.test.ts`
- `npm test -- src/bin/slash.test.ts src/commands/reload-plugins.test.ts`
- `npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/commands/dispatcher.test.ts`
- `npm test -- src/tui/components/App.render.test.tsx`
- `npm test -- src/skills/local-loader.test.ts src/commands/skills.test.ts src/bin/model-facing-tools.test.ts`
- `npm test -- src/hooks/configured-hooks.test.ts src/commands/hooks.test.ts src/bin/bootstrap-services.test.ts`
- `npm test -- src/agents/role-definitions.test.ts src/agents/role.test.ts`
- `npm run typecheck`

Final reviewer checklist:

- The TUI slash surface contains only the minimal kept commands unless an extra command is fully wired and tested.
- No `/btw` or `/buddy` production references remain.
- Agents, skills, and hooks each have one live implementation path.
- Removed features are removed from UI text and tests, not hidden behind flags.
- No new shim, adapter, compatibility, bridge, wrapper, facade, proxy, or re-export-only modules were added.

## Prompt for Session A

Use this as the `/goal` body for a Codex session:

```text
AgenC runtime stabilization Session A: loader and slash core.

Read GOAL_DISCIPLINE.md first. Work in your own branch/worktree. Do not push, fetch, pull, bypass hooks, or hand-edit checklist completion state. This task is cleanup, not compatibility work: do not add shims, wrappers, adapters, re-export barrels, or hidden fallback paths.

Use RUNTIME-STABILIZATION-GOALS-2026-05-12.md as the source of truth. Own RS-01 and the core dispatch parts of RS-02.

Objective:
1. Fix runtime load blockers:
   - runtime/src/utils/collapseReadSearch.ts must not require missing ./teamMemoryOps.js in source tests.
   - runtime/src/tools.ts must not require missing cron .js files in source tests.
   - /reload-plugins cache clearing must not throw initialization-order errors. If plugin reload is not retained, remove the command from the TUI slash surface rather than hiding it.
2. Collapse slash core dispatch:
   - The live TUI must not build a fresh default registry inside every submit.
   - TUI, daemon slash wrapper, palette/listing, and dispatcher tests must agree on one registry/dispatch path.
   - Unknown skill slash behavior must be consistent across entrypoints or intentionally removed.

Acceptance gates:
- npm test -- src/bin/agenc.user-prompt-submit.test.ts
- npm test -- src/bin/slash.test.ts src/commands/reload-plugins.test.ts
- npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/commands/dispatcher.test.ts
- npm test -- src/tui/components/App.render.test.tsx

Reviewer instructions:
Act as a senior engineer. Reject the work if it hides broken commands instead of removing or fixing them, if registry state is still per-submit and disposable, if production imports only work because tests mock around them, or if any shim/wrapper/barrel module is added.
```

## Prompt for Session B

Use this as the `/goal` body for a Codex session:

```text
AgenC runtime stabilization Session B: TUI command removal, skills, and hooks.

Read GOAL_DISCIPLINE.md first. Work in your own branch/worktree. Do not push, fetch, pull, bypass hooks, or hand-edit checklist completion state. This task removes unsupported UI instead of hiding it. If a command is not fully working through the live App path with tests, remove it from code, UI text, registry/listing, and tests.

Use RUNTIME-STABILIZATION-GOALS-2026-05-12.md as the source of truth. Own the command-removal sweep in RS-02 plus RS-03 and RS-05.

Objective:
1. Remove stale slash commands and UI references:
   - Remove /btw completely: command expectations, sideQuestion helper, highlighting, help text, spinner tips, and tests.
   - Remove /buddy completely: footer submission path, highlighting, comments, stale imports, and tests.
   - Remove any other non-minimal slash command you touch unless you make it genuinely live and tested.
2. Make skills work:
   - Decide and implement the supported skill roots for AgenC.
   - /skills and model-facing Skill must see and load the same available skills.
   - Skill cache invalidation must not rely on a broken plugin reload path.
3. Make hooks honest:
   - Verify retained hook events have live paths.
   - Wire SessionStart through live bootstrap exactly once, or remove SessionStart from supported config/schema/tests.

Acceptance gates:
- npm test -- src/skills/local-loader.test.ts src/commands/skills.test.ts src/bin/model-facing-tools.test.ts
- npm test -- src/hooks/configured-hooks.test.ts src/commands/hooks.test.ts src/bin/bootstrap-services.test.ts
- npm test -- src/bin/agenc.user-prompt-submit.test.ts
- npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts
- rg -n "btw|buddy" runtime/src --glob '*.ts' --glob '*.tsx' must show no production references except intentional audit docs.

Reviewer instructions:
Reject the work if /btw or /buddy are merely hidden, if skills listed by /skills differ from skills loadable by the Skill tool, if SessionStart remains advertised without a live dispatch path, or if stale UI text still advertises removed commands.
```

## Prompt for Session C

Use this as the `/goal` body for a Codex session:

```text
AgenC runtime stabilization Session C: agents and dead-path cleanup.

Read GOAL_DISCIPLINE.md first. Work in your own branch/worktree. Do not push, fetch, pull, bypass hooks, or hand-edit checklist completion state. This task removes crossover code and makes one implementation canonical. Do not add shims, wrappers, adapters, compatibility files, re-export barrels, or hidden legacy paths.

Use RUNTIME-STABILIZATION-GOALS-2026-05-12.md as the source of truth. Own RS-04 and RS-06.

Objective:
1. Make MultiAgentV2 the only model-facing agent system:
   - Keep spawn_agent and related MultiAgentV2 tools canonical.
   - Remove old AgentTool/SkillTool exposure from live base tool surfaces if retired.
   - Decide custom markdown agents: either register them into the same role registry spawn_agent uses, or remove old live-path implications that they are supported.
   - TUI role definitions and spawn_agent must read the same role registry.
2. Remove dead/crossover code:
   - Delete old TUI/REPL/input/agent paths that are no longer live after Sessions A/B land.
   - Delete helpers and tests for removed commands.
   - Remove stale comments claiming unsupported commands/features exist.
   - Do not replace deleted code with wrappers or compatibility paths.

Acceptance gates:
- npm test -- src/agents/role-definitions.test.ts src/agents/role.test.ts src/tools/AgentTool/loadAgentsDir.test.ts src/bin/model-facing-tools.test.ts
- npm test -- src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/tui/components/App.render.test.tsx
- rg -n "AgentTool|agent_tool|SkillTool" runtime/src --glob '*.ts' --glob '*.tsx' must show no live model-facing exposure of retired tools.
- rg -l "@ts-nocheck" runtime/src --glob '*.ts' --glob '*.tsx' | wc -l must not increase.
- rg -l "moved-source|donor-purge|placeholder|not implemented|DEPRECATED" runtime/src --glob '*.ts' --glob '*.tsx' | wc -l must not increase.

Reviewer instructions:
Reject the work if there are still two agent systems in live paths, if TUI role presentation and spawn_agent disagree, if old deleted paths are preserved through forwarding modules, or if tests still assert removed behavior.
```

