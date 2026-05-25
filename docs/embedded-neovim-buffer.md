# Embedded Neovim BUFFER

BUFFER uses embedded Neovim when AgenC can find a usable `nvim` executable.
Neovim owns Vim editing semantics through `nvim --embed`; AgenC owns process
supervision, pane rendering, file safety, and lifecycle cleanup.

## Provider Selection

- `AGENC_BUFFER_PROVIDER=auto` selects embedded Neovim when discovery succeeds.
- `AGENC_BUFFER_PROVIDER=neovim` requests embedded Neovim and reports a visible fallback reason when discovery fails.
- `AGENC_BUFFER_PROVIDER=inline` selects the basic inline BUFFER fallback.
- `AGENC_BUFFER_PROVIDER=external` selects the explicit external-editor handoff provider.
- `AGENC_BUFFER_NVIM=/path/to/nvim` overrides executable discovery.
- `AGENC_BUFFER_NVIM_TIMEOUT_MS=1200` controls the discovery probe timeout.
- `AGENC_BUFFER_NVIM_USE_INIT=1` allows user init loading. The default is clean embedded mode: `nvim --embed --clean -n`.

Inline mode is a basic fallback. It keeps file editing available when embedded
Neovim cannot start, and it does not claim exact Vim behavior. External editor
handoff remains explicit through the BUFFER keybinding for external editing.

## Fallback Reasons

The BUFFER header shows the active provider and any fallback reason. Common
reasons are a missing executable, a failed version probe, a probe timeout, or a
version below the embedded provider requirement.

Troubleshooting:

- Missing executable: install Neovim or set `AGENC_BUFFER_NVIM=/absolute/path/to/nvim`. Inline mode remains a basic fallback and does not provide exact Vim behavior.
- Failed version probe: run the configured binary with `--version`; fix permissions, wrapper scripts, or stderr failures reported in the BUFFER header.
- Probe timeout: raise `AGENC_BUFFER_NVIM_TIMEOUT_MS` only after confirming the binary starts normally from the same shell.
- Unsupported version: embedded BUFFER requires `nvim 0.9.0` or newer and shows `Embedded Neovim requires nvim 0.9.0 or newer` before falling back.

## Cleanup

Embedded Neovim runs as a supervised child process. BUFFER cleanup sends a
graceful quit, waits for the child, and then terminates the child process group
when graceful shutdown does not complete within the configured timeout.
If the TUI is killed, the PTY gate verifies that descendant Neovim processes are
gone before the scenario passes.

## Validation

Use these gates for this surface:

```bash
npm run typecheck
npm run check:unused:production --workspace=@tetsuo-ai/runtime
npm --workspace=@tetsuo-ai/runtime run test -- tests/tui/workbench/buffer-provider-boundary.contract.test.ts tests/tui/workbench/buffer-neovim-provider.contract.test.ts tests/tui/workbench/buffer-neovim-discovery.contract.test.ts tests/tui/workbench/buffer-neovim-rpc.contract.test.ts tests/tui/workbench/buffer-neovim-grid.contract.test.ts tests/tui/workbench/buffer-neovim-input.contract.test.ts tests/tui/workbench/buffer-neovim-lifecycle.contract.test.ts tests/tui/workbench/buffer-file-safety.contract.test.ts tests/tui/workbench/buffer-workbench-rendering.contract.test.tsx tests/tui/workbench/buffer-surface.test.tsx tests/tui/workbench/buffer-fallback-inline.contract.test.ts tests/tui/workbench/buffer-external-editor-provider.contract.test.ts tests/tui/workbench/buffer-external-editor.test.ts tests/tui/workbench/buffer-neovim-e2e-contract.test.ts tests/tui/workbench/buffer-docs-config.contract.test.ts --reporter=dot
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-buffer-neovim
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-visual-smoke
npm run build
node ~/.claude/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core
node scripts/check-embedded-neovim-buffer.mjs --run-commands --require-commands --require-edge-cases --require-inventory
```
