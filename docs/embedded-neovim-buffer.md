# Embedded Neovim BUFFER

BUFFER uses embedded Neovim when AgenC can find a usable `nvim` executable.
Neovim owns Vim editing semantics through `nvim --embed`; AgenC owns process
supervision, pane rendering, file safety, and lifecycle cleanup.

Implementation lives under
`runtime/src/tui/workbench/buffer/providers/`
(`selectBufferEditorProvider.ts`, Neovim / inline / external providers).

## Provider selection

| Mode | Env | Behavior |
| --- | --- | --- |
| `auto` (default) | `AGENC_BUFFER_PROVIDER=auto` | Prefer embedded Neovim when discovery succeeds; otherwise fall back |
| `neovim` | `AGENC_BUFFER_PROVIDER=neovim` | Request embedded Neovim; show a visible fallback reason when discovery fails |
| `inline` | `AGENC_BUFFER_PROVIDER=inline` | Basic inline BUFFER fallback (not exact Vim) |
| `external` | `AGENC_BUFFER_PROVIDER=external` | Explicit external-editor handoff provider |

Additional env knobs:

- `AGENC_BUFFER_NVIM=/path/to/nvim` — override executable discovery.
- `AGENC_BUFFER_NVIM_TIMEOUT_MS=1200` — discovery probe timeout.
- `AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS=10000` — maximum time for embedded UI,
  file, and dirty-state startup before AgenC aborts and supervises teardown.
- `AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS=1000` — dirty/close RPC deadline and
  graceful process-exit window before SIGKILL escalation. Increase this for a
  deliberately slow user init or shutdown hook; the defaults remain bounded.
- By default, embedded BUFFER prefers user init loading so your normal Neovim
  configuration, plugins, and syntax behavior are available.
- `AGENC_BUFFER_NVIM_USE_INIT=0` — disable user init; starts clean embedded
  mode: `nvim --embed --clean -n`.
- When the default user-init probe fails, AgenC falls back to clean embedded
  mode so BUFFER remains usable and reports the selected provider in the header.

Inline mode is a basic fallback. It keeps file editing available when embedded
Neovim cannot start, and it does not claim exact Vim behavior. External editor
handoff remains explicit through the BUFFER keybinding for external editing.

## Fallback reasons

The BUFFER header shows the active provider and any fallback reason. Common
reasons are a missing executable, a failed version probe, a probe timeout, or a
version below the embedded provider requirement.

Troubleshooting:

- Missing executable: install Neovim or set `AGENC_BUFFER_NVIM=/absolute/path/to/nvim`.
  Inline mode remains a basic fallback and does not provide exact Vim behavior.
- Failed version probe: run the configured binary with `--version`; fix
  permissions, wrapper scripts, or stderr failures reported in the BUFFER header.
- Probe timeout: raise `AGENC_BUFFER_NVIM_TIMEOUT_MS` only after confirming the
  binary starts normally from the same shell.
- Startup timeout: raise `AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS` when a trusted
  user init or plugin needs more than 10 seconds; use clean mode to isolate it.
- Cleanup timeout: raise `AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS` only for a
  trusted slow shutdown. Normal close fails closed when dirty state or `:qa`
  cannot be confirmed; force close remains bounded and supervised.
- Unsupported version: embedded BUFFER requires **`nvim 0.9.0` or newer** and
  shows `Embedded Neovim requires nvim 0.9.0 or newer` before falling back.

## Cleanup

Embedded Neovim runs as a supervised child process. BUFFER cleanup sends a
graceful quit, waits for the child, and then terminates the child process group
on Unix (or the direct child on Windows) when graceful shutdown does not
complete within the configured timeout. Neovim-started descendant cleanup on
Windows remains subject to the operating system's direct-child limitation.
The startup and cleanup deadlines are configurable with the env knobs above;
external-editor handoff checks every loaded buffer (including hidden buffers),
and unknown or modified state is never treated as permission to launch.
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
npm --workspace=@tetsuo-ai/runtime exec -- vitest run \
  tests/tui/workbench/buffer-provider-boundary.contract.test.ts \
  tests/tui/workbench/buffer-neovim-provider.contract.test.ts \
  tests/tui/workbench/buffer-neovim-discovery.contract.test.ts \
  tests/tui/workbench/buffer-neovim-rpc.contract.test.ts \
  tests/tui/workbench/buffer-neovim-grid.contract.test.ts \
  tests/tui/workbench/buffer-neovim-input.contract.test.ts \
  tests/tui/workbench/buffer-neovim-lifecycle.contract.test.ts \
  tests/tui/workbench/buffer-file-safety.contract.test.ts \
  tests/tui/workbench/buffer-workbench-rendering.contract.test.tsx \
  tests/tui/workbench/buffer-surface.test.tsx \
  tests/tui/workbench/buffer-fallback-inline.contract.test.ts \
  tests/tui/workbench/buffer-external-editor-provider.contract.test.ts \
  tests/tui/workbench/buffer-external-editor.test.ts \
  tests/tui/workbench/buffer-neovim-e2e-contract.test.ts \
  tests/tui/workbench/buffer-docs-config.contract.test.ts \
  --reporter=dot
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-buffer-neovim
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-visual-smoke
npm run build
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
node scripts/check-embedded-neovim-buffer.mjs
```

## Related

- TUI / workbench overview: [`reference/tui-workbench.md`](reference/tui-workbench.md)
- In-tree TUI notes: [`runtime/src/tui/README.md`](../runtime/src/tui/README.md)
