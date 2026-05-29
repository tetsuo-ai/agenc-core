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
- By default, embedded BUFFER prefers user init loading so your normal Neovim
  configuration, plugins, and syntax behavior are available.
- `AGENC_BUFFER_NVIM_USE_INIT=0` disables user init loading and starts clean
  embedded mode: `nvim --embed --clean -n`.
- When the default user-init probe fails, AgenC falls back to clean embedded
  mode so BUFFER remains usable and reports the selected provider in the header.

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

## Trust boundary

By default (`AGENC_BUFFER_NVIM_USE_INIT=1`, the default), embedded Neovim loads
your full user configuration — `init.lua`/`init.vim` and any plugins it sources.
That configuration executes as **your user**, with your privileges, the moment
BUFFER opens. This is the same trust you already extend to running `nvim`
yourself, but it is worth calling out explicitly because BUFFER can be opened
from within an agent session:

- **Interactive use on a workspace you trust:** the default user-init path is
  expected and convenient.
- **Unattended / background agents, or untrusted workspaces:** prefer clean
  embedded mode, which starts `nvim --embed --clean -n` and loads **no** user
  config or plugins, by setting `AGENC_BUFFER_NVIM_USE_INIT=0`. This removes the
  arbitrary-code-execution surface of a hostile or unreviewed `init.lua`.

AgenC owns process supervision and lifecycle cleanup (see Cleanup), but it does
**not** sandbox the Neovim process or vet its configuration — config trust is
the user's, exactly as with a normal `nvim` invocation.

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
