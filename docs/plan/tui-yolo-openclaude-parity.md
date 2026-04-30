# TUI Yolo OpenClaude Parity Contract

Owner repo: `/home/tetsuo/git/AgenC/agenc-core`

Worktree: `/home/tetsuo/git/AgenC/agenc-core-tui-openclaude-parity`

Branch: `contract/tui-openclaude-parity`

Source root: `/home/tetsuo/git/openclaude`

Source commit: `0ca43335375beec6e58711b797d5b0c4bb5019b8`

## Goal

Make `agenc` and `agenc --yolo` use the same complete interactive TUI shell. `--yolo` must only change permission and sandbox policy. The shell structure, composer, transcript, permission overlays, keybindings, resume/status surfaces, and diagnostics behavior are copied from OpenClaude where AgenC has the same surface.

## Allowed Divergence

AgenC keeps its name, visual identity, status wording, tool names, and product-specific runtime concepts. Code comments and user-facing strings added in this pass must be written in AgenC's voice.

## Contract Files

- Matrix: `parity/tui-yolo-openclaude-parity.json`
- Checker: `scripts/check-tui-yolo-openclaude-parity.mjs`
- Structural gate: `npm run check:tui-yolo-openclaude-parity`
- Completion gate: `npm run validate:tui-yolo-openclaude-parity`

## Rows

1. `startup-yolo-shell`: align startup, trust, permission-bypass, and setup flow.
2. `single-live-shell`: make normal and `--yolo` share one live shell composition.
3. `composer-prompt-input`: port OpenClaude prompt input behavior into AgenC's live composer.
4. `transcript-tool-grouping`: port message dispatch, tool grouping, Bash/exec rendering, and clean transcript behavior.
5. `permission-overlays`: port permission state and visible approval surfaces.
6. `keybindings-help`: align keybinding parsing, validation, display, and help.
7. `resume-status-notices`: align resume picker and ordered status notice surfaces.
8. `diagnostic-surface`: keep internal diagnostics out of user-visible transcript and error sidecars.

## Implementation Hold

Implementation starts only after the contract summary is confirmed. New source discoveries must update the matrix before code changes.
