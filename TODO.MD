# TODO.MD - AgenC TUI UX Issue Backlog

Generated from four specialist TUI probes plus manual reproduction on 2026-05-12.

## Working Rules

- Treat this file as the source of truth for the current TUI UX/debug backlog.
- Mark an item `[x]` only after the code fix is implemented, targeted tests pass, and the behavior is verified through real `agenc` or `agenc --yolo` usage from `/tmp`.
- Add a short `Fixed in:` note under completed items with the relevant commit or file list.
- Do not mark partial mitigations as complete. If an item splits into smaller bugs, add child checklist items and keep the parent open until all children are done.
- Keep new discoveries in this file rather than scattering notes across chat transcripts.

## Required Reproduction Matrix

Use fresh throwaway directories under `/tmp` while working these items:

- `agenc` normal mode in a fresh `/tmp` project.
- `agenc --yolo` in a fresh `/tmp` project.
- First-run onboarding with an isolated `AGENC_HOME`.
- Slash commands including `/help`, `/plan`, `/agents`, `/config`, `/provider`, `/mcp`, `/skills`, `/model`, `/compact`, `/hooks`, `/history`, `/clear`, `/exit`.
- A code-writing prompt that triggers file reads/writes and permission prompts.
- A prompt that asks the agent to create/use subagents.

## P0 - Blockers

### TUI-001 - Daemon startup and transport break under isolated homes

- [x] Fix fixed websocket port collisions across isolated `AGENC_HOME` instances.
- [x] Fix `connect ENOENT .../daemon.sock` when daemon exits after websocket `EADDRINUSE`.
- [x] Fix `read ECONNRESET` after setting a non-default websocket port.
- [x] Fix `agenc agent list` hanging when it starts a daemon in an isolated environment.
- [x] Add regression coverage for multiple isolated homes running concurrently.

Fixed in:

- `runtime/src/app-server/daemon-cli.ts`
- `runtime/src/app-server/daemon-cli.contract.test.ts`

Verification:

- Reproduced pre-fix `listen EADDRINUSE: address already in use 127.0.0.1:7766` from a fresh isolated `AGENC_HOME`.
- Reproduced pre-fix `connect ENOENT /tmp/.../daemon.sock` and `agenc agent list` timeout from `/tmp`.
- Verified post-fix foreground daemon with isolated `AGENC_HOME` binds an ephemeral websocket port.
- Verified post-fix concurrent `agenc agent list` from two isolated `/tmp` homes returns `No active agents`.
- Verified explicit non-default `AGENC_DAEMON_WEBSOCKET_PORT` still works.
- Targeted tests passed: `npm test -- src/app-server/daemon-cli.contract.test.ts -t "pins daemon websocket defaults|multiple configured daemon homes"`.
- Build passed: `npm run build`.
- TUI gate passed: `node /home/tetsuo/.claude/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --no-build`.

Evidence:

- Specialist probes in `/tmp` hit daemon shutdowns and socket failures before TUI workflows could complete.
- Setting `AGENC_DAEMON_WEBSOCKET_PORT=17766` avoided the first collision but still caused reset/shutdown behavior.
- `daemon-snapshot.json` showed no active agents after a prompt-driven subagent workflow stalled.

Likely code to inspect:

- `runtime/src/app-server/daemon-cli.ts`
- `runtime/src/app-server/daemon-autostart.ts`
- `runtime/src/app-server/transport/websocket.ts`
- `runtime/src/app-server/agent-cli.ts`
- `runtime/src/tui/daemon-session.ts`

### TUI-002 - First-run onboarding and trust prompts are hard to escape or complete

- [x] Make `--yolo` either bypass trust/onboarding when intended or clearly explain why it cannot.
- [x] Fix trust prompt keyboard handling so advertised `y/n` input works reliably.
- [x] Fix onboarding composer text retention where entries become `1next` or `dark1next`.
- [x] Make `/help` and `/exit` work during onboarding, or show an explicit onboarding-only input state.
- [x] Fix repeated Ctrl-C behavior so the second press exits reliably.

Fixed in:

- `runtime/src/bin/agenc.ts`
- `runtime/src/bin/tui-trust-prompt.tsx`
- `runtime/src/permissions/trust/TrustDialog.tsx`
- `runtime/src/onboarding/Onboarding.tsx`
- `runtime/src/tui/components/App.tsx`
- `runtime/src/tui/ink/parse-keypress.ts`
- `runtime/src/tui/ink/parse-keypress.test.ts`
- `runtime/src/onboarding/onboarding.test.tsx`
- `runtime/src/bin/project-trust-preflight.test.ts`

Verification:

- Reproduced pre-fix `agenc --yolo` trust prompt ignoring `y` + Enter in a fresh `/tmp` home.
- Reproduced pre-fix onboarding composer retention after `next`, where the following input could appear as stale merged text.
- Reproduced pre-fix repeated Ctrl-C failing to exit onboarding.
- Verified post-fix trust prompt explains why `--yolo` still requires project trust, and accepts `y` + Enter in one input burst.
- Verified post-fix first-run onboarding explains that `--yolo` applies to tool approval while setup still needs first-run choices.
- Verified post-fix onboarding shows an onboarding-only slash-command state and returns that guidance for `/help`.
- Verified post-fix onboarding clears the composer after submitted steps and double Ctrl-C exits from a fresh `/tmp` TUI.
- `npm run test --workspace=@tetsuo-ai/runtime -- src/onboarding/onboarding.test.tsx src/bin/project-trust-preflight.test.ts src/tui/ink/parse-keypress.test.ts` passed.
- `npm run build` passed.
- `node /home/tetsuo/.claude/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --no-build` passed.

Evidence:

- `agenc --yolo` still showed trust and first-run onboarding.
- Trust prompt advertised `y/n`, but `y` plus Enter did not accept until arrow navigation was used.
- Onboarding retained stale typed text across steps.
- Slash commands were swallowed as onboarding answers.

Likely code to inspect:

- `runtime/src/permissions/trust/TrustDialog.tsx`
- `runtime/src/tui/components/TrustDialog/TrustDialog.tsx`
- `runtime/src/onboarding/Onboarding.tsx`
- `runtime/src/tui/components/Onboarding.tsx`
- `runtime/src/tui/components/PromptInput/PromptInput.tsx`

### TUI-003 - Slash commands crash because daemon TUI context lacks services

- [x] Fix `/config`: `ConfigStore not initialised`.
- [x] Fix `/settings`: same missing config store path as `/config`.
- [x] Fix `/provider grok`: `Cannot read properties of undefined (reading 'unsafePeek')`.
- [x] Fix `/mcp`: `Cannot read properties of undefined (reading 'effectiveServers')`.
- [x] Fix `/skills`: `Cannot read properties of undefined (reading 'skillsForConfig')`.
- [x] Add command execution tests with the same context shape used by daemon-backed TUI sessions.

Fixed in:

- `runtime/src/app-server-client/index.ts`
- `runtime/src/app-server-client/index.test.ts`
- `runtime/src/commands/provider.ts`
- `runtime/src/tui/components/App.tsx`
- `runtime/src/tui/session-types.ts`

Verification:

- Reproduced pre-fix from `/tmp/agenc-tui-003-config` with isolated `AGENC_HOME`: `/config`, `/settings`, `/provider grok`, `/mcp`, and `/skills` each returned the listed service/`unsafePeek` errors.
- Verified post-fix from `/tmp/agenc-tui-003-verify` with isolated `AGENC_HOME` and `agenc --yolo`: `/config` and `/settings` render config, `/provider grok` returns a daemon-unsupported guidance message instead of crashing, `/mcp` reports no configured servers, and `/skills` reports no available/invoked/plugin-root skills.
- `npm run test --workspace=@tetsuo-ai/runtime -- src/app-server-client/index.test.ts src/commands/provider.test.ts src/commands/mcp.test.ts src/commands/skills.test.ts` passed.
- `npm run build` passed.
- `node /home/tetsuo/.claude/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --no-build` passed.

Evidence:

- Slash commands are visible/advertised but fail at runtime due to missing session services.

Likely code to inspect:

- `runtime/src/commands/registry.ts`
- `runtime/src/commands/config.ts`
- `runtime/src/commands/provider.ts`
- `runtime/src/commands/mcp.ts`
- `runtime/src/commands/skills.ts`
- `runtime/src/commands/dispatcher.ts`
- `runtime/src/app-server-client/index.ts`

### TUI-004 - `/plan` and `/agents` are implemented but unavailable in the TUI

- [x] Register `/plan` in the active TUI slash command registry.
- [x] Register `/agents` in the active TUI slash command registry.
- [x] Verify `/plan` can enter plan flow from the TUI.
- [x] Verify `/agents` opens agent management or creation UX from the TUI.
- [x] Add a parity check so implemented commands do not silently fall out of the active registry.

Fixed in:

- `runtime/src/commands/agent-management.tsx`
- `runtime/src/commands/registry.ts`
- `runtime/src/commands/types.ts`
- `runtime/src/tui/components/App.tsx`
- `runtime/src/app-server-client/index.test.ts`
- `runtime/src/commands/registry.test.ts`
- `runtime/src/commands/tui-command-list.test.ts`
- `runtime/src/commands/command-surface.test.ts`
- `runtime/src/commands/help.test.ts`

Verification:

- Reproduced pre-fix `/plan` and `/agents` as unknown slash commands from the TUI registry.
- Verified post-fix from `/tmp/agenc-tui-004-verify2` with isolated `AGENC_HOME` and `agenc --yolo`: `/plan` appears in slash typeahead, returns `Enabled plan mode`, and switches the footer to `MODE plan`.
- Verified post-fix `/agents` appears in slash typeahead, opens the agent management menu, and Enter opens the `Create new agent` wizard without forwarding `/agents` to the model.
- `npm run test --workspace=@tetsuo-ai/runtime -- src/app-server-client/index.test.ts src/commands/registry.test.ts src/commands/tui-command-list.test.ts src/commands/command-surface.test.ts src/commands/help.test.ts src/commands/plan.test.ts` passed.
- `npm run build` passed.
- `node /home/tetsuo/.claude/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --no-build` passed.

Evidence:

- `/plan` returns `Unknown command: /plan` even though plan command code exists.
- `/agents` returns `Unknown command: /agents` even though `AgentsMenu` and create wizard code exists.
- The requested specialist workflows could not exercise plan mode or agent creation through slash commands.

Likely code to inspect:

- `runtime/src/commands/registry.ts`
- `runtime/src/commands.ts`
- `runtime/src/commands/plan.ts`
- `runtime/src/commands/agents/index.ts`
- `runtime/src/tui/components/agents/AgentsMenu.tsx`

### TUI-005 - Permission denial leaks raw internal recovery JSON

- [ ] Replace raw recovered tool-result JSON with a user-facing denial message.
- [ ] Preserve enough debug metadata in logs without showing it in the transcript.
- [ ] Add a regression test for denied `FileRead` and denied write/tool calls.

Evidence:

- Denying a `FileRead` produced:

```text
Recovered tool result without matching start (call_...): { "type": "text", "text": "{\"error\":\"rejected by user\"}" }
```

Likely code to inspect:

- `runtime/src/tui/permission-requests.tsx`
- `runtime/src/tui/components/permissions/`
- `runtime/src/permissions/`
- `runtime/src/tui/session-transcript.ts`

## P1 - High Priority UX Issues

### TUI-006 - Advertised slash commands are not supported in daemon TUI

- [ ] Decide whether `/model`, `/compact`, and `/hooks` should be daemon-backed or hidden.
- [ ] Make unsupported commands absent from suggestions/help, or implement them end to end.
- [ ] Add a command capability source so help, suggestions, and dispatcher agree.

Evidence:

- `/model grok-4-fast`, `/compact`, and `/hooks` were advertised but not supported in daemon-backed TUI usage.

Likely code to inspect:

- `runtime/src/commands/registry.ts`
- `runtime/src/commands.ts`
- `runtime/src/tui/components/PromptInput/PromptInputFooterSuggestions.tsx`

### TUI-007 - `/history` behaves as a destructive alias for `/clear`

- [ ] Make `/history` show history or remove/rename it.
- [ ] If the intended behavior is clearing history, require explicit naming and confirmation.
- [ ] Add a regression test to prevent accidental destructive aliases.

Evidence:

- `/history` immediately clears session history, matching `/clear`, which is surprising and dangerous.

Likely code to inspect:

- `runtime/src/commands/clear.ts`
- `runtime/src/commands/registry.ts`

### TUI-008 - Prompt-driven subagent workflow stalls at `Triggering...`

- [ ] Show agent lifecycle state when a subagent is requested.
- [ ] Fix the path where a requested subagent never appears in daemon snapshots.
- [ ] Surface failures in the transcript instead of leaving `Triggering...`.
- [ ] Verify both prompt-driven subagent creation and `/agents` creation once `/agents` is registered.

Evidence:

- A prompt asking the agent to create/use subagents stayed at `Triggering...`.
- `daemon-snapshot.json` reported `"agents": []`.

Likely code to inspect:

- `runtime/src/tools/AgentTool/AgentTool.tsx`
- `runtime/src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `runtime/src/tui/components/AgentProgressLine.tsx`
- `runtime/src/tui/components/agents/AgentsMenu.tsx`

### TUI-009 - Slash palette can trap focus and Enter inserts blank composer lines

- [ ] Fix focus handling when slash suggestions/help is open.
- [ ] Ensure Enter either runs the selected command or closes the palette according to the displayed hint.
- [ ] Prevent blank line insertion when the palette owns selection.

Evidence:

- `/help` and slash palette interactions could trap focus.
- Pressing Enter inserted blank lines in the composer instead of consistently selecting/running.

Likely code to inspect:

- `runtime/src/tui/components/PromptInput/PromptInput.tsx`
- `runtime/src/tui/components/PromptInput/PromptInputFooterSuggestions.tsx`

### TUI-010 - Slash palette selected row duplicates description and background leaks through

- [ ] Remove duplicate selected-row description rendering, or render description in exactly one place.
- [ ] Make slash palette rows and expanded description rows full-width and opaque.
- [ ] Fix black/background fill so the overlay covers the full intended panel width, including empty cells.
- [ ] Add a screenshot or snapshot check for selected slash command rendering.

Evidence:

- Screenshot showed `/clear` highlighted with `Clear session history and caches` inline, then the same description repeated on the next row.
- The black palette background did not fill the entire window/palette area; underlying wallpaper showed through.
- Header hint also clipped to `navigate ... ru`, suggesting width/accounting issues in the same component.

Likely cause:

- `SuggestionItemRow` renders `item.description` inline for non-unified suggestions.
- The parent map also renders the selected item's description as an expanded row.
- The overlay and selected-description row do not appear to consistently use full-width opaque background.

Likely code to inspect:

- `runtime/src/tui/components/PromptInput/PromptInputFooterSuggestions.tsx`
- `runtime/src/tui/components/PromptInput/PromptInput.tsx`

### TUI-011 - Render health warning reports impossible/noisy FPS metrics

- [ ] Fix FPS math so 1 percent low cannot appear higher than average for the same sample window.
- [ ] Reduce prominence/noise of render-health warnings unless the metric is reliable and actionable.
- [ ] Add tests for FPS aggregation and display formatting.

Evidence:

- Warning displayed average `3.8 FPS` and `1% low 160.2 FPS`, which is internally inconsistent.

Likely code to inspect:

- `runtime/src/utils/fpsTracker.ts`
- `runtime/src/tui/components/App.tsx`

## P2 - Polish and Consistency

### TUI-012 - Slash palette header hint is clipped

- [ ] Fix right-side header hint clipping.
- [ ] Verify narrow and wide terminal widths.

Evidence:

- Slash palette hint rendered as `navigate ... ru` instead of the full `navigate ... run`.

Likely code to inspect:

- `runtime/src/tui/components/PromptInput/PromptInputFooterSuggestions.tsx`

### TUI-013 - Invalid slash commands show random spinner verbs

- [ ] Replace random spinner verbs for immediate command errors with deterministic command feedback.
- [ ] Ensure `Unknown command` appears without misleading transitional states.

Evidence:

- Invalid commands briefly showed unrelated verbs such as `Embedding...` or `Transcoding...`.

Likely code to inspect:

- `runtime/src/commands/dispatcher.ts`
- `runtime/src/constants/spinnerVerbs.ts`
- `runtime/src/tui/session-transcript.ts`

### TUI-014 - Permission prompt copy and wrapping are awkward

- [ ] Improve permission option labels for non-shell tools.
- [ ] Avoid wording such as `FileRead commands`.
- [ ] Ensure long paths wrap cleanly without harming selection readability.

Evidence:

- Permission option said `Yes, and don't ask again for FileRead commands in /tmp/...`.
- This is confusing for file reads and wraps poorly.

Likely code to inspect:

- `runtime/src/tui/permission-requests.tsx`
- `runtime/src/tui/components/permissions/`
- `runtime/src/permissions/`

## Verification Checklist

- [ ] `npm run build` or repository equivalent passes.
- [ ] TUI validation gate passes if TUI files changed.
- [ ] Real `agenc` from `/tmp` can complete onboarding/trust flow.
- [ ] Real `agenc --yolo` from `/tmp` behaves according to intended trust/onboarding policy.
- [ ] `/plan` works in TUI.
- [ ] `/agents` works in TUI and can start an agent workflow.
- [ ] Slash command help/suggestions only advertise runnable commands.
- [ ] Permission deny/allow flows show user-facing messages only.
- [ ] Slash palette selected row has no duplicate description.
- [ ] Slash palette background is opaque across the full intended width.
- [ ] Multiple isolated `AGENC_HOME` sessions can run without daemon port/socket collisions.

## Goal Prompt For The Next Agent

You are working in `/home/tetsuo/git/AgenC/agenc-core`. Read `TODO.MD` first and treat it as the active TUI UX/debug backlog. Work through the checklist from P0 downward. For each issue, reproduce it in a fresh `/tmp` directory with real `agenc` or `agenc --yolo`, identify the responsible code, implement the smallest correct fix, run targeted tests plus the TUI validation gate when TUI code changes, then update `TODO.MD` by marking only fully verified items as `[x]` and adding a short `Fixed in:` note. Do not skip verification, do not mark partial fixes complete, and keep all reproduction artifacts under `/tmp`.
