# AGENC-TUI-SURFACE.md

## Top-level TUI screens & layouts

### App Shell
- Main app provider - `runtime/src/tui/components/App.tsx:2394`; wraps `PromptOverlayProvider`, `KeybindingSetup`, and `AgenCTuiShell`; can open permission, elicitation, exit, cost, message selector, slash-command, and prompt-overlay surfaces.
- TUI shell - `runtime/src/tui/components/App.tsx:1362`; owns session state, app state, command state, background task state, approval state, overlays, transcript, and prompt dispatch.
- Fullscreen shell - `runtime/src/tui/components/FullscreenLayout.tsx:326`; frames top chrome, scrollback, prompt, modal layer, suggestion layer, new-message pill, and bottom chrome.
- Non-fullscreen fallback - `runtime/src/tui/components/FullscreenLayout.tsx:489`; renders body/content/modal/footer without design chrome.
- Top chrome - `runtime/src/tui/components/FullscreenLayout.tsx:522`; shows brand, cwd, permission mode, active task PDA, and live/warn tab state.
- Bottom chrome - `runtime/src/tui/components/FullscreenLayout.tsx:547`; shows mode, cwd, MCP count, message count, and agent/task status.
- Prompt overlay slot - `runtime/src/tui/components/FullscreenLayout.tsx:726`; hosts dialog-style prompt overlays above the composer.
- Suggestion overlay slot - `runtime/src/tui/components/FullscreenLayout.tsx:703`; hosts prompt suggestions and slash-command palette above the composer.

### Startup And Welcome
- Startup status line - `runtime/src/tui/startup/StatusLine.tsx:328`; optional command-backed status line before and during the session.
- Startup notices - `runtime/src/tui/startup/StatusNotices.tsx:38`; shows memory, daemon, auth, and IDE/plugin warnings from `runtime/src/tui/startup/statusNoticeDefinitions.tsx:237`.
- Standalone onboarding screen - `runtime/src/tui/components/App.tsx:2273`; first-run flow with `/exit`, `/quit`, `/next`, `/skip`, `/done`, and `/test` prompt commands.
- Empty transcript welcome - `runtime/src/tui/components/Messages.tsx:588`; shows logo/header content when no renderable messages exist.
- V2 cold welcome panel - `runtime/src/tui/components/v2/primitives.tsx:692`; design-system welcome with network, version, cwd, git, token, wallet, stake, rep, slashed, help, and claim hints.
- Auto-updater banner/status - `runtime/src/tui/components/AutoUpdater.tsx:24`; checks updates and shows updating, success, or failure states.

### Main Session
- Transcript screen - `runtime/src/tui/components/Messages.tsx:523`; scrollback renderer for user, assistant, system, tool, attachment, plan, protocol, and agent messages.
- Message row shell - `runtime/src/tui/components/MessageRow.tsx:93`; applies streaming state, collapse rules, transcript metadata, and row chrome.
- Prompt composer - `runtime/src/tui/components/PromptInput/PromptInput.tsx:559`; user input, slash-command entry, file/image paste, history, IDE mentions, queued commands, fast-mode picker, and footer controls.
- Prompt mode indicator - `runtime/src/tui/components/PromptInput/PromptInputModeIndicator.tsx:71`; shows normal prompt pointer or bash-mode `!` state.
- Prompt footer - `runtime/src/tui/components/PromptInput/PromptInputFooter.tsx:62`; shows mode, model/status hints, IDE status, footer actions, and selected footer items.
- Queued commands strip - `runtime/src/tui/components/PromptInput/PromptInputQueuedCommands.tsx:132`; lists queued prompt commands before execution.
- Sticky prompt header - `runtime/src/tui/components/FullscreenLayout.tsx:655`; appears when content scrolls behind the prompt area.
- New messages pill - `runtime/src/tui/components/FullscreenLayout.tsx:595`; jumps to bottom or reports `N new messages`.

### Plan And Review
- Plan mode banner - `runtime/src/tui/components/FullscreenLayout.tsx:509`; announces plan mode inside the fullscreen scrollback.
- V2 plan banner - `runtime/src/tui/components/v2/primitives.tsx:503`; compact `plan mode` row with reviewer-style hinting.
- Plan approval message - `runtime/src/tui/message-renderers/PlanApprovalMessage.tsx:18`; transcript card for requested plan review.
- Plan approval response - `runtime/src/tui/message-renderers/PlanApprovalMessage.tsx:78`; transcript card for approved or rejected plan result.
- Plan list - `runtime/src/tui/components/v2/primitives.tsx:928`; renders plan items with `✓`, `▮`, `·`, and `✕`.
- Review-mode system rows - `runtime/src/tui/session-transcript.ts:2349`; transcript handling for `plan_started`, `plan_item_completed`, `entered_review_mode`, and `exit_review_mode`.

### Slash Registry Screens
- Help screen - `runtime/src/tui/components/HelpV2/HelpV2.tsx:22`; opened by `/help`; can show general help or commands via `runtime/src/tui/components/HelpV2/Commands.tsx:17`.
- Status dashboard - `runtime/src/commands/status-menu.tsx:172`; opened by `/status`; can inspect model, mode, git, session, and app state.
- Model menu - `runtime/src/commands/model-menu.tsx:310`; opened by `/model`; can switch provider/model rows.
- Provider menu - `runtime/src/commands/provider-menu.tsx:586`; opened by `/provider`; can inspect configured providers and auth state.
- Permissions menu - `runtime/src/commands/permissions.ts:625`; opened by `/permissions`; can inspect and change permission mode/rules.
- Plan menu - `runtime/src/commands/plan.ts:206`; opened by `/plan`; enters or exits plan mode and can show plan actions.
- Agents menu - `runtime/src/commands/agents-menu.tsx:591`; opened by `/agents`; can list, create, edit, and delete agent definitions.
- Background tasks screen - `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx:412`; opened by `/tasks`; can inspect, follow, stop, or view background work.
- Config menu - `runtime/src/commands/config-menu.tsx:268`; opened by `/config`; shows config files, tools, providers, agents, MCP, permissions, hooks, and status rows.
- Hooks menu - `runtime/src/commands/hooks-menu.tsx:427`; opened by `/hooks`; can inspect hooks, test edits, and show runtime-unavailable state.
- Skills menu - `runtime/src/commands/skills-menu.tsx:99`; opened by `/skills`; can browse available skill roots and invoked skills.
- MCP menu - `runtime/src/commands/mcp-menu.tsx:295`; opened by `/mcp`; can list servers, tools, tool details, and add server config.
- Plugins menu - `runtime/src/commands/plugins.tsx:104`; opened by `/plugins`; shows loaded plugins and marketplace/plugin state.
- Memory menu - `runtime/src/commands/memory/memory.tsx:195`; opened by `/memory`; can open user, project, auto, or agent memory files/folders.
- Resume menu - `runtime/src/commands/resume-menu.tsx:23`; opened by `/resume`; can select a previous session.
- Context usage modal - `runtime/src/tui/components/v2/ContextUsageModal.tsx:269`; opened by `/context`; shows token and context-window usage.
- Diff menu - `runtime/src/commands/diff-menu.tsx:244`; opened by `/diff`; shows git status, staged/unstaged/untracked summaries, and diff actions.

### Background And Multi-agent
- Coordinator task panel - `runtime/src/tui/components/CoordinatorAgentStatus.tsx:75`; visible when coordinator/sub-agent/task state exists.
- Agent progress line - `runtime/src/tui/components/AgentProgressLine.tsx:24`; inline background-agent progress row.
- Background task status strip - `runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx:25`; compact active-task pills and shortcut hint.
- Task detail modal - `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx:621`; detailed background task view from the tasks screen.
- Teams dialog - `runtime/src/tui/components/teams/TeamsDialog.tsx:92`; team/agent assignment surface with list and detail panes.

### Exit And Interrupt
- Exit flow - `runtime/src/tui/components/ExitFlow.tsx:17`; handles quit and worktree cleanup routing.
- Worktree exit dialog - `runtime/src/tui/components/WorktreeExitDialog.tsx:35`; asks whether to keep or remove a worktree on exit.
- Interrupt keybinding - `runtime/src/tui/keybindings/defaultBindings.ts:37`; global `ctrl+c` triggers `app:interrupt`.
- Exit keybinding - `runtime/src/tui/keybindings/defaultBindings.ts:42`; global `ctrl+d` triggers `app:exit`.

### IDE, Voice, And Updaters
- IDE onboarding dialog - `runtime/src/tui/components/IdeOnboardingDialog.tsx:25`; guides terminal IDE integration setup.
- IDE status indicator - `runtime/src/tui/components/IdeStatusIndicator.tsx:14`; shows selected lines or current IDE file.
- Realtime voice panel - `runtime/src/tui/realtime/RealtimePanel.tsx:68`; shows voice transport, mic/PTT state, meter, transcript, and errors.
- Fast-mode picker - `runtime/src/tui/components/PromptInput/PromptInput.tsx:177`; inline ON/OFF selector for fast mode.
- Fast icon - `runtime/src/tui/components/FastIcon.tsx:13`; lightning indicator for fast mode and cooldown.
- Diagnostics display - `runtime/src/tui/components/DiagnosticsDisplay.tsx:17`; shows IDE diagnostics summaries and verbose details.
- Token warning - `runtime/src/tui/cost/TokenWarning.tsx:16`; warns when remaining context is low.
- Rate-limit panel - `runtime/src/tui/components/dialogs/RateLimitMessage.tsx:75`; shows rate-limit details and upgrade/reset messaging.

## Every modal / popup / overlay

### Global Overlay Stack
- Permission overlay - `runtime/src/tui/permission-requests.tsx:257`; triggered by tool permission requests; shows tool name, risk, scope, command/input, facts, and approve/deny controls; keys from `runtime/src/tui/permission-requests.tsx:344` and typed gate from `runtime/src/tui/permission-requests.tsx:356`.
- AgenC approval overlay - `runtime/src/tui/permission-requests.tsx:324`; triggered for TUI-branded approval cards; low risk uses `confirm:yes`, `confirm:no`, `app:interrupt`; high risk requires typing `settle`, `stake`, `transfer`, or `yes`.
- Elicitation overlay - `runtime/src/tui/components/App.tsx:843`; triggered by `request_user_input`, MCP form, or MCP URL pending state; shows title, message, detail, text/form placeholder, and submit/cancel affordance.
- Modal overlay slot - `runtime/src/tui/components/FullscreenLayout.tsx:472`; triggered by modal tool JSX; floats over scrollback with a divider.
- Prompt dialog overlay - `runtime/src/tui/components/FullscreenLayout.tsx:726`; triggered by prompt overlay provider; hosts dialogs such as auto-mode opt-in.
- Suggestions overlay - `runtime/src/tui/components/FullscreenLayout.tsx:703`; triggered by prompt suggestions or slash palette; navigated by autocomplete/select keys.

### Core Dialogs And Pickers
- Dialog shell - `runtime/src/tui/components/design-system/Dialog.tsx:43`; shared frame for title, subtitle, footer, and optional input guide.
- Fuzzy picker - `runtime/src/tui/components/design-system/FuzzyPicker.tsx:86`; shared list picker; keys include `up`/`ctrl+p`, `down`/`ctrl+n`, `return`, `tab`, `shift+tab`, and `escape` from `runtime/src/tui/components/design-system/FuzzyPicker.tsx:144`.
- Global search dialog - `runtime/src/tui/components/GlobalSearchDialog.tsx:70`; triggered by global search key; shows fuzzy search over transcript/items; uses `FuzzyPicker`.
- Quick open dialog - `runtime/src/tui/components/QuickOpenDialog.tsx:46`; triggered by quick-open key; shows fuzzy command/file/open targets; uses `FuzzyPicker`.
- History search dialog - `runtime/src/tui/history/HistorySearchDialog.tsx:29`; triggered by `history:search`; shows prompt history in `FuzzyPicker`.
- Message selector - `runtime/src/tui/components/MessageSelector.tsx:92`; triggered by transcript selection; shows message list, diff stats, preview, and restore/select actions; keys from `runtime/src/tui/components/MessageSelector.tsx:319`.
- Model picker - `runtime/src/tui/components/ModelPicker.tsx:41`; triggered by model selection; shows model list, effort selector, provider/model metadata; left/right adjust effort from `runtime/src/tui/components/ModelPicker.tsx:208`.
- Context usage modal - `runtime/src/tui/components/v2/ContextUsageModal.tsx:269`; triggered by `/context`; shows parsed token rows, progress bars, and raw fallback; closes with modal/select cancel keys.
- MCP desktop import dialog - `runtime/src/tui/components/MCPServerDesktopImportDialog.tsx:19`; triggered when importing desktop MCP servers; shows multi-select server list via `SelectMulti` at `runtime/src/tui/components/MCPServerDesktopImportDialog.tsx:166`.
- IDE onboarding dialog - `runtime/src/tui/components/IdeOnboardingDialog.tsx:25`; triggered during IDE setup; shows onboarding copy and confirmation controls from `runtime/src/tui/components/IdeOnboardingDialog.tsx:41`.
- Auto-mode opt-in dialog - `runtime/src/tui/components/AutoModeOptInDialog.tsx:17`; triggered before enabling auto mode; shows allow/deny options with `Select` and title at `runtime/src/tui/components/AutoModeOptInDialog.tsx:130`.
- Paste confirm dialog - `runtime/src/tui/components/PasteConfirmDialog.tsx:27`; triggered for pasted bash/multiline text; keys `Esc`, `n/N`, `y/Y`, and `Enter` from `runtime/src/tui/components/PasteConfirmDialog.tsx:29`.
- Cost threshold dialog - `runtime/src/tui/components/dialogs/CostThresholdDialog.tsx:39`; triggered by cost threshold; shows continue/cancel choices via `Select`.
- Worktree exit dialog - `runtime/src/tui/components/WorktreeExitDialog.tsx:35`; triggered on exit from worktree; shows keep/remove/cancel actions and loading state.
- Teams dialog - `runtime/src/tui/components/teams/TeamsDialog.tsx:92`; triggered by teams/agents UI; keys for arrows, return, delete, mode cycling, and cancel from `runtime/src/tui/components/teams/TeamsDialog.tsx:159`.

### Command Menus
- Help modal - `runtime/src/tui/components/HelpV2/HelpV2.tsx:22`; triggered by `/help` or help key; shows general help or slash-command help.
- Status dashboard modal - `runtime/src/commands/status-menu.tsx:172`; triggered by `/status`; shows status rows and color/glyph states.
- Config menu modal - `runtime/src/commands/config-menu.tsx:268`; triggered by `/config`; shows settings/config rows and file locations.
- Diff menu modal - `runtime/src/commands/diff-menu.tsx:244`; triggered by `/diff`; shows working-tree diff summary and actions.
- Resume menu modal - `runtime/src/commands/resume-menu.tsx:23`; triggered by `/resume`; shows saved sessions.
- Agents menu modal - `runtime/src/commands/agents-menu.tsx:591`; triggered by `/agents`; list/detail/create/edit/delete modes.
- Hooks detail modal - `runtime/src/commands/hooks-menu.tsx:301`; triggered from `/hooks`; shows hook event, matcher, command, timeout, source, and status.
- Hooks edit modal - `runtime/src/commands/hooks-menu.tsx:366`; triggered from `/hooks`; test-edits hook fields.
- Hooks unavailable modal - `runtime/src/commands/hooks-menu.tsx:848`; triggered when hooks runtime is unavailable.
- MCP form modal - `runtime/src/commands/mcp-menu.tsx:226`; triggered by `/mcp new` or add action; shows server name and command fields.
- MCP menu modal - `runtime/src/commands/mcp-menu.tsx:295`; triggered by `/mcp`; list/tools/tool/form modes.
- Skills menu modal - `runtime/src/commands/skills-menu.tsx:99`; triggered by `/skills`; shows skill roots and selected skill detail.
- Memory command modal - `runtime/src/commands/memory/memory.tsx:195`; triggered by `/memory`; shows memory file/folder actions.
- Provider menu modal - `runtime/src/commands/provider-menu.tsx:586`; triggered by `/provider`; list/detail/auth modes.
- Model menu modal - `runtime/src/commands/model-menu.tsx:310`; triggered by `/model`; provider/model rows.
- Plugins menu modal - `runtime/src/commands/plugins.tsx:104`; triggered by `/plugins`; loaded plugin rows.
- Background tasks modal - `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx:412`; triggered by `/tasks`; list/detail panes and stop/follow actions.

### V2 Primitive Overlays
- Menu modal primitive - `runtime/src/tui/components/v2/primitives.tsx:1129`; generic bordered modal with active-row highlight, `esc dismiss`, and scroll status.
- Slash palette - `runtime/src/tui/components/v2/primitives.tsx:1288`; triggered by slash input; shows `slash commands · N`, active row, source-like description glyphs, hidden count, and `↑↓ navigate · ⏎ run · esc dismiss`.
- Approval card - `runtime/src/tui/components/v2/primitives.tsx:1059`; embedded in permission overlay; high risk uses `errorWash`, low risk uses `workerWash`, command block, facts, and typed confirmation hint.

## Slash commands

### Registry
- Unified registry - `runtime/src/commands/registry.ts:127`; source of built-in ordering and command inclusion.
- Static command loader - `runtime/src/commands.ts:292`; loads registry built-ins.
- Dynamic command loader - `runtime/src/commands.ts:403`; adds local, bundled, plugin skill, and plugin commands.
- Protocol command source - `runtime/src/commands/protocol.ts:49`; declares protocol commands with `source: "plugin"` and `kind: "protocol"`.

### Builtin Commands
- `/help` - source `builtin`; short help and command reference; opens modal; renders `HelpV2` at `runtime/src/tui/components/HelpV2/HelpV2.tsx:22`; command at `runtime/src/commands/help.ts:260`.
- `/status` - source `builtin`; runtime and session status dashboard; opens modal; renders `StatusDashboardView` at `runtime/src/commands/status-menu.tsx:172`; command at `runtime/src/commands/status.ts:287`.
- `/model` - source `builtin`; model/provider switcher; opens modal; renders `ModelMenuView` at `runtime/src/commands/model-menu.tsx:310`; command at `runtime/src/commands/model.ts:294`.
- `/provider` - source `builtin`; provider configuration/auth status; opens modal; renders `ProviderMenuView` at `runtime/src/commands/provider-menu.tsx:586`; command at `runtime/src/commands/provider.ts:189`.
- `/permissions` - source `builtin`; permission mode/rules table; opens modal; renders permissions menu from `runtime/src/commands/permissions.ts:625`; aliases `approvals`, `allowed-tools`; command at `runtime/src/commands/permissions.ts:608`.
- `/plan` - source `builtin`; enters/exits plan mode or shows plan options; runs inline plus optional modal; renders plan banner `runtime/src/tui/components/FullscreenLayout.tsx:509`; command at `runtime/src/commands/plan.ts:163`.
- `/agents` - source `builtin`; agent definition manager; opens modal; renders `AgentsMenuModal` at `runtime/src/commands/agents-menu.tsx:591`; command at `runtime/src/commands/agent-management.tsx:19`.
- `/tasks` - source `builtin`; background task list; opens modal; renders `BackgroundTasksPanel` at `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx:412`; aliases `jobs`, `bashes`; command at `runtime/src/commands/tasks.ts:213`.
- `/config` - source `builtin`; configuration dashboard; opens modal; renders `ConfigMenuView` at `runtime/src/commands/config-menu.tsx:268`; alias `settings`; command at `runtime/src/commands/config.ts:275`.
- `/hooks` - source `builtin`; hook browser/test editor; opens modal; renders `HooksMenuView` at `runtime/src/commands/hooks-menu.tsx:427`; command at `runtime/src/commands/hooks.ts:296`.
- `/skills` - source `builtin`; skill roots and skill launcher info; opens modal; renders `SkillsMenuView` at `runtime/src/commands/skills-menu.tsx:99`; command at `runtime/src/commands/skills.ts:375`.
- `/mcp` - source `builtin`; MCP server/tools/status/reconnect/enable/disable/add; opens modal or runs inline subcommand; renders `McpMenuView` at `runtime/src/commands/mcp-menu.tsx:295`; command at `runtime/src/commands/mcp.ts:700`.
- `/plugins` - source `builtin`; plugin and marketplace browser; opens modal; renders `PluginsMenuView` at `runtime/src/commands/plugins.tsx:104`; aliases `plugin`, `marketplace`; command at `runtime/src/commands/plugins.tsx:200`.
- `/memory` - source `builtin`; memory file/folder opener; opens modal; renders `MemoryCommand` at `runtime/src/commands/memory/memory.tsx:195`; command at `runtime/src/commands/memory/slash.ts:18`.
- `/resume` - source `builtin`; session picker/resume; opens modal unless direct session args are supplied; renders `ResumeMenuView` at `runtime/src/commands/resume-menu.tsx:23`; alias `sessions`; command at `runtime/src/commands/resume.ts:285`.
- `/clear` - source `builtin`; clears current session; runs inline; message text `Session cleared.`; command at `runtime/src/commands/clear.ts:161`.
- `/compact` - source `builtin`; compacts context/session history; runs inline with compact status path; command at `runtime/src/commands/session-compact.ts:83`.
- `/context` - source `builtin`; context usage display; opens modal; renders `ContextUsageModal` at `runtime/src/tui/components/v2/ContextUsageModal.tsx:269`; alias `ctx`; command at `runtime/src/commands/session-compact.ts:120`.
- `/diff` - source `builtin`; git diff/status summary; opens modal; renders `DiffMenuView` at `runtime/src/commands/diff-menu.tsx:244`; command at `runtime/src/commands/diff.ts:148`.
- `/exit` - source `builtin`; exits current session; runs inline and may open `ExitFlow` at `runtime/src/tui/components/ExitFlow.tsx:17`; alias `quit`; command at `runtime/src/commands/exit.ts:21`.

### Protocol Commands
- `/claim` - source `plugin`; protocol claim flow; runs inline; no modal; command source at `runtime/src/commands/protocol.ts:66`.
- `/delegate` - source `plugin`; protocol delegate flow; runs inline; no modal; command source at `runtime/src/commands/protocol.ts:67`.
- `/proof` - source `plugin`; protocol proof flow; runs inline; no modal; command source at `runtime/src/commands/protocol.ts:68`.
- `/settle` - source `plugin`; protocol settle flow; runs inline; no modal; command source at `runtime/src/commands/protocol.ts:70`.
- `/stake` - source `plugin`; protocol stake flow; runs inline; no modal; command source at `runtime/src/commands/protocol.ts:72`.

### Dynamic Commands
- Skill commands - source `plugin`; loaded from local/bundled/plugin skills; can run inline or return tool JSX; dynamic loader at `runtime/src/commands.ts:403`.
- Plugin commands - source `plugin`; loaded from plugin command providers; can run inline or open plugin-owned tool JSX; dynamic loader at `runtime/src/commands.ts:435`.

## Tools

### Transcript Rendering Defaults
- Tool-use row shell - `runtime/src/tui/message-renderers/AssistantToolUseMessage.tsx:48`; renders pending/running/done/failed tool rows and v2 `Tool` cards.
- Tool success result row - `runtime/src/tui/message-renderers/UserToolSuccessMessage.tsx:58`; renders approved tool results and expanded custom result views.
- Tool rejection row - `runtime/src/tui/message-renderers/UserToolRejectMessage.tsx:21`; renders denied/canceled tool results.
- Orphan tool result row - `runtime/src/tui/message-renderers/UserToolResultMessage.tsx:43`; handles unmatched tool-result messages.
- Tool result routing - `runtime/src/tui/tool-result-routing.ts:59`; dispatches custom result tags to expanded views.
- TUI tool renderer registry - `runtime/src/tui/tool-rendering.tsx:537`; defines summaries, user-facing names, activity text, and result renderers.

### File Tools
- `FileRead` - reads files; transcript uses `AssistantToolUseMessage` at `runtime/src/tui/message-renderers/AssistantToolUseMessage.tsx:48`; custom expanded view `FileReadView` at `runtime/src/tui/tool-rendering.tsx:121`.
- `Read` - model-facing alias for `FileRead`; transcript and expanded view same as `FileRead`; alias declared at `runtime/src/tools/canonicalToolSurface.ts:548`.
- `Edit` - edits one file; transcript uses tool rows; custom expanded view `EditDiffView` at `runtime/src/tui/tool-rendering.tsx:73`.
- `FileEdit` - alias for `Edit`; transcript and diff view same as `Edit`; alias declared at `runtime/src/tools/canonicalToolSurface.ts:563`.
- `MultiEdit` - applies multiple file edits; transcript uses generic tool row plus edit diff result when tagged; tool declared at `runtime/src/tools/system/file-edit.ts:964`.
- `Write` - writes file content; transcript uses tool row; custom expanded view `FileWriteView` at `runtime/src/tui/tool-rendering.tsx:148`.
- `FileWrite` - alias for `Write`; transcript and write summary same as `Write`; alias declared at `runtime/src/tools/canonicalToolSurface.ts:582`.
- `Glob` - finds paths by glob; transcript uses tool row; custom expanded view `GlobPathsView` at `runtime/src/tui/tool-rendering.tsx:211`.
- `Grep` - searches text; transcript uses tool row; custom expanded view `GrepMatchesView` at `runtime/src/tui/tool-rendering.tsx:168`.
- `system.grep` - canonical alias for `Grep`; transcript and expanded view same as `Grep`; alias declared at `runtime/src/tools/canonicalToolSurface.ts:600`.
- `system.glob` - canonical alias for `Glob`; transcript and expanded view same as `Glob`; alias declared at `runtime/src/tools/canonicalToolSurface.ts:614`.
- `NotebookEdit` - edits notebook cells; transcript uses generic tool row unless result is routed as file/edit content; tool declared at `runtime/src/tools/system/notebook-edit.ts:97`.
- `NotebookRead` - reads notebooks; transcript uses generic tool row; model-facing tool declared at `runtime/src/bin/model-facing-tools.ts:1892`.
- `system.listDir` - lists directory entries; transcript uses generic tool row; tool declared at `runtime/src/tools/system/filesystem.ts:843`.
- `system.stat` - stats paths; transcript uses generic tool row; tool declared at `runtime/src/tools/system/filesystem.ts:934`.
- `system.mkdir` - creates directories; transcript uses generic tool row; tool declared at `runtime/src/tools/system/filesystem.ts:982`.
- `system.delete` - deletes files/directories; transcript uses generic tool row; tool declared at `runtime/src/tools/system/filesystem.ts:1022`.
- `system.move` - moves/renames files/directories; transcript uses generic tool row; tool declared at `runtime/src/tools/system/filesystem.ts:1092`.
- `apply_patch` - applies patch hunks; transcript uses generic tool row plus edit-like output if routed; approval required from `runtime/src/tools/apply-patch/tool.ts:158`; tool declared at `runtime/src/tools/apply-patch/tool.ts:143`.

### Shell And Process Tools
- `exec_command` - runs PTY/plain shell commands; transcript uses tool row; custom expanded view through `BashOutputView` when routed; tool declared at `runtime/src/tools/system/exec-command.ts:236`.
- `write_stdin` - writes to running exec session; transcript uses generic tool row; tool declared at `runtime/src/tools/system/write-stdin.ts:52`.
- `system.bash` - shell command tool; transcript uses tool row; custom expanded view `BashOutputView` at `runtime/src/tui/tool-rendering.tsx:276`; tool declared at `runtime/src/tools/system/bash.ts:882`.
- `Bash` - canonical/model-facing shell alias; transcript and output view same as `system.bash`; alias declared at `runtime/src/tools/canonicalToolSurface.ts:521`.
- `PowerShell` - model-facing PowerShell tool; transcript uses generic shell-like tool row; declared at `runtime/src/bin/model-facing-tools.ts:2406`.
- `Sleep` - waits for a duration; transcript uses generic tool row; tool declared at `runtime/src/tools/system/sleep.ts:50`.
- `Monitor` - monitors running process/output; transcript uses generic tool row; tool declared at `runtime/src/tools/system/monitor.ts:58`.
- `EnterWorktree` - enters a worktree; transcript uses generic tool row; tool declared at `runtime/src/tools/system/worktree.ts:308`.
- `ExitWorktree` - exits/removes worktree; transcript uses generic tool row and may trigger `WorktreeExitDialog` at `runtime/src/tui/components/WorktreeExitDialog.tsx:35`; tool declared at `runtime/src/tools/system/worktree.ts:441`.

### Repo, Symbol, And Planning Tools
- `system.repoInventory` - repo inventory summary; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:28`.
- `system.gitStatus` - git status; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:105`.
- `system.gitDiff` - git diff; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:139`.
- `system.gitShow` - git show; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:190`.
- `system.gitBranchInfo` - branch info; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:230`.
- `system.gitChangeSummary` - change summary; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:266`.
- `system.gitWorktreeList` - worktree list; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:300`.
- `system.gitWorktreeCreate` - create worktree; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:343`.
- `system.gitWorktreeRemove` - remove worktree; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:403`.
- `system.gitWorktreeStatus` - worktree status; transcript uses generic tool row; tool declared at `runtime/src/tools/system/git-tools.ts:470`.
- `system.symbolSearch` - symbol search; transcript uses generic tool row; tool declared at `runtime/src/tools/system/symbol-tools.ts:27`.
- `system.symbolDefinition` - symbol definition lookup; transcript uses generic tool row; tool declared at `runtime/src/tools/system/symbol-tools.ts:67`.
- `system.symbolReferences` - symbol references lookup; transcript uses generic tool row; tool declared at `runtime/src/tools/system/symbol-tools.ts:110`.
- `TodoWrite` - plan/todo update; transcript uses plan-list rendering and generic tool row as needed; tool declared at `runtime/src/tools/system/planning.ts:260`.
- `EnterPlanMode` - enters plan mode; transcript shows plan banner and mode chrome; approval at `runtime/src/tools/system/planning.ts:318`; tool declared at `runtime/src/tools/system/planning.ts:313`.
- `ExitPlanMode` - exits plan mode; transcript shows plan approval/exit events; approval at `runtime/src/tools/system/planning.ts:352`; tool declared at `runtime/src/tools/system/planning.ts:348`.
- `VerifyPlanExecution` - model-facing plan verification; transcript uses generic tool row; tool declared at `runtime/src/bin/model-facing-tools.ts:2199`.
- `system.searchTools` - tool search; transcript uses generic tool row; tool declared at `runtime/src/tools/system/tool-search.ts:136`.

### Web Tools
- `WebFetch` - fetches URL content; transcript uses generic tool row; model-facing declaration at `runtime/src/bin/model-facing-tools.ts:130`.
- `WebSearch` - web search; transcript uses generic tool row; model-facing declaration at `runtime/src/bin/model-facing-tools.ts:1805`.
- `RemoteTrigger` - remote trigger/webhook-style model-facing operation; transcript uses generic tool row; tool declared at `runtime/src/bin/model-facing-tools.ts:2449`.

### Agent-control Tools
- `spawn_agent` - spawns sub-agent; transcript suppresses generic row and emits collab-agent system rows; tool declared at `runtime/src/agents/v2/spawn.ts:499`; spawn end row from `runtime/src/agents/v2/spawn.ts:468`.
- `wait_agent` - waits for agent completion; transcript emits waiting begin/end rows; tool declared at `runtime/src/agents/v2/wait.ts:287`.
- `close_agent` - closes an agent; transcript emits close begin/end rows; tool declared at `runtime/src/agents/v2/close-agent.ts:83`.
- `followup_task` - sends follow-up task; transcript uses collab interaction rows; tool declared at `runtime/src/agents/v2/followup-task.ts:7`.
- `send_message` - sends message to agent; transcript uses collab interaction rows; tool declared at `runtime/src/agents/v2/send-message.ts:7`.
- `list_agents` - lists active agents; transcript uses generic/collab rows; tool declared at `runtime/src/agents/v2/list-agents.ts:52`.
- `TaskCreate` - creates background task; transcript uses task/agent rows; tool declared at `runtime/src/tools/tasks/task-board.ts:197`.
- `TaskGet` - reads task; transcript uses generic task row; tool declared at `runtime/src/tools/tasks/task-board.ts:253`.
- `TaskUpdate` - updates task; transcript uses generic task row; tool declared at `runtime/src/tools/tasks/task-board.ts:291`.
- `TaskList` - lists tasks; transcript uses generic task row; tool declared at `runtime/src/tools/tasks/task-board.ts:446`.
- `TaskOutput` - reads background task output; transcript uses background task rows; tool declared at `runtime/src/tools/tasks/background.ts:77`.
- `TaskStop` - stops background task; transcript uses background task rows; tool declared at `runtime/src/tools/tasks/background.ts:168`.
- `spawn_agents_on_csv` - model-facing bulk agent job spawner; transcript uses generic/collab rows; declared at `runtime/src/bin/model-facing-tools.ts:1152`.
- `report_agent_job_result` - model-facing bulk agent result reporter; transcript uses generic row; declared at `runtime/src/bin/model-facing-tools.ts:1199`.

### Protocol, MCP, And Custom Tools
- `AskUserQuestion` - asks user for input; transcript uses dedicated TUI tool from `runtime/src/tui/tool-rendering.tsx:537`; approval required from `runtime/src/tools/ask-user-question/tool.ts:342`; tool declared at `runtime/src/tools/ask-user-question/tool.ts:327`.
- `request_user_input` - model-facing elicitation/request input tool; transcript opens `ElicitationOverlay` at `runtime/src/tui/components/App.tsx:843`; tool declared at `runtime/src/elicitation/request-user-input.ts:268`.
- `mcp__<server>__<tool>` - dynamic MCP tool namespace; transcript uses generic dynamic TUI tool unless a result tag routes custom view; dynamic MCP names added at `runtime/src/tui/tool-rendering.tsx:680`.
- `Skill` - invokes a skill; transcript uses generic tool row plus skill attachment rows; tool declared at `runtime/src/bin/model-facing-tools.ts:1308`.
- `CronCreate` - creates scheduled task; transcript uses generic row; tool declared at `runtime/src/bin/model-facing-tools.ts:2249`.
- `CronDelete` - deletes scheduled task; transcript uses generic row; tool declared at `runtime/src/bin/model-facing-tools.ts:2295`.
- `CronList` - lists scheduled tasks; transcript uses generic row; tool declared at `runtime/src/bin/model-facing-tools.ts:2319`.
- `WorkflowTool` - model-facing workflow operation; transcript uses generic row; tool declared at `runtime/src/bin/model-facing-tools.ts:2335`.
- Structured-output tool - model-facing structured output helper; transcript uses generic row; tool declared at `runtime/src/bin/structured-output-tool.ts:60`.
- Plugin/custom runtime tools - loaded through model-facing tool wiring and plugin registry; transcript uses generic dynamic tool rows unless the plugin emits known TUI result tags; registry note at `runtime/src/tool-registry.ts:452`.

## Permission modes & approval flows

### Permission Modes
- `default` - `runtime/src/permissions/types.ts:40`; normal mode; title `Default`, short `Default`, symbol `""`, color `text` from `runtime/src/permissions/mode-display.ts:32`; v2 pill label `default` from `runtime/src/tui/components/v2/primitives.tsx:42`.
- `acceptEdits` - `runtime/src/permissions/types.ts:41`; auto-accepts edit-class actions while asking for riskier operations; title `Accept edits`, symbol `⏵⏵`/`>>`, color `autoAccept` from `runtime/src/permissions/mode-display.ts:44`; v2 pill uses `agenc`/`agencWash` from `runtime/src/tui/components/v2/primitives.tsx:43`.
- `plan` - `runtime/src/permissions/types.ts:42`; planning mode with execution gated; title `Plan Mode`, symbol `⏸`/`||`, color `planMode` from `runtime/src/permissions/mode-display.ts:38`; v2 pill uses `planMode`/`planModeWash` from `runtime/src/tui/components/v2/primitives.tsx:44`.
- `bypassPermissions` - `runtime/src/permissions/types.ts:43`; bypass mode for dangerous operations; title `Bypass Permissions`, symbol `⏵⏵`/`>>`, color `error` from `runtime/src/permissions/mode-display.ts:50`; v2 pill label `bypass perms` and `errorWash` from `runtime/src/tui/components/v2/primitives.tsx:46`.
- `dontAsk` - `runtime/src/permissions/types.ts:44`; non-interactive no-prompt mode; title `Don't Ask`, short `DontAsk`, color `error` from `runtime/src/permissions/mode-display.ts:56`; v2 pill muted at `runtime/src/tui/components/v2/primitives.tsx:47`.
- `auto` - `runtime/src/permissions/types.ts:45`; auto mode; title `Auto mode`, color `warning` from `runtime/src/permissions/mode-display.ts:62`; v2 pill uses `success`/`successWash` at `runtime/src/tui/components/v2/primitives.tsx:45`.
- `unattended` - `runtime/src/permissions/types.ts:46`; internal unattended mode; title `Unattended`, symbol `⏵`/`>`, color `warning` from `runtime/src/permissions/mode-display.ts:68`; not user-addressable from `runtime/src/permissions/types.ts:54`.
- `bubble` - `runtime/src/permissions/types.ts:47`; internal bubble mode; title `Bubble`, symbol `""`, color `text` from `runtime/src/permissions/mode-display.ts:74`; not user-addressable from `runtime/src/permissions/types.ts:54`.

### Mode Chrome
- User-facing mode switcher order - `runtime/src/tui/components/v2/primitives.tsx:193`; `[1] default`, `[2] acceptEdits`, `[3] plan`, `[4] auto`, `[5] bypassPermissions`.
- Mode switcher hint - `runtime/src/tui/components/v2/primitives.tsx:222`; shows `shift+tab cycles forward · /permissions for full rule table`.
- Header mode pill - `runtime/src/tui/components/v2/primitives.tsx:172`; displays mode label/color in top chrome.
- Prompt glyph - `runtime/src/tui/components/PromptInput/permissionModeChrome.ts:14`; bypass mode uses `glyphs.promptBypass`, all others use `glyphs.pointer`.
- Footer mode label - `runtime/src/tui/components/PromptInput/permissionModeChrome.ts:22`; bypass shows `YOLO` and symbol `!`, others show `<mode> on`.
- Plan mode banner - `runtime/src/tui/components/FullscreenLayout.tsx:509`; visible when plan mode is active.
- Status bar mode variant - `runtime/src/tui/components/FullscreenLayout.tsx:547`; uses mode-derived variant for bottom chrome tint.

### Approval Surfaces
- Low-risk file write/edit approval - `runtime/src/tui/permission-requests.tsx:344`; `ApprovalCard` at `runtime/src/tui/components/v2/primitives.tsx:1059` shows tool, input block, facts, approve/deny hints, and low-risk `workerWash`.
- High-risk bash approval - `runtime/src/tui/permission-requests.tsx:302`; command/input matching `mainnet`, `settle`, `stake`, `transfer`, `slash`, `escrow`, or `solana transfer` gets high-risk styling and typed confirmation.
- High-risk protocol write approval - `runtime/src/tui/permission-requests.tsx:389`; facts show `scope: mainnet / protocol`; card uses `errorWash` and an explicit typed word.
- Typed-confirmation gate - `runtime/src/tui/permission-requests.tsx:312`; required word is `settle`, `stake`, `transfer`, or `yes`; Enter accepts only when typed text matches.
- Fail-closed unknown tool approval - `runtime/src/tui/permission-requests.tsx:99`; unknown tool names receive a denial-style confirmation surface.
- `AskUserQuestion` approval special case - `runtime/src/tui/permission-requests.tsx:147`; rejection resolves the pending user-question flow instead of generic denial.
- Permission context data - `runtime/src/permissions/types.ts:350`; UI decisions use mode, additional directories, allow/deny/ask rule maps, bypass availability, stripped dangerous rules, pre-plan mode, and auto-mode availability.

## Agents

### Agent Roles And Registry
- Runtime role registry - `runtime/src/agents/role.ts:290`; registers built-in and Markdown-defined roles.
- Built-in default role - `runtime/src/agents/role.ts:254`; `default` role with public presentation `netrunner`.
- Built-in explorer role - `runtime/src/agents/role.ts:261`; read-oriented `explorer` role with public presentation `scanner`.
- Built-in worker role - `runtime/src/agents/role.ts:269`; execution-oriented `worker` role with public presentation `runner`.
- Public role labels - `runtime/src/agents/role-presentation.ts:18`; `default` -> `Netrunner`, `explorer` -> `Scanner`, `worker` -> `Runner`.
- Additional public role labels - `runtime/src/agents/role-presentation.ts:37`; `docs` -> `Scribe`, `operator` -> `Fixer`, `marketplace` -> `Broker`, `browser` -> `Ghost`, `remote` -> `Trace`.
- Agent registry root paths - `runtime/src/agents/registry.ts:35`; root agent path `/root`, memory agent path `/morpheus`.
- Markdown role directories - `runtime/src/agents/role.ts:695`; loads user, project, and managed agent-role files.

### Spawn Surfaces
- V2 agent tool group - `runtime/src/agents/v2/index.ts:10`; creates `spawn_agent`, `wait_agent`, `close_agent`, `followup_task`, `send_message`, and `list_agents`.
- Spawn-agent tool - `runtime/src/agents/v2/spawn.ts:499`; starts sub-agents and emits collab-agent events.
- Wait-agent tool - `runtime/src/agents/v2/wait.ts:287`; waits for agent completion and emits waiting events.
- Close-agent tool - `runtime/src/agents/v2/close-agent.ts:83`; shuts down agents and emits close events.
- Follow-up task tool - `runtime/src/agents/v2/followup-task.ts:7`; sends new task to an existing agent.
- Send-message tool - `runtime/src/agents/v2/send-message.ts:7`; sends a message to an existing agent.
- List-agents tool - `runtime/src/agents/v2/list-agents.ts:52`; lists active/known agents.
- General-purpose agent - `runtime/src/tools/AgentTool/built-in/generalPurposeAgent.ts:25`; broad `general-purpose` sub-agent.
- Explore agent - `runtime/src/tools/AgentTool/built-in/exploreAgent.ts:64`; read-only exploration agent.
- Plan agent - `runtime/src/tools/AgentTool/built-in/planAgent.ts:73`; read-only planning agent.
- Verification agent - `runtime/src/tools/AgentTool/built-in/verificationAgent.ts:134`; background verification agent that returns a verdict.
- AgenC guide agent - `runtime/src/tools/AgentTool/built-in/agencGuideAgent.ts:100`; guided support agent with `dontAsk` permission mode.
- Statusline setup agent - `runtime/src/tools/AgentTool/built-in/statuslineSetup.ts:138`; setup agent for status-line configuration.

### TUI Presentation
- Coordinator task panel - `runtime/src/tui/components/CoordinatorAgentStatus.tsx:75`; shows orchestrator, active count, selected/viewed agent glyphs, and agent tree rows.
- Agent line - `runtime/src/tui/components/CoordinatorAgentStatus.tsx:205`; shows elapsed time, status text, tools/tokens, selected state, and tree indentation.
- Agent progress line - `runtime/src/tui/components/AgentProgressLine.tsx:24`; shows tree branch glyph, status text, tool/tokens, response gutter, and background/running/done labels.
- Background tasks panel - `runtime/src/tui/components/tasks/BackgroundTasksPanel.tsx:412`; groups background agents, shell commands, approvals, and other tasks.
- Background task status strip - `runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx:25`; compact active-task pills, arrow hint, and summary.
- Agents menu - `runtime/src/commands/agents-menu.tsx:591`; persistent agent-definition editor for list/detail/create/edit/delete.

### Lifecycle States
- `pending_init` - `runtime/src/agents/status.ts:22`; initializing; shown as initializing/pending rows in agent progress/status components.
- `running` - `runtime/src/agents/status.ts:25`; active; shown with running icon, elapsed time, and active count.
- `completed` - `runtime/src/agents/status.ts:29`; final done state; shown with success/tick styling.
- `errored` - `runtime/src/agents/status.ts:33`; final error state; shown with error/cross styling.
- `shutdown` - `runtime/src/agents/status.ts:38`; final killed/closed state; shown as shutdown/killed background task.
- `not_found` - `runtime/src/agents/status.ts:43`; final missing-agent state; shown as error/not-found result.
- `interrupted` - `runtime/src/agents/status.ts:47`; interrupted/paused result; shown as interrupted state.
- Background `running` - `runtime/src/tui/components/tasks/taskStatusUtils.tsx:76`; display text `working`.
- Background `idle` - `runtime/src/tui/components/tasks/taskStatusUtils.tsx:78`; display text `idle`.
- Background `awaiting approval` - `runtime/src/tui/components/tasks/taskStatusUtils.tsx:77`; display text `awaiting approval`.
- Background `stopping` - `runtime/src/tui/components/tasks/taskStatusUtils.tsx:79`; display text `stopping`.
- Background terminal states - `runtime/src/tui/components/tasks/taskStatusUtils.tsx:15`; `completed`, `failed`, and `killed` are terminal.

## Event types

### Canonical EventMsg Variants
- `session_meta` - `runtime/src/session/event-log.ts:533`; durable session metadata; transcript-affecting only when converted to session state.
- `session_configured` - `runtime/src/session/event-log.ts:540`; session configuration; mostly state/status-bar input.
- `turn_started` - `runtime/src/session/event-log.ts:546`; transient turn state; transcript handler at `runtime/src/tui/session-transcript.ts:1583`.
- `turn_context` - `runtime/src/session/event-log.ts:552`; context state; transcript token/context rows from `runtime/src/tui/session-transcript.ts:2031`.
- `agent_message` - `runtime/src/session/event-log.ts:558`; assistant text; transcript renderer through `AssistantTextMessage` at `runtime/src/tui/message-renderers/AssistantTextMessage.tsx:48`.
- `agent_message_delta` - `runtime/src/session/event-log.ts:566`; streaming assistant text; transient until accumulated in transcript.
- `agent_thinking` - `runtime/src/session/event-log.ts:573`; thinking content; rendered or hidden through `SystemTextMessage` at `runtime/src/tui/message-renderers/SystemTextMessage.tsx:150`.
- `assistant_thinking_block_start` - `runtime/src/session/event-log.ts:579`; transient thinking block boundary.
- `assistant_thinking_delta` - `runtime/src/session/event-log.ts:584`; transient thinking text.
- `assistant_thinking_block_stop` - `runtime/src/session/event-log.ts:590`; transient thinking block boundary.
- `user_message` - `runtime/src/session/event-log.ts:595`; durable user turn content; transcript handler at `runtime/src/tui/session-transcript.ts:1663`.
- `token_count` - `runtime/src/session/event-log.ts:602`; token/status data; transcript context rows from `runtime/src/tui/session-transcript.ts:2031`.
- `mcp_tool_call_begin` - `runtime/src/session/event-log.ts:609`; MCP tool start; transcript tool row from `runtime/src/tui/session-transcript.ts:1845`.
- `mcp_tool_call_end` - `runtime/src/session/event-log.ts:617`; MCP tool end; transcript result row from `runtime/src/tui/session-transcript.ts:1968`.
- `exec_command_begin` - `runtime/src/session/event-log.ts:624`; shell command start; transcript tool row.
- `exec_command_end` - `runtime/src/session/event-log.ts:631`; shell command end; transcript result row.
- `exec_approval_request` - `runtime/src/session/event-log.ts:638`; approval request; permission overlay/status input.
- `tool_call_started` - `runtime/src/session/event-log.ts:645`; generic tool start; transcript tool row.
- `tool_input_block_start` - `runtime/src/session/event-log.ts:652`; streaming tool input boundary.
- `tool_input_delta` - `runtime/src/session/event-log.ts:659`; streaming tool input; transient until finalized.
- `tool_call_completed` - `runtime/src/session/event-log.ts:666`; generic tool completion; transcript result row.
- `tool_progress` - `runtime/src/session/event-log.ts:672`; transient progress; can update tool row/status.
- `request_permissions` - `runtime/src/session/event-log.ts:679`; approval request; permission overlay.
- `request_user_input` - `runtime/src/session/event-log.ts:685`; elicitation request; opens `ElicitationOverlay` at `runtime/src/tui/components/App.tsx:843`.
- `mcp_elicitation_request` - `runtime/src/session/event-log.ts:692`; MCP elicitation; opens `ElicitationOverlay`.
- `mcp_elicitation_complete` - `runtime/src/session/event-log.ts:699`; closes/settles MCP elicitation; transient UI state.
- `context_compacted` - `runtime/src/session/event-log.ts:705`; durable; transcript compacted marker.
- `turn_complete` - `runtime/src/session/event-log.ts:712`; durable; transcript/status updates.
- `turn_aborted` - `runtime/src/session/event-log.ts:718`; durable; transcript/status/error updates.
- `thread_rolled_back` - `runtime/src/session/event-log.ts:724`; transcript history mutation.
- `error` - `runtime/src/session/event-log.ts:730`; durable; system error row.
- `stream_error` - `runtime/src/session/event-log.ts:736`; transient/error row; transcript handler at `runtime/src/tui/session-transcript.ts:2074`.
- `warning` - `runtime/src/session/event-log.ts:742`; warning row/status notice.
- `guardian_assessment` - `runtime/src/session/event-log.ts:748`; policy/safety-style assessment row.
- `review_delegate_started` - `runtime/src/session/event-log.ts:754`; review/agent status event.
- `review_delegate_completed` - `runtime/src/session/event-log.ts:761`; review/agent status event.
- `plan_approval_requested` - `runtime/src/session/event-log.ts:768`; transcript plan approval request.
- `plan_approval_completed` - `runtime/src/session/event-log.ts:774`; transcript plan approval result.

### Protocol Event Variants
- `protocol_claim` - `runtime/src/session/event-log.ts:781`; durable; renders protocol claim card via `ProtocolEvent` at `runtime/src/tui/components/v2/primitives.tsx:1382`.
- `protocol_settle` - `runtime/src/session/event-log.ts:787`; durable; renders settle success/failure card.
- `protocol_slash` - `runtime/src/session/event-log.ts:793`; durable; renders slash/error-style card.
- `protocol_stake` - `runtime/src/session/event-log.ts:799`; durable; renders stake card.

### Collaboration And Agent Event Variants
- `collab_agent_spawn_begin` - `runtime/src/session/event-log.ts:805`; transient; agent spawn status.
- `collab_agent_spawn_end` - `runtime/src/session/event-log.ts:811`; transcript agent-spawn system row.
- `collab_agent_status` - `runtime/src/session/event-log.ts:817`; status/transcript row for agent lifecycle.
- `collab_agent_interaction_begin` - `runtime/src/session/event-log.ts:823`; transient interaction row.
- `collab_agent_interaction_end` - `runtime/src/session/event-log.ts:829`; transcript interaction completion.
- `collab_waiting_begin` - `runtime/src/session/event-log.ts:835`; waiting status row.
- `collab_waiting_end` - `runtime/src/session/event-log.ts:841`; waiting completion row.
- `collab_close_begin` - `runtime/src/session/event-log.ts:847`; closing status row.
- `collab_close_end` - `runtime/src/session/event-log.ts:853`; close completion row.
- `collab_resume_begin` - `runtime/src/session/event-log.ts:859`; resume status row.
- `collab_resume_end` - `runtime/src/session/event-log.ts:865`; resume completion row.

### Plan Mode Event Variants
- `entered_review_mode` - `runtime/src/session/event-log.ts:871`; status/transcript state for review mode.
- `deprecation_notice` - `runtime/src/session/event-log.ts:877`; transcript warning/info row.
- `plan_started` - `runtime/src/session/event-log.ts:883`; transcript plan-start row.
- `plan_delta` - `runtime/src/session/event-log.ts:889`; transient plan update.
- `plan_item_completed` - `runtime/src/session/event-log.ts:895`; transcript plan item completion.
- `plan_exited` - `runtime/src/session/event-log.ts:901`; status/transcript plan exit.
- `exit_review_mode` - `runtime/src/session/event-log.ts:907`; status/transcript review exit.

### Durable Vs Transient
- Durable set - `runtime/src/session/event-log.ts:922`; `turn_complete`, `turn_aborted`, `error`, `context_compacted`, `protocol_claim`, `protocol_settle`, `protocol_slash`, and `protocol_stake`.
- Transcript-rendered core events - `runtime/src/tui/session-transcript.ts:1538`; history, turn, user, assistant, tool, context, token, protocol, error, slash, collab, and plan events.
- Status-only or state-only events - `session_configured`, `turn_started`, `tool_progress`, `exec_approval_request`, and `request_permissions` primarily drive app state, overlays, status bars, or row updates.
- Renderer-only legacy events - `runtime/src/tui/session-transcript.ts:2078`; `slash_result` is handled in transcript code but is not in canonical `EventMsg`.

## Status bar & top chrome

### Top Chrome Order
- Brand bleed - `runtime/src/tui/components/FullscreenLayout.tsx:514`; colored background strip behind top chrome.
- Header component - `runtime/src/tui/components/v2/primitives.tsx:298`; ordered as brand bar, optional tab status, tab label, mode pill, optional task segment.
- Brand/cwd segment - `runtime/src/tui/components/v2/primitives.tsx:298`; literal `agenc · <cwd>`.
- Tab status segment - `runtime/src/tui/components/FullscreenLayout.tsx:523`; `live` or `warn` based on app status.
- Tab label segment - `runtime/src/tui/components/FullscreenLayout.tsx:528`; literal `agenc · orchestrator`.
- Mode pill segment - `runtime/src/tui/components/v2/primitives.tsx:172`; color and label from `modeChrome`.
- Active task segment - `runtime/src/tui/components/FullscreenLayout.tsx:530`; shows `task <taskPda>` when active task data exists.

### Bottom Status Bar Order
- Bottom chrome component - `runtime/src/tui/components/FullscreenLayout.tsx:547`; renders `mode`, `cwd`, `mcp`, `messages`, and `agents` labels.
- Status bar primitive - `runtime/src/tui/components/v2/primitives.tsx:385`; draws variant wash, top border, left segments, and right segments.
- Segment primitive - `runtime/src/tui/components/v2/primitives.tsx:358`; displays label/value with optional accent.
- Right-hand segments - `runtime/src/tui/components/FullscreenLayout.tsx:535`; include cwd, MCP server count, transcript message count, and active agent/task summary.
- Context bar - `runtime/src/tui/components/v2/primitives.tsx:435`; separate compact progress bar for context usage when used by callers.

### Mode-pill Color Logic
- `default` - `runtime/src/tui/components/v2/primitives.tsx:42`; fg `subtle`, label `default`, no wash.
- `acceptEdits` - `runtime/src/tui/components/v2/primitives.tsx:43`; fg `agenc`, bg `agencWash`, label `accept edits`.
- `plan` - `runtime/src/tui/components/v2/primitives.tsx:44`; fg `planMode`, bg `planModeWash`, label `plan`.
- `auto` - `runtime/src/tui/components/v2/primitives.tsx:45`; fg `success`, bg `successWash`, label `auto`.
- `bypassPermissions` - `runtime/src/tui/components/v2/primitives.tsx:46`; fg `error`, bg `errorWash`, label `bypass perms`.
- `dontAsk`, `unattended`, `bubble` - `runtime/src/tui/components/v2/primitives.tsx:47`; fg `inactive`, muted internal labels.

## Glyphs & icons

### Glyph Table
- `"arrowUp"` - unicode `figures.arrowUp`, ascii `^`; up navigation, scroll, and picker hints; source `runtime/src/tui/glyphs.ts:5`.
- `"arrowDown"` - unicode `figures.arrowDown`, ascii `v`; down navigation and new-message pill; source `runtime/src/tui/glyphs.ts:6`.
- `"arrowLeft"` - unicode `figures.arrowLeft`, ascii `<`; left navigation and picker panes; source `runtime/src/tui/glyphs.ts:7`.
- `"arrowRight"` - unicode `figures.arrowRight`, ascii `>`; right navigation and picker panes; source `runtime/src/tui/glyphs.ts:8`.
- `"enter"` - unicode `↵`, ascii `Enter`; submit/select key hint; source `runtime/src/tui/glyphs.ts:9`.
- `"ellipsis"` - unicode `…`, ascii `...`; truncated/continuation text; source `runtime/src/tui/glyphs.ts:10`.
- `"horizontal"` - unicode `─`, ascii `-`; horizontal rules and separators; source `runtime/src/tui/glyphs.ts:11`.
- `"modalDivider"` - unicode `▔`, ascii `-`; modal divider line; source `runtime/src/tui/glyphs.ts:12`.
- `"mcpResource"` - unicode `◇`, ascii `*`; MCP resource attachment/icon marker; source `runtime/src/tui/glyphs.ts:13`.
- `"pointer"` - unicode `figures.pointer`, ascii `>`; prompt pointer, selection pointer, and active row marker; source `runtime/src/tui/glyphs.ts:14`.
- `"promptBypass"` - unicode `▶`, ascii `>`; bypass-permissions prompt glyph; source `runtime/src/tui/glyphs.ts:15`.
- `"responseGutter"` - unicode `⎿`, ascii `|_`; assistant/tool result gutter and expanded-result prefix; source `runtime/src/tui/glyphs.ts:16`.
- `"redactedThinkingPrefix"` - unicode `✻`, ascii `*`; redacted thinking prefix; source `runtime/src/tui/glyphs.ts:17`.
- `"separator"` - unicode `·`, ascii `-`; inline separator in compact labels; source `runtime/src/tui/glyphs.ts:18`.
- `"statusError"` - unicode `✗`, ascii `ERR`; error/failure status; source `runtime/src/tui/glyphs.ts:19`.
- `"statusSuccess"` - unicode `✓`, ascii `OK`; success/done status; source `runtime/src/tui/glyphs.ts:20`.
- `"spinnerFrames"` - unicode `["·", "✢", "✳", "✶", "✻", "✽"]`, ascii `["-", "\\", "|", "/"]`; animated spinner; source `runtime/src/tui/glyphs.ts:21`.
- `"spinnerReducedMotionDot"` - unicode `●`, ascii `*`; reduced-motion spinner; source `runtime/src/tui/glyphs.ts:22`.
- `"statusDot"` - unicode `●`, ascii `*`; live/status dot; source `runtime/src/tui/glyphs.ts:23`.
- `"thinkingEllipsis"` - unicode `…`, ascii `...`; thinking continuation; source `runtime/src/tui/glyphs.ts:24`.
- `"thinkingPrefix"` - unicode `∴`, ascii empty string; visible thinking prefix; source `runtime/src/tui/glyphs.ts:25`.
- `"titleAnimationFrames"` - unicode `["⠂", "⠐"]`, ascii `["*", "+"]`; title/header animation; source `runtime/src/tui/glyphs.ts:26`.
- `"titleStaticPrefix"` - unicode `✳`, ascii `*`; static title prefix; source `runtime/src/tui/glyphs.ts:27`.
- `"treeBranch"` - unicode `├─`, ascii `|-`; non-final tree branch; source `runtime/src/tui/glyphs.ts:28`.
- `"treeContinuation"` - unicode `│`, ascii `|`; tree continuation gutter; source `runtime/src/tui/glyphs.ts:29`.
- `"treeLast"` - unicode `└─`, ascii `` `-``; final tree branch; source `runtime/src/tui/glyphs.ts:30`.
- `"treeRoot"` - unicode `┌─`, ascii `.-`; root tree branch; source `runtime/src/tui/glyphs.ts:31`.
- `"treeSelectedBranch"` - unicode `╞═`, ascii `|>`; selected non-final tree branch; source `runtime/src/tui/glyphs.ts:32`.
- `"treeSelectedLast"` - unicode `╘═`, ascii `` `>``; selected final tree branch; source `runtime/src/tui/glyphs.ts:33`.
- `"treeSelectedRoot"` - unicode `╒═`, ascii `.>`; selected root tree branch; source `runtime/src/tui/glyphs.ts:34`.
- `"voiceCursorBars"` - unicode `" ▁▂▃▄▅▆▇█"`, ascii `" .:-=+*#@"`; voice/audio meter cursor bars; source `runtime/src/tui/glyphs.ts:35`.

### Glyph Mode
- ASCII mode selector - `runtime/src/tui/glyphs.ts:107`; `AGENC_TUI_GLYPHS=ascii` selects ASCII glyphs, otherwise unicode glyphs.
- Permission-mode symbol selector - `runtime/src/permissions/mode-display.ts:94`; also respects `AGENC_TUI_GLYPHS=ascii` for mode symbols.

## Theme tokens

### Core Tokens
- `"autoAccept"` - accept-edits mode and auto-accept affordances; source `runtime/src/utils/theme.ts:5`.
- `"bashBorder"` - bash-mode prompt border and shell accents; source `runtime/src/utils/theme.ts:6`.
- `"agenc"` - primary AgenC accent for assistant/chrome; source `runtime/src/utils/theme.ts:7`.
- `"agencShimmer"` - animated/shimmer primary accent; source `runtime/src/utils/theme.ts:8`.
- `"agencBlue_FOR_SYSTEM_SPINNER"` - system spinner blue; source `runtime/src/utils/theme.ts:9`.
- `"agencBlueShimmer_FOR_SYSTEM_SPINNER"` - shimmer variant of system spinner blue; source `runtime/src/utils/theme.ts:10`.
- `"permission"` - permission prompt accent; source `runtime/src/utils/theme.ts:11`.
- `"permissionShimmer"` - shimmer permission accent; source `runtime/src/utils/theme.ts:12`.
- `"planMode"` - plan-mode text/border; source `runtime/src/utils/theme.ts:13`.
- `"ide"` - IDE integration indicator; source `runtime/src/utils/theme.ts:14`.
- `"promptBorder"` - normal prompt border; source `runtime/src/utils/theme.ts:15`.
- `"promptBorderShimmer"` - animated prompt border; source `runtime/src/utils/theme.ts:16`.
- `"text"` - primary foreground text; source `runtime/src/utils/theme.ts:17`.
- `"inverseText"` - inverted foreground text; source `runtime/src/utils/theme.ts:18`.
- `"inactive"` - disabled/muted foreground; source `runtime/src/utils/theme.ts:19`.
- `"inactiveShimmer"` - animated muted foreground; source `runtime/src/utils/theme.ts:20`.
- `"subtle"` - secondary foreground; source `runtime/src/utils/theme.ts:21`.
- `"suggestion"` - suggestions/autocomplete text; source `runtime/src/utils/theme.ts:22`.
- `"remember"` - memory/remember accent; source `runtime/src/utils/theme.ts:23`.
- `"background"` - base terminal background; source `runtime/src/utils/theme.ts:24`.
- `"success"` - success/done foreground; source `runtime/src/utils/theme.ts:25`.
- `"error"` - error/destructive foreground; source `runtime/src/utils/theme.ts:26`.
- `"warning"` - warning foreground; source `runtime/src/utils/theme.ts:27`.
- `"merged"` - merged/diff status foreground; source `runtime/src/utils/theme.ts:28`.
- `"warningShimmer"` - animated warning foreground; source `runtime/src/utils/theme.ts:29`.
- `"diffAdded"` - added diff line; source `runtime/src/utils/theme.ts:30`.
- `"diffRemoved"` - removed diff line; source `runtime/src/utils/theme.ts:31`.
- `"diffAddedDimmed"` - dim added diff line; source `runtime/src/utils/theme.ts:32`.
- `"diffRemovedDimmed"` - dim removed diff line; source `runtime/src/utils/theme.ts:33`.
- `"diffAddedWord"` - added diff word highlight; source `runtime/src/utils/theme.ts:34`.
- `"diffRemovedWord"` - removed diff word highlight; source `runtime/src/utils/theme.ts:35`.
- `"red_FOR_SUBAGENTS_ONLY"` - sub-agent red color; source `runtime/src/utils/theme.ts:36`.
- `"blue_FOR_SUBAGENTS_ONLY"` - sub-agent blue color; source `runtime/src/utils/theme.ts:37`.
- `"green_FOR_SUBAGENTS_ONLY"` - sub-agent green color; source `runtime/src/utils/theme.ts:38`.
- `"yellow_FOR_SUBAGENTS_ONLY"` - sub-agent yellow color; source `runtime/src/utils/theme.ts:39`.
- `"purple_FOR_SUBAGENTS_ONLY"` - sub-agent purple color; source `runtime/src/utils/theme.ts:40`.
- `"orange_FOR_SUBAGENTS_ONLY"` - sub-agent orange color; source `runtime/src/utils/theme.ts:41`.
- `"pink_FOR_SUBAGENTS_ONLY"` - sub-agent pink color; source `runtime/src/utils/theme.ts:42`.
- `"cyan_FOR_SUBAGENTS_ONLY"` - sub-agent cyan color; source `runtime/src/utils/theme.ts:43`.
- `"professionalBlue"` - professional blue accent; source `runtime/src/utils/theme.ts:47`.
- `"chromeYellow"` - chrome/yellow accent; source `runtime/src/utils/theme.ts:48`.

### V2 And Surface Tokens
- `"clawd_body"` - inherited body text token; source `runtime/src/utils/theme.ts:52`.
- `"clawd_background"` - inherited background token; source `runtime/src/utils/theme.ts:53`.
- `"surfaceBackground"` - V2 panel/surface background; source `runtime/src/utils/theme.ts:56`.
- `"userMessageBackground"` - V2 user-message background; source `runtime/src/utils/theme.ts:57`.
- `"userMessageBackgroundHover"` - V2 user-message hover background; source `runtime/src/utils/theme.ts:58`.
- `"messageActionsBackground"` - V2 message-actions background; source `runtime/src/utils/theme.ts:59`.
- `"selectionBg"` - V2 selected row background; source `runtime/src/utils/theme.ts:60`.
- `"bashMessageBackgroundColor"` - V2 bash-message background; source `runtime/src/utils/theme.ts:61`.
- `"agencWash"` - V2 primary accent wash; source `runtime/src/utils/theme.ts:62`.
- `"worker"` - V2 worker/secondary accent; source `runtime/src/utils/theme.ts:63`.
- `"workerWash"` - V2 worker wash; source `runtime/src/utils/theme.ts:64`.
- `"successWash"` - V2 success wash; source `runtime/src/utils/theme.ts:65`.
- `"errorWash"` - V2 error/destructive wash; source `runtime/src/utils/theme.ts:66`.
- `"text2"` - V2 secondary text; source `runtime/src/utils/theme.ts:67`.
- `"muted3"` - V2 tertiary muted text; source `runtime/src/utils/theme.ts:68`.
- `"line"` - V2 hard divider line; source `runtime/src/utils/theme.ts:69`.
- `"lineSoft"` - V2 soft divider line; source `runtime/src/utils/theme.ts:70`.
- `"briefLabelWorker"` - V2 worker brief label; source `runtime/src/utils/theme.ts:71`.
- `"planModeWash"` - V2 plan-mode wash; source `runtime/src/utils/theme.ts:72`.

### Specialized Tokens
- `"memoryBackgroundColor"` - memory row/background; source `runtime/src/utils/theme.ts:78`.
- `"rate_limit_fill"` - rate-limit progress fill; source `runtime/src/utils/theme.ts:79`.
- `"rate_limit_empty"` - rate-limit progress empty track; source `runtime/src/utils/theme.ts:80`.
- `"fastMode"` - fast-mode accent; source `runtime/src/utils/theme.ts:82`.
- `"fastModeShimmer"` - fast-mode shimmer accent; source `runtime/src/utils/theme.ts:83`.
- `"briefLabelYou"` - brief-mode user label; source `runtime/src/utils/theme.ts:85`.
- `"briefLabelAgenC"` - brief-mode assistant label; source `runtime/src/utils/theme.ts:86`.
- `"rainbow_red"` - rainbow accent red; source `runtime/src/utils/theme.ts:88`.
- `"rainbow_orange"` - rainbow accent orange; source `runtime/src/utils/theme.ts:89`.
- `"rainbow_yellow"` - rainbow accent yellow; source `runtime/src/utils/theme.ts:90`.
- `"rainbow_green"` - rainbow accent green; source `runtime/src/utils/theme.ts:91`.
- `"rainbow_blue"` - rainbow accent blue; source `runtime/src/utils/theme.ts:92`.
- `"rainbow_indigo"` - rainbow accent indigo; source `runtime/src/utils/theme.ts:93`.
- `"rainbow_violet"` - rainbow accent violet; source `runtime/src/utils/theme.ts:94`.
- `"rainbow_red_shimmer"` - rainbow shimmer red; source `runtime/src/utils/theme.ts:95`.
- `"rainbow_orange_shimmer"` - rainbow shimmer orange; source `runtime/src/utils/theme.ts:96`.
- `"rainbow_yellow_shimmer"` - rainbow shimmer yellow; source `runtime/src/utils/theme.ts:97`.
- `"rainbow_green_shimmer"` - rainbow shimmer green; source `runtime/src/utils/theme.ts:98`.
- `"rainbow_blue_shimmer"` - rainbow shimmer blue; source `runtime/src/utils/theme.ts:99`.
- `"rainbow_indigo_shimmer"` - rainbow shimmer indigo; source `runtime/src/utils/theme.ts:100`.
- `"rainbow_violet_shimmer"` - rainbow shimmer violet; source `runtime/src/utils/theme.ts:101`.

## Keybindings

### Global
- `"ctrl+c"` -> `"app:interrupt"`; source `runtime/src/tui/keybindings/defaultBindings.ts:37`.
- `"ctrl+d"` -> `"app:exit"`; source `runtime/src/tui/keybindings/defaultBindings.ts:42`.
- `"ctrl+l"` -> `"app:redraw"`; source `runtime/src/tui/keybindings/defaultBindings.ts:47`.
- `"ctrl+t"` -> `"app:toggleTodos"`; source `runtime/src/tui/keybindings/defaultBindings.ts:52`.
- `"ctrl+o"` -> `"app:toggleTranscript"`; source `runtime/src/tui/keybindings/defaultBindings.ts:57`.
- `"ctrl+shift+b"` -> `"app:toggleBrief"` when available; source `runtime/src/tui/keybindings/defaultBindings.ts:64`.
- `"ctrl+shift+o"` -> `"app:toggleTeammatePreview"` when available; source `runtime/src/tui/keybindings/defaultBindings.ts:64`.
- `"ctrl+r"` -> `"history:search"`; source `runtime/src/tui/keybindings/defaultBindings.ts:64`.
- `"ctrl+shift+f"`/`"cmd+shift+f"` -> `"app:globalSearch"` when available; source `runtime/src/tui/keybindings/defaultBindings.ts:64`.
- `"ctrl+shift+p"`/`"cmd+shift+p"` -> `"app:quickOpen"` when available; source `runtime/src/tui/keybindings/defaultBindings.ts:64`.
- `"meta+j"` -> `"app:toggleTerminal"` when available; source `runtime/src/tui/keybindings/defaultBindings.ts:64`.

### Composer
- `"escape"` -> `"composer:escape"`; source `runtime/src/tui/keybindings/defaultBindings.ts:67`.
- `"ctrl+x ctrl+k"` -> `"composer:clear"`; source `runtime/src/tui/keybindings/defaultBindings.ts:72`.
- `"shift+tab"` or terminal-specific mode cycle key -> `"composer:cycleMode"`; source `runtime/src/tui/keybindings/defaultBindings.ts:77`.
- `"meta+p"` -> `"composer:insertPath"`; source `runtime/src/tui/keybindings/defaultBindings.ts:82`.
- `"meta+o"` -> `"composer:toggleOpen"`; source `runtime/src/tui/keybindings/defaultBindings.ts:87`.
- `"meta+t"` -> `"composer:toggleTerminal"`; source `runtime/src/tui/keybindings/defaultBindings.ts:92`.
- `"enter"` -> `"composer:submit"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"up"` -> `"composer:historyPrev"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"down"` -> `"composer:historyNext"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"ctrl+_"`/`"ctrl+shift+-"` -> `"composer:undo"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"ctrl+x ctrl+e"` -> `"composer:externalEditor"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"ctrl+g"` -> `"composer:openPlanFile"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"ctrl+s"` -> `"composer:save"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"ctrl+v"` or `"alt+v"` -> `"composer:pasteImage"`; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.
- `"shift+up"` -> `"composer:multilineUp"` when available; source `runtime/src/tui/keybindings/defaultBindings.ts:94`.

### Autocomplete And Select
- `"tab"` -> `"autocomplete:accept"`; source `runtime/src/tui/keybindings/defaultBindings.ts:97`.
- `"escape"` -> `"autocomplete:cancel"`; source `runtime/src/tui/keybindings/defaultBindings.ts:102`.
- `"up"` -> `"autocomplete:previous"`; source `runtime/src/tui/keybindings/defaultBindings.ts:103`.
- `"down"` -> `"autocomplete:next"`; source `runtime/src/tui/keybindings/defaultBindings.ts:103`.
- `"up"`/`"ctrl+p"` -> `"select:previous"`; source `runtime/src/tui/keybindings/defaultBindings.ts:317`.
- `"down"`/`"ctrl+n"` -> `"select:next"`; source `runtime/src/tui/keybindings/defaultBindings.ts:322`.
- `"return"` -> `"select:confirm"`; source `runtime/src/tui/keybindings/defaultBindings.ts:327`.

### Confirmation
- `"y"` -> `"confirm:yes"`; source `runtime/src/tui/keybindings/defaultBindings.ts:128`.
- `"n"` -> `"confirm:no"`; source `runtime/src/tui/keybindings/defaultBindings.ts:133`.
- `"a"` -> `"confirm:always"`; source `runtime/src/tui/keybindings/defaultBindings.ts:138`.
- `"escape"` -> `"confirm:cancel"`; source `runtime/src/tui/keybindings/defaultBindings.ts:143`.
- `"return"` -> `"confirm:submit"`; source `runtime/src/tui/keybindings/defaultBindings.ts:145`.

### Tabs, Transcript, And Scroll
- `"tab"` -> `"tabs:next"`; source `runtime/src/tui/keybindings/defaultBindings.ts:148`.
- `"shift+tab"` -> `"tabs:previous"`; source `runtime/src/tui/keybindings/defaultBindings.ts:153`.
- `"ctrl+o"` -> `"transcript:toggle"`; source `runtime/src/tui/keybindings/defaultBindings.ts:158`.
- `"ctrl+f"` -> `"transcript:search"`; source `runtime/src/tui/keybindings/defaultBindings.ts:163`.
- `"pageup"` -> `"scroll:pageUp"`; source `runtime/src/tui/keybindings/defaultBindings.ts:193`.
- `"pagedown"` -> `"scroll:pageDown"`; source `runtime/src/tui/keybindings/defaultBindings.ts:198`.
- `"home"` -> `"scroll:top"`; source `runtime/src/tui/keybindings/defaultBindings.ts:203`.
- `"end"` -> `"scroll:bottom"`; source `runtime/src/tui/keybindings/defaultBindings.ts:208`.

### Modal Contexts
- History search `"escape"` -> `"history:cancel"`; source `runtime/src/tui/keybindings/defaultBindings.ts:169`.
- History search `"return"` -> `"history:select"`; source `runtime/src/tui/keybindings/defaultBindings.ts:174`.
- Task `"ctrl+b"` -> `"task:background"`; source `runtime/src/tui/keybindings/defaultBindings.ts:179`.
- Theme picker `"escape"` -> `"theme:cancel"`; source `runtime/src/tui/keybindings/defaultBindings.ts:187`.
- Help `"escape"` -> `"help:close"`; source `runtime/src/tui/keybindings/defaultBindings.ts:212`.
- Attachments `"delete"` -> `"attachment:remove"`; source `runtime/src/tui/keybindings/defaultBindings.ts:219`.
- Attachments `"return"` -> `"attachment:open"`; source `runtime/src/tui/keybindings/defaultBindings.ts:224`.
- Footer `"left"` -> `"footer:previous"`; source `runtime/src/tui/keybindings/defaultBindings.ts:231`.
- Footer `"right"` -> `"footer:next"`; source `runtime/src/tui/keybindings/defaultBindings.ts:236`.
- Footer `"return"` -> `"footer:activate"`; source `runtime/src/tui/keybindings/defaultBindings.ts:241`.

### Message Selector, Diff, Model, Plugin
- Message selector `"j"`/`"down"` -> `"messageSelector:next"`; source `runtime/src/tui/keybindings/defaultBindings.ts:246`.
- Message selector `"k"`/`"up"` -> `"messageSelector:previous"`; source `runtime/src/tui/keybindings/defaultBindings.ts:251`.
- Message selector `"return"` -> `"messageSelector:select"`; source `runtime/src/tui/keybindings/defaultBindings.ts:256`.
- Message selector `"escape"` -> `"messageSelector:cancel"`; source `runtime/src/tui/keybindings/defaultBindings.ts:261`.
- Diff dialog `"escape"` -> `"diff:close"`; source `runtime/src/tui/keybindings/defaultBindings.ts:296`.
- Diff dialog `"return"` -> `"diff:confirm"`; source `runtime/src/tui/keybindings/defaultBindings.ts:301`.
- Model picker `"left"` -> `"model:effortDown"`; source `runtime/src/tui/keybindings/defaultBindings.ts:309`.
- Model picker `"right"` -> `"model:effortUp"`; source `runtime/src/tui/keybindings/defaultBindings.ts:313`.
- Plugin `"return"` -> `"plugin:open"`; source `runtime/src/tui/keybindings/defaultBindings.ts:332`.
- Plugin `"escape"` -> `"plugin:close"`; source `runtime/src/tui/keybindings/defaultBindings.ts:336`.

### Reserved
- Non-rebindable `"ctrl+c"`, `"ctrl+d"`, `"ctrl+m"` - source `runtime/src/tui/keybindings/reservedShortcuts.ts:16`.
- Terminal-reserved `"ctrl+z"` and `"ctrl+\\"` - source `runtime/src/tui/keybindings/reservedShortcuts.ts:43`.
- macOS-reserved `"cmd+c"`, `"cmd+v"`, `"cmd+x"`, `"cmd+q"`, `"cmd+w"`, `"cmd+tab"`, `"cmd+space"` - source `runtime/src/tui/keybindings/reservedShortcuts.ts:59`.

## Message kinds & renderers

### Transcript Containers
- Messages list - `runtime/src/tui/components/Messages.tsx:523`; routes rows, unseen divider, search/filter state, and static vs dynamic rendering.
- Message row - `runtime/src/tui/components/MessageRow.tsx:93`; applies row padding, streaming state, grouping, and transcript metadata.
- Static-render switch - `runtime/src/tui/components/Messages.tsx:688`; statically renders attachments, user/assistant/system text, grouped tool use, and collapsed read/search content.

### User Messages
- User prompt - `runtime/src/tui/message-renderers/UserPromptMessage.tsx:53`; v2 `Msg role="user"`, user background, truncation, and hover/action background.
- User text - `runtime/src/tui/message-renderers/UserTextMessage.tsx:1`; plain user text renderer.
- User local command output - `runtime/src/tui/message-renderers/UserLocalCommandOutputMessage.tsx:1`; local command output row.
- User bash output - `runtime/src/tui/message-renderers/UserBashOutputMessage.tsx:1`; user-originated shell output row.
- User cross-session row - `runtime/src/tui/message-renderers/UserCrossSessionMessage.tsx:1`; cross-session user context.
- User teammate row - `runtime/src/tui/message-renderers/UserTeammateMessage.tsx:1`; teammate-originated message row.
- User fork boilerplate - `runtime/src/tui/message-renderers/UserForkBoilerplateMessage.tsx:1`; fork/session boilerplate row.
- User GitHub webhook - `runtime/src/tui/message-renderers/UserGitHubWebhookMessage.tsx:1`; GitHub webhook-originated user context.

### Assistant And System Messages
- Assistant text - `runtime/src/tui/message-renderers/AssistantTextMessage.tsx:48`; v2 `Msg role="agenc"`, special API/error text handling, assistant chrome.
- Highlighted thinking text - `runtime/src/tui/message-renderers/HighlightedThinkingText.tsx:1`; thinking block highlighting.
- Assistant tool use - `runtime/src/tui/message-renderers/AssistantToolUseMessage.tsx:48`; tool call label, pending/running/done state, progress, permission, and expanded result slot.
- System text - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:67`; dispatches protocol, duration, memory, away summary, agent kill, bridge status, scheduled task, permission retry, API error, hook summary, and generic info/warn/error.
- Protocol system message - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:534`; wraps v2 `ProtocolEvent`.
- Collab agent system message - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:571`; dot state colors, title/detail, and `⎿` gutter.
- Shutdown message - `runtime/src/tui/message-renderers/ShutdownMessage.tsx:1`; shutdown summary row.
- Advisor message - `runtime/src/tui/message-renderers/AdvisorMessage.tsx:20`; server/advisor result, error, redacted, and result rows.
- Hook progress message - `runtime/src/tui/message-renderers/HookProgressMessage.tsx:1`; hook execution progress.

### Tool And Attachment Messages
- Tool success result - `runtime/src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.tsx:58`; success tick, rendered result content, and empty-name plain assistant fallback.
- Tool reject result - `runtime/src/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.tsx:21`; rejected/canceled tool output.
- Tool result root - `runtime/src/tui/message-renderers/UserToolResultMessage/UserToolResultMessage.tsx:43`; dispatches tool result variants.
- Grouped tool use - `runtime/src/tui/message-renderers/GroupedToolUseContent.tsx:1`; groups related tool rows.
- Collapsed read/search content - `runtime/src/tui/message-renderers/CollapsedReadSearchContent.tsx:142`; compact rows for read/search output.
- Attachment message - `runtime/src/tui/message-renderers/AttachmentMessage.tsx:41`; renders files, directories, notebooks, IDE lines, memory, skills, agents, queued commands, plan files, diagnostics, MCP resources, permissions, hooks, task status, and teammate shutdown batches.
- Diagnostics attachment - `runtime/src/tui/components/DiagnosticsDisplay.tsx:17`; verbose or compact diagnostics from attachment renderer.
- Snip boundary - `runtime/src/tui/message-renderers/SnipBoundaryMessage.tsx:1`; compaction/snip visual boundary.
- Task assignment message - `runtime/src/tui/message-renderers/TaskAssignmentMessage.tsx:1`; task assignment row.

### Special Chrome Rules
- V2 role colors - `runtime/src/tui/components/v2/primitives.tsx:838`; `user`, `agenc`, `worker`, and `system` roles use distinct color/glyph choices.
- V2 tool card - `runtime/src/tui/components/v2/primitives.tsx:871`; uses `⎿` gutter, status glyphs, expanded border, and result area.
- Tool glyph states - `runtime/src/tui/components/v2/primitives.tsx:85`; `queued` `○`, `running` `◐`, `done` `●`, `failed` `✕`.
- Attachment diagnostics toggle hint - `runtime/src/tui/components/DiagnosticsDisplay.tsx:73`; compact diagnostics mention `Ctrl+O` for details.

## Special inline states

### Prompt And Composer States
- Bash mode - `runtime/src/tui/components/PromptInput/PromptInputModeIndicator.tsx:71`; triggered by shell-mode input; shows `!`, `bashBorder`, shell progress, and bash output.
- Bash progress - `runtime/src/tui/components/BashModeProgress.tsx:15`; triggered while shell command is running; shows command and progress text.
- Paste confirmation - `runtime/src/tui/components/PasteConfirmDialog.tsx:27`; triggered by risky paste into bash/composer; shows yes/no/enter/esc controls.
- Plan mode banner - `runtime/src/tui/components/FullscreenLayout.tsx:509`; triggered by permission mode `plan`; shows plan-mode notice and changes mode tint.
- Auto mode opt-in - `runtime/src/tui/components/AutoModeOptInDialog.tsx:17`; triggered before enabling auto; asks to confirm auto behavior.
- Fast mode - `runtime/src/tui/components/PromptInput/PromptInput.tsx:151`; triggered by fast-mode toggle; shows `FastModePicker` and `FastIcon`.
- Voice mode - `runtime/src/tui/realtime/RealtimePanel.tsx:68`; triggered by realtime session; shows mic/PTT/meter/transcript/errors.
- IDE indicator - `runtime/src/tui/components/IdeStatusIndicator.tsx:14`; triggered by IDE connection, selected lines, or active file.

### Pickers And Search
- File/quick picker - `runtime/src/tui/components/QuickOpenDialog.tsx:46`; triggered by quick-open key; shows fuzzy targets.
- Global search - `runtime/src/tui/components/GlobalSearchDialog.tsx:70`; triggered by search key; shows fuzzy global results.
- History search - `runtime/src/tui/history/HistorySearchDialog.tsx:29`; triggered by `ctrl+r`; shows prompt history.
- Model picker - `runtime/src/tui/components/ModelPicker.tsx:41`; triggered by model selection; shows model list and effort adjustment.
- Message selector - `runtime/src/tui/components/MessageSelector.tsx:92`; triggered by transcript selection; shows message restore/select UI.
- Slash palette - `runtime/src/tui/components/v2/primitives.tsx:1288`; triggered by slash input; shows command list and navigation hints.

### Runtime States
- Background tasks strip - `runtime/src/tui/components/tasks/BackgroundTaskStatus.tsx:25`; triggered by active background tasks; shows task pills and arrow hint.
- Completion pipeline rows - `runtime/src/tui/components/App.tsx:2312`; triggered during completion pipeline activity; renders progress rows in scroll content.
- Render health warning - `runtime/src/tui/components/App.tsx:908`; triggered by render/FPS health state; shows concise warning row.
- Backpressure warning - `runtime/src/tui/components/App.tsx:2357`; triggered by input/output backpressure; appears above prompt.
- Cost threshold - `runtime/src/tui/components/dialogs/CostThresholdDialog.tsx:39`; triggered by cost guard; shows continue/cancel.
- Rate limit - `runtime/src/tui/components/dialogs/RateLimitMessage.tsx:75`; triggered by rate-limit errors; shows reset/upsell info.

## Configuration surfaces

### `/model`
- Command - `runtime/src/commands/model.ts:294`; opens model switcher unless direct args are handled inline.
- UI - `runtime/src/commands/model-menu.tsx:310`; rows show provider/model status, configured state, and selection state.
- Data - `runtime/src/commands/model-menu.tsx:55`; reads config, session selection, app state model, and settings source.
- Editable fields - provider/model selection and effort through `ModelPicker` at `runtime/src/tui/components/ModelPicker.tsx:41`.

### `/hooks`
- Command - `runtime/src/commands/hooks.ts:296`; opens hooks menu or unavailable state.
- UI - `runtime/src/commands/hooks-menu.tsx:427`; list/detail/edit-test surfaces with hook state.
- Data - `runtime/src/commands/hooks-menu.tsx:896`; reads `config.hooks`.
- Fields - event, matcher, enabled, type, timeout, source, command from `runtime/src/commands/hooks-menu.tsx:312`; edit-test fields from `runtime/src/commands/hooks-menu.tsx:217`.

### `/skills`
- Command - `runtime/src/commands/skills.ts:375`; opens skill browser or handles skill creation paths.
- UI - `runtime/src/commands/skills-menu.tsx:99`; list of skills/roots and detail panel.
- Data - `runtime/src/commands/skills-menu.tsx:139`; roots and skill metadata from skill discovery.
- Fields - mostly browse/open; new-skill creation template path starts at `runtime/src/commands/skills.ts:202`.

### `/mcp`
- Command - `runtime/src/commands/mcp.ts:700`; supports `status`, `tools [server]`, `reconnect`, `enable`, `disable`, `new`, and `add`.
- UI - `runtime/src/commands/mcp-menu.tsx:295`; list/tools/tool/form modes.
- Data - `runtime/src/commands/mcp-menu.tsx:32`; form fields include `serverName` and `commandLine`; tool detail includes `serverName`, `toolName`, and `description`.
- Editable fields - add-server form at `runtime/src/commands/mcp-menu.tsx:226`; save/create path at `runtime/src/commands/mcp-menu.tsx:361`.

### `/permissions`
- Command - `runtime/src/commands/permissions.ts:608`; aliases `approvals`, `allowed-tools`.
- UI - `runtime/src/commands/permissions.ts:625`; permission mode and rule table.
- Data - `runtime/src/permissions/types.ts:350`; mode, directories, allow/deny/ask rules, bypass availability, stripped dangerous rules, and auto-mode availability.
- Editable fields - user-facing permission modes from `runtime/src/permissions/types.ts:54`; allow/deny/ask rule maps from `runtime/src/permissions/types.ts:350`.

### `/memory`
- Command - `runtime/src/commands/memory/slash.ts:18`; opens memory picker/editor launcher.
- UI - `runtime/src/commands/memory/memory.tsx:195`; modal with memory targets and open/create actions.
- Data - user memory path from `runtime/src/commands/memory/memory.tsx:206`; project memory path from `runtime/src/commands/memory/memory.tsx:207`; auto memory from `runtime/src/commands/memory/memory.tsx:217`; agent memory directory from `runtime/src/commands/memory/memory.tsx:222`.
- Editable fields - underlying Markdown files/folders opened externally by actions from `runtime/src/commands/memory/memory.tsx:86`.

### `/plugins`
- Command - `runtime/src/commands/plugins.tsx:200`; aliases `plugin`, `marketplace`.
- UI - `runtime/src/commands/plugins.tsx:104`; loaded plugin/marketplace menu.
- Data - plugin registry/state supplied to `openPluginsMenu` at `runtime/src/commands/plugins.tsx:181`.
- Editable fields - no static in-TUI config editor pinned; plugin-specific commands can expose their own dynamic surfaces.

### `/agents`
- Command - `runtime/src/commands/agent-management.tsx:19`; opens agent management modal.
- UI - `runtime/src/commands/agents-menu.tsx:591`; list/detail/create/edit/delete modes.
- Data - agent file frontmatter fields from `runtime/src/tui/components/agents/agentFileUtils.ts:20`; storage roots from `runtime/src/tui/components/agents/agentFileUtils.ts:60`.
- Editable fields - source, agent type, when-to-use, tools, model, system prompt, and save action from `runtime/src/commands/agents-menu.tsx:260`.
- Persistence - create/update/delete agent files through `runtime/src/tui/components/agents/agentFileUtils.ts:166`.

### Other Config-visible Surfaces
- `/config` - `runtime/src/commands/config.ts:275`; config dashboard at `runtime/src/commands/config-menu.tsx:268`; shows agenc home, config files, tools, providers, agents, MCP, permissions, hooks, and environment-derived status.
- `/provider` - `runtime/src/commands/provider.ts:189`; provider auth/config menu at `runtime/src/commands/provider-menu.tsx:586`; shows provider, model, auth, base URL, configured state, websocket, and model count.
- `/status` - `runtime/src/commands/status.ts:287`; read-only status dashboard at `runtime/src/commands/status-menu.tsx:172`.

## On-chain protocol surface

### Slash Commands
- Protocol command factory - `runtime/src/commands/protocol.ts:49`; marks protocol commands as `source: "plugin"` and `kind: "protocol"`.
- `/claim` - `runtime/src/commands/protocol.ts:66`; inline protocol command; currently agnostic to visible chain-state screen.
- `/delegate` - `runtime/src/commands/protocol.ts:67`; inline protocol command; currently agnostic to visible chain-state screen.
- `/proof` - `runtime/src/commands/protocol.ts:68`; inline protocol command; currently agnostic to visible chain-state screen.
- `/settle` - `runtime/src/commands/protocol.ts:70`; inline protocol command; high-risk typed gate can apply if routed through permissioned tool text.
- `/stake` - `runtime/src/commands/protocol.ts:72`; inline protocol command; high-risk typed gate can apply if routed through permissioned tool text.

### Protocol Events
- Claim payload - `runtime/src/session/event-log.ts:297`; includes task/claim fields for `protocol_claim`.
- Settle payload - `runtime/src/session/event-log.ts:309`; includes task/settle fields for `protocol_settle`.
- Slash payload - `runtime/src/session/event-log.ts:322`; includes task/slash fields for `protocol_slash`.
- Stake payload - `runtime/src/session/event-log.ts:335`; includes stake fields for `protocol_stake`.
- Transcript conversion - `runtime/src/tui/session-transcript.ts:422`; turns protocol events into system messages.
- Protocol formatter - `runtime/src/tui/session-transcript.ts:688`; formats claim, settle, slash, and stake text/details.
- Protocol card - `runtime/src/tui/components/v2/primitives.tsx:1382`; renders `claim`, `settle`, `slash`, and `stake` cards with success/error/worker variants.

### Approval And Chain-risk Gate
- High-risk detector - `runtime/src/tui/permission-requests.tsx:302`; matches `mainnet`, `settle`, `stake`, `transfer`, `slash`, `escrow`, and `solana transfer`.
- Typed word selector - `runtime/src/tui/permission-requests.tsx:312`; uses `settle`, `stake`, `transfer`, or `yes`.
- Protocol approval facts - `runtime/src/tui/permission-requests.tsx:389`; high-risk cards show `scope: mainnet / protocol`.
- Approval card visuals - `runtime/src/tui/components/v2/primitives.tsx:1059`; high-risk protocol approvals use `errorWash`, command block, facts, and typed confirmation hint.

### Chain-state Chrome
- Welcome wallet/stake/rep/slashed fields - `runtime/src/tui/components/v2/primitives.tsx:680`; V2 welcome panel defaults include wallet, stake, rep, and slashed counts.
- Welcome chain rows - `runtime/src/tui/components/v2/primitives.tsx:723`; visible network/wallet/stake/rep/slashed rows.
- Task in-flight card - `runtime/src/tui/components/v2/primitives.tsx:785`; shows task PDA, escrow, deadline, and approval shortcuts.
- Header active task PDA - `runtime/src/tui/components/FullscreenLayout.tsx:530`; displays active task PDA in top chrome.
- Chain gating status - protocol event cards are gated by emitted protocol events; typed-confirmation gate is gated by high-risk text/tool content; welcome/task panels are design/state display surfaces and not themselves command gates.

## Anything I missed

### Miscellaneous And Notable
- Auto-updater - `runtime/src/tui/components/AutoUpdater.tsx:24`; update check interval, updating state, success, failure, and install messaging.
- IDE onboarding - `runtime/src/tui/components/IdeOnboardingDialog.tsx:25`; separate onboarding flow from the main welcome screen.
- Exit confirmation/worktree cleanup - `runtime/src/tui/components/ExitFlow.tsx:17`; can route to `WorktreeExitDialog` at `runtime/src/tui/components/WorktreeExitDialog.tsx:35`.
- Diagnostics display - `runtime/src/tui/components/DiagnosticsDisplay.tsx:17`; compact and verbose diagnostics visible through attachments.
- Rate-limit display - `runtime/src/tui/components/dialogs/RateLimitMessage.tsx:75`; error/upsell/reset panel for API limits.
- Token warning - `runtime/src/tui/cost/TokenWarning.tsx:16`; context usage warning before hard failure.
- Render/FPS health warning - `runtime/src/tui/components/App.tsx:908`; shows when render health degrades.
- Backpressure warning - `runtime/src/tui/components/App.tsx:2357`; visible above prompt when app backpressure exists.
- Bridge status system row - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:153`; visible bridge status in transcript.
- Scheduled task fire row - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:165`; visible scheduled-task event.
- Permission retry row - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:187`; visible retry/challenge state after permission issues.
- Stop hook summary row - `runtime/src/tui/message-renderers/SystemTextMessage.tsx:248`; visible hook summary.
- MCP resource attachment - `runtime/src/tui/message-renderers/AttachmentMessage.tsx:252`; shows MCP resource references with `mcpResource` glyph.
- Command permissions attachment - `runtime/src/tui/message-renderers/AttachmentMessage.tsx:257`; shows command permission context in transcript.
- Team memory collapsed/saved rows - `runtime/src/tui/message-renderers/teamMemCollapsed.tsx:1`; visible team memory summaries.

## Coverage Notes
- I searched the TUI entry points, `runtime/src/tui/components/App.tsx`, `runtime/src/tui/components/FullscreenLayout.tsx`, `runtime/src/tui/components/v2/`, `runtime/src/tui/message-renderers/`, slash-command registry, command files, tool registry, permission types, event log, glyphs, theme tokens, and keybindings.
- Local project instruction files `GOAL_DISCIPLINE.md`, `PORT_CHECKLIST.md`, and `.agenc/AGENC.md` were not present in this checkout when checked; this report is based on source code.
- Dynamic plugin slash commands are runtime-discovered in `runtime/src/commands.ts:403`; only the static built-ins and protocol commands can be fully enumerated from source.
- Dynamic MCP tools use `mcp__<server>__<tool>` names from connected servers; static source only pins the namespace and rendering behavior.
- Model/provider catalogs depend on runtime config and environment; the report maps the menus and fields, not every possible model value.
- `runtime/src/tui/session-transcript.ts:2078` handles renderer-only event names such as `slash_result` that are not listed in canonical `EventMsg` in `runtime/src/session/event-log.ts:533`.
- Some design-system V2 chain panels display wallet/task/escrow fields, but command gating in inspected code is event/approval driven rather than a separate chain-state screen gate.
