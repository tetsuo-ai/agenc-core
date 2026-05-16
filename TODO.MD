# AgenC `--yolo` Real-Use UX Audit TODO

Audit date: 2026-05-16

This TODO comes from a real interactive run of the locally built AgenC CLI. The goal was not a synthetic unit test: the CLI was launched with `--yolo`, asked to create a small Python game, asked to create a project skill, configured with a project MCP server, driven through slash commands and menu flows, and separately checked through first-run onboarding with a deliberately bad provider key.

## Audit Artifacts

Main `--yolo` run:

- CLI: `node /home/tetsuo/git/AgenC/agenc-core/runtime/dist/bin/agenc.js --yolo`
- Project: `/tmp/agenc-yolo-live-project`
- Isolated home: `/tmp/agenc-yolo-live-home`
- Logs: `/tmp/agenc-yolo-live-logs`
- Runner: `/tmp/agenc-yolo-ux-audit-runner.mjs`

Onboarding bad-key run:

- Project: `/tmp/agenc-yolo-onboarding-project`
- Isolated home: `/tmp/agenc-yolo-onboarding-home`
- Logs: `/tmp/agenc-yolo-onboarding-logs`
- Runner: `/tmp/agenc-yolo-onboarding-audit.mjs`

Important evidence files:

- `/tmp/agenc-yolo-live-logs/notes.json`
- `/tmp/agenc-yolo-live-logs/mcp-status.frame.log`
- `/tmp/agenc-yolo-live-logs/mcp-tools.frame.log`
- `/tmp/agenc-yolo-live-logs/skills-after-game.frame.log`
- `/tmp/agenc-yolo-live-logs/use-mcp-tool.frame.log`
- `/tmp/agenc-yolo-live-logs/agents-generation-description.frame.log`
- `/tmp/agenc-yolo-live-home/.agenc/history.jsonl`
- `/tmp/agenc-yolo-onboarding-logs/notes.json`
- `/tmp/agenc-yolo-onboarding-logs/onboarding-skip-bad-key.frame.log`

## What Worked

- `agenc init --force` worked in the disposable project.
- `agenc mcp add --scope project audit-ping ...` worked.
- `agenc mcp list` showed the MCP server connected.
- TUI `/mcp` showed `audit-ping: connected`.
- AgenC created `game.py`.
- AgenC created `.agenc/skills/python-game/SKILL.md`.
- The project skill included non-empty `allowed-tools`.
- `python3 -m py_compile game.py` passed.
- `/skills` picked up `python-game` in the same session.
- The MCP ping tool was called successfully and returned `pong`.
- Bad-key onboarding allowed `/skip`.
- `/exit` exited onboarding with exit code 0.
- Double Ctrl-D exited from the failed agent-generation screen.

## P0 - Broken Workflows

### 1. `/agents` generation fails and creates no agent file

Repro path:

1. Start `agenc --yolo`.
2. Run `/agents`.
3. Choose `Create new agent`.
4. Choose project location.
5. Choose `Generate with AgenC`.
6. Enter:

```text
A reviewer for the tiny Python number guessing game that suggests small improvements.
```

Observed:

- The UI reports:

```text
Agent generation response was not valid JSON. Press Enter to retry, or press Esc to choose manual setup.
```

- No `.agenc/agents/*` file is created.
- Evidence: `/tmp/agenc-yolo-live-logs/agents-generation-description.frame.log`.

Expected:

- Generated-agent creation should reliably produce valid structured data and write a project agent file.
- The model contract should enforce JSON or use a robust repair path before surfacing failure.
- A failed generation should not leave the user in an ambiguous state.

Likely fix area:

- `generateAgent` model call contract.
- JSON schema / structured-output enforcement.
- JSON repair and retry behavior.
- Agent wizard state machine tests.

### 2. `/agents` wizard input leaks into normal chat history

Observed:

- The agent description was stored as a normal user prompt in history:

```text
{"display":"A reviewer for the tiny Python number guessing game that suggests small improvements.", ...}
```

- The normal assistant responded with reviewer notes for `game.py`.
- The agent wizard simultaneously showed a JSON-generation failure.
- Evidence:
  - `/tmp/agenc-yolo-live-home/.agenc/history.jsonl`
  - `/tmp/agenc-yolo-live-logs/agents-generation-description.frame.log`

Expected:

- Wizard text fields must be consumed only by the wizard.
- Wizard input must not enter normal chat history.
- Wizard input must not start a normal model turn.

Likely fix area:

- Composer submit routing while `/agents` wizard is active.
- Overlay/menu focus precedence.
- History persistence gate for wizard-only input.
- Tests asserting generated-agent description is not appended to chat history.

## P1 - TUI Output and Transcript Quality

### 3. PTY/frame output remains corrupted by stale overlapping content

Observed:

- Current frames contain stale transcript fragments, missing letters, and overpainted boxes.
- Examples:
  - `MCmcp.audrt-ping.ping`
  - `Providerkreadnncss`
  - `ermPssion mode`
  - stale skill content mixed into `/skills`
  - stale MCP output mixed into `/agents`

Evidence:

- `/tmp/agenc-yolo-live-logs/mcp-tools.frame.log`
- `/tmp/agenc-yolo-live-logs/skills-after-game.frame.log`
- `/tmp/agenc-yolo-live-logs/use-mcp-tool.frame.log`
- `/tmp/agenc-yolo-onboarding-logs/onboarding-skip-bad-key.frame.log`

Expected:

- The terminal display should not leave stale rows or overlapping boxes after slash commands, tool cards, onboarding, or menu transitions.
- QA/log consumers need a stable semantic transcript or reliable final-frame renderer.

Likely fix area:

- TUI repaint/clear semantics.
- PTY harness screen model.
- Slash command overlay teardown.
- Optional semantic transcript/debug log that does not depend on terminal repaint parsing.

### 4. Slash command overlay remains visible after command execution

Observed:

- `/mcp` output correctly showed the connected server, but the slash-command menu remained on screen.
- Evidence: `/tmp/agenc-yolo-live-logs/mcp-status.frame.log`.

Expected:

- Once a slash command is selected and executed, the slash overlay should close cleanly.
- Command output should not share screen space with stale command-palette rows.

Likely fix area:

- Slash command palette lifecycle.
- Overlay stack teardown after command dispatch.
- Tests for `/mcp`, `/mcp tools`, and `/skills` selected through the palette.

### 5. `/mcp tools` renders the tool name incorrectly

Observed:

- Expected:

```text
mcp.audit-ping.ping - Test ping tool
```

- Rendered frame:

```text
MCmcp.audrt-ping.ping - Test ping tool
```

- Evidence: `/tmp/agenc-yolo-live-logs/mcp-tools.frame.log`.

Expected:

- Tool names should render exactly, including MCP namespaced identifiers.

Likely fix area:

- MCP slash command output component.
- Frame clearing around box borders.
- PTY frame parser if the real terminal render is visually correct but logs are not.

### 6. Onboarding `--yolo` security copy contradicts actual sandbox mode

Observed:

- Onboarding showed:

```text
Permission mode: bypassPermissions (--yolo skips tool approval prompts).
Sandbox: workspace-write (--yolo disables workspace sandboxing for this session).
```

- This is internally contradictory: `workspace-write` is not "workspace sandboxing disabled".
- Evidence: `/tmp/agenc-yolo-onboarding-logs/onboarding-skip-bad-key.frame.log`.

Expected:

- The displayed sandbox mode should match the effective sandbox behavior.
- If `--yolo` means `danger-full-access`, show that.
- If the session actually remains `workspace-write`, do not claim sandboxing is disabled.

Likely fix area:

- Effective sandbox resolution for TUI startup/onboarding.
- Onboarding security-copy source of truth.
- Tests for `--yolo` permission and sandbox display.

## P2 - Clutter and Confusing State

### 7. MCP tool cards duplicate tool-search steps

Observed:

- The MCP tool call worked and returned `pong`.
- The transcript showed repeated tool cards:
  - `Tool search(Search tools: audit-ping)`
  - `Tool search(Select tool: mcp.audit-ping.ping)`
  - repeated `Select tool` cards before the MCP call.

Evidence:

- `/tmp/agenc-yolo-live-logs/use-mcp-tool.frame.log`.

Expected:

- Tool discovery/selection should be collapsed, deduplicated, or represented once.
- The final transcript should make the actual MCP call and result easy to see.

Likely fix area:

- Tool-search card rendering.
- Transcript event deduplication.
- Assistant tool-routing status UI.

### 8. Normal work is labeled as `Background agent idle`

Observed:

- During the MCP prompt, the transcript displayed:

```text
Background agent idle: pong
```

- No background agent was intentionally started by the user.
- Similar background-agent labels appeared around normal assistant responses.

Evidence:

- `/tmp/agenc-yolo-live-logs/use-mcp-tool.frame.log`
- `/tmp/agenc-yolo-live-logs/agents-generation-description.frame.log`

Expected:

- Main-session model/tool output should not be labeled as background-agent output.
- Background-agent status should appear only for actual background agents and should not duplicate normal assistant content.

Likely fix area:

- Agent/status event classification.
- TUI transcript source labels.
- Background-agent idle banner suppression.

### 9. `daemon stop` status/message mismatch

Observed:

- In one isolated home, `agenc daemon stop` returned status `1` while printing:

```text
AgenC daemon stopped
```

Evidence:

- `/tmp/agenc-yolo-live-logs/notes.json`
- `/tmp/agenc-yolo-onboarding-logs/notes.json`

Expected:

- If daemon stop succeeds or no daemon is running, status and message should align.
- Automation should not have to guess whether status `1` means failure.

Likely fix area:

- Daemon stop command exit codes.
- "No daemon running" versus "stopped existing daemon" messaging.

## Regression Coverage Needed

Add or extend real PTY/TUI tests for:

- `/agents` generated-agent description stays inside wizard state and does not enter chat history.
- `/agents` generated-agent path writes `.agenc/agents/<name>.md` for a normal description.
- Failed generated-agent JSON response has deterministic retry/manual fallback without starting chat.
- `/mcp`, `/mcp tools`, and `/skills` close the slash palette after dispatch.
- Creating `.agenc/skills/<skill>/SKILL.md` during a session appears in `/skills` without restart.
- MCP ping tool call renders one clear MCP call and one clear result.
- `--yolo` onboarding displays accurate permission and sandbox state.
- Bad-key onboarding can `/skip` and `/exit`.
- Ctrl-C/Ctrl-D exits from agent wizard failure screens.

## Recommended Fix Order

1. Fix the `/agents` wizard input leak and generated-agent JSON failure together. They are the only issues that both fail the requested task and pollute normal chat history.
2. Fix slash overlay teardown for `/mcp`, `/mcp tools`, and `/skills`.
3. Fix or bypass unstable PTY frame parsing with a semantic transcript/debug log.
4. Fix misleading onboarding `--yolo` sandbox copy.
5. Reduce duplicate MCP tool-search cards and incorrect background-agent labels.
6. Normalize `daemon stop` exit status and messaging.
