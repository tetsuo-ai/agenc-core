# Embedded Neovim BUFFER

BUFFER is the fullscreen workbench's workspace editor. It prefers a supervised
`nvim --embed` process when Neovim 0.9.0 or newer is available. Neovim owns the
editing model, commands, buffers, plugins, command line, messages, and popup
menus. AgenC owns the process boundary, terminal-grid rendering, editor/chat
handoff, disk-conflict checks, and the rules for leaving a workspace with
unsaved changes.

The important operator model is:

- The default is one multi-buffer Neovim session for the workspace, not a new
  process for every file. Opening another file changes the active Neovim buffer
  while preserving hidden buffers, registers, undo state, and plugins.
- `Alt+Q` hides BUFFER and returns to the workbench transcript. It does
  **not** quit Neovim or discard buffers. Reopening a file resumes the same
  session.
- Quit from inside Neovim with its normal `:qa` command, or exit AgenC. `:qa`
  refuses when any loaded buffer is modified; `:qa!` is an explicit Neovim
  discard.
- `Alt+Z` maximizes or restores BUFFER. Maximize hides workbench side rails,
  composer, and footer without resizing against the global terminal geometry;
  the embedded grid follows the actual center-pane size.
- `Ctrl+R` remains Neovim's native redo. `Alt+R` moves the current file to the
  workbench review rail.
- `Ctrl+S` is the deliberate host-save exception: it runs AgenC's disk and
  agent-conflict checks before writing the active buffer.

Embedded Neovim receives `Ctrl+X`, `Ctrl+K`, `Ctrl+G`, and `Ctrl+R` unchanged,
so completion, digraph input, the native status command, redo, plugins, and
user mappings can use those keys. Host navigation uses `Alt` chords instead;
an unmatched native prefix is never held by the workbench chord resolver.

Implementation lives under
`runtime/src/tui/workbench/buffer/`, especially `providers/` and `neovim/`.

## Native in-grid UI

AgenC attaches Neovim with `ext_linegrid` and RGB color support only. It does
not request external command-line, message, or popup-menu extensions. Those
surfaces therefore remain native Neovim grid content, so completion menus,
search prompts, `:` commands, plugin messages, and user-init UI behave like
they do in Neovim instead of being approximated by separate TUI widgets.

The workbench measures the rendered BUFFER content box after layout and sends
that exact row/column size to Neovim. The renderer preserves combining text,
CJK and emoji-width cells, explicit wide-character continuation cells, cursor
position, and Neovim highlight attributes.

## Provider selection and configuration

Persistent settings live in `config.toml` under `AGENC_HOME` (normally
`~/.agenc/config.toml`) and are also editable from `/config`:

```toml
[buffer]
provider = "auto"       # auto | neovim | inline | external
show_tabs = "auto"      # auto | always | never

[buffer.neovim]
executable = "/usr/bin/nvim"
init = "auto"           # auto | user | clean
# discovery_timeout_ms = 1200  # optional override; default 1200, or 5000 on Windows
startup_timeout_ms = 10000
operation_timeout_ms = 10000
cleanup_timeout_ms = 1000
```

Provider modes:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Prefer embedded Neovim; fall back to basic inline BUFFER when discovery fails or every configured startup attempt fails with cleanup confirmed |
| `neovim` | Request embedded Neovim; discovery failure keeps BUFFER usable through inline fallback, but a discovered executable that fails startup remains an explicit Neovim error |
| `inline` | Use the basic in-process editor; it does not claim exact Vim behavior |
| `external` | Use the explicit external-editor handoff provider |

Environment variables override `config.toml` for the current AgenC process:

| Environment variable | Config equivalent / effect |
| --- | --- |
| `AGENC_BUFFER_PROVIDER` | `[buffer].provider` |
| `AGENC_BUFFER_NVIM` | `[buffer.neovim].executable` |
| `AGENC_BUFFER_NVIM_USE_INIT=1` | Force user init (`init = "user"`) |
| `AGENC_BUFFER_NVIM_USE_INIT=0` | Force clean mode (`init = "clean"`) |
| `AGENC_BUFFER_NVIM_TIMEOUT_MS` | `discovery_timeout_ms` |
| `AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS` | `startup_timeout_ms` |
| `AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS` | `operation_timeout_ms` |
| `AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS` | `cleanup_timeout_ms` |
| `AGENC_BUFFER_NVIM_SESSION=file` | Temporary rollback to the legacy per-file process lifetime for this session |

Provider, executable, init, and deadline changes apply the next time AgenC
safely starts an editor provider. Saving `/config` never tears down a live
workspace—or its hidden dirty buffers—just to apply a setting.

Unset values use the defaults shown above. Invalid environment values do not
become partial configuration: unknown provider values resolve to `auto`,
unrecognized init booleans leave init selection automatic, and non-positive
deadlines are ignored.

`init = "auto"` runs one contained, bounded `nvim --version` discovery probe,
then starts the real editor with the user's normal Neovim init exactly once.
If that real startup fails and its process tree was safely cleaned up, BUFFER
retries the real startup with `nvim --embed --clean` and reports the fallback
in its status. It never starts a second disposable user-init process.
`init = "user"` tries only the user-init path; `init = "clean"` tries only clean
mode. If every configured startup attempt fails, `provider = "auto"` switches
to the basic inline provider and keeps it for that configuration; explicit
`provider = "neovim"` stays on the Neovim error surface. An uncertain cleanup
never authorizes either another Neovim process or an inline-provider switch.

The embedded-provider external editor shortcut is `Alt+E`. Handoff is
refused if any loaded or hidden Neovim buffer is modified, or if AgenC cannot
confirm the aggregate dirty state.

## Buffer tabs

The host tab strip mirrors regular, listed, loaded Neovim buffers, including
unnamed regular buffers. The active buffer is emphasized, modified buffers
carry a warning-colored `●`, duplicate basenames are disambiguated with their
paths, and a tab can be clicked to focus BUFFER and make that existing buffer
current without replacing the workspace process.

`buffer.show_tabs` controls visibility:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Show the strip when at least two eligible buffers exist |
| `always` | Show it whenever at least one eligible buffer exists |
| `never` | Hide the host strip; Neovim's own `:buffer`, `:bnext`, plugins, and mappings still work |

Unlisted and unloaded buffers stay in Neovim's safety manifest but are not
rendered as host tabs. Regular unnamed buffers are the exception: they appear
as `[No Name]` (with the buffer handle added when disambiguation is needed).
Hiding a tab therefore never means a hidden buffer is omitted from dirty-state
or exit checks.

## Neovim-to-composer bridge

Embedded sessions install five AgenC user commands after user init:

| Neovim command | Default handoff |
| --- | --- |
| `:AgenCAttach [prompt]` | Attach live editor context and focus the composer without forcing open the transcript rail |
| `:AgenCAsk [question]` | Attach context, open the transcript rail beside BUFFER, and focus an empty composer or the supplied question |
| `:AgenCFix [instruction]` | Same handoff with the default draft `Fix the attached issue.` |
| `:AgenCExplain [instruction]` | Same handoff with the default draft `Explain the attached code.` |
| `:AgenCReview [instruction]` | Same handoff with the default draft `Review the attached editor context.` |

Without a range, a command captures the current buffer. An Ex range captures
those complete lines, for example `:'<,'>AgenCExplain`. A supplied argument
replaces the default draft. Regular unnamed buffers are captured as `[No Name]`
live snapshots without inventing a filesystem path.

Matching `<Plug>` mappings are installed for user configuration:

- `<Plug>(AgenCAttach)`
- `<Plug>(AgenCAsk)`
- `<Plug>(AgenCFix)`
- `<Plug>(AgenCExplain)`
- `<Plug>(AgenCReview)`

In normal mode a `<Plug>` action captures the current buffer; in visual mode
it captures the exact characterwise, linewise, or blockwise selection. No
default key mappings are installed. For example:

```lua
vim.keymap.set({ "n", "x" }, "<leader>aa", "<Plug>(AgenCAttach)")
vim.keymap.set({ "n", "x" }, "<leader>ae", "<Plug>(AgenCExplain)")
```

### Exact unsaved attachment semantics

An editor attachment records the live buffer's path, range, selection mode,
text, dirty flag, and Neovim `changedtick` at capture time. If the buffer is
modified, the composer labels it an **unsaved live-buffer snapshot**. AgenC
wraps captured text as untrusted workspace data and sends that same live text
as pasted content when the prompt is submitted.

These captures deliberately do not materialize as a stale `@path` reference:
resolving `@path` later would read disk and could silently replace unsaved
editor bytes with older content. The attachment chip can be removed directly;
Backspace removes the last chip when the composer is empty, and a successful
submission clears the captured attachments.

Exact capture is bounded to **64 KiB** and **2,000 lines**. AgenC refuses a
larger buffer or selection with an actionable “select a smaller range” error;
it never labels a truncated prefix as exact.

`AgenCAsk`, `AgenCFix`, `AgenCExplain`, and `AgenCReview` keep BUFFER in the
center and open the transcript rail beside it, so the editor, draft, and chat
remain visible as one handoff.

## Multi-buffer save and leave safety

The active file is not the safety boundary. AgenC asks Neovim for a manifest of
every loaded buffer and treats `dirty` as the aggregate of that manifest,
including hidden buffers.

When a workbench action would replace or close BUFFER while any buffer is
modified, AgenC stops the exact requested navigation and shows:

```text
S Save All   D Discard All   Esc Cancel
```

- **Save All** preflights every modified buffer before writing the first one.
  A read-only or unwriteable buffer, a missing disk baseline, an external disk
  change, or a workspace that changes during the transaction blocks the
  transition and leaves the remaining buffers open. Writes use stable Neovim
  buffer handles rather than whichever file happens to be active.
- **Discard All** requires a second `D`. Only then does Neovim clear every
  modified loaded buffer and confirm that the aggregate dirty count is zero.
- **Cancel** dismisses the prompt and does not replay the blocked navigation.

This transaction also protects `Alt+Q`: hiding a clean BUFFER is immediate;
hiding a dirty BUFFER requires Save All, the double-confirmed Discard All, or
Cancel. A direct Neovim `:qa` remains Neovim's own safe explicit-quit path.
The same gate protects `/exit`, `/quit`, `Ctrl+D`, and `/resume`: AgenC does
not unmount the TUI or switch sessions until the workspace is clean or the
operator explicitly completes Discard All.

Individual `Ctrl+S` saves are also fail-closed. AgenC refuses a write when an
agent appears to be editing that file or when the on-disk bytes no longer match
the baseline read when BUFFER opened. Resolve the competing edit, reload, or
make an intentional force decision inside Neovim; AgenC does not silently
overwrite the newer disk file.

## Private crash recovery

Each workspace gets a deterministic private recovery root at:

```text
<AGENC_HOME>/recovery/neovim/<workspace-hash>/
```

The hash is derived from the canonical workspace root. Beneath it, AgenC keeps
Neovim swap files in `swap/`, persistent undo in `undo/`, ShaDa in
`main.shada`, recovered copies in `copies/`, and a `recovery.json` manifest
identifying the workspace. On Unix, directories are forced to mode `0700`, the
manifest to `0600`, and swap files to `rw-------`.

Recovery paths and enforcement hooks are installed after the optional user
init but before the first workspace file opens. Buffer-local swap and
persistent undo are enabled on a short deferred callback once a named buffer is
loaded; this avoids changing swap state from inside Neovim's file-open event
while still overriding user-init hooks that disabled recovery. A buffer with an
unresolved swap stays exempt until the user completes the recovery choice.
Neovim's update count remains at least 50. These artifacts stay under
`AGENC_HOME`; they are not attachments and are not sent to the model.

When Neovim reports a swap—or AgenC's private swap scan maps one to the exact
file being opened—AgenC opens the disk version read-only and replaces the
editor grid with a recovery card. The choice targets only that mapped swap;
swaps for other workspace files remain untouched and are offered when their
own files open.

- **Recover** restores the swap contents to BUFFER as modified, unsaved
  changes. Review them and save normally when they are correct.
- **Compare** keeps the recovered version modified and opens a read-only
  snapshot of the on-disk file beside it in Neovim's diff view.
- **Save Copy** writes the recovered contents to
  `<workspace-recovery-root>/copies/<file>.<timestamp>.recovered`, then restores
  the disk-backed BUFFER without replacing the original file. The resulting
  path is shown in BUFFER status.
- **Discard** reloads the on-disk file and permanently removes that recovery
  swap. It requires a second `D`; pressing it once only arms the destructive
  choice.

Editor input and file navigation remain blocked until the pending choice
finishes, and recovery actions are serialized. If recovery reports an error,
the card remains visible with the error instead of silently treating the swap
as resolved.

## Startup fallback and status

The BUFFER header shows the active provider and any fallback reason. Common
reasons are a missing executable, a failed version probe, a probe timeout, or a
version below the embedded provider requirement. Inline fallback remains
editable but deliberately advertises that it is basic behavior, not exact Vim.

Troubleshooting:

- Missing executable: install Neovim or set `AGENC_BUFFER_NVIM=/absolute/path/to/nvim`.
  Inline mode remains a basic fallback and does not provide exact Vim behavior.
- Failed version probe: run the configured binary with `--version`; fix
  permissions, wrapper scripts, or stderr failures reported in the BUFFER header.
- Probe timeout: raise `AGENC_BUFFER_NVIM_TIMEOUT_MS` only after confirming the
  binary starts normally from the same shell.
- Startup timeout: raise `AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS` when a trusted
  user init or plugin needs more than 10 seconds; use clean mode to isolate it.
- Operation timeout: raise `AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS` only after
  identifying a trusted slow RPC, autocommand, or plugin. File operations
  remain bounded and report an error instead of assuming success.
- Cleanup timeout: raise `AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS` only for a
  trusted slow shutdown. Normal close fails closed when dirty state or `:qa`
  cannot be confirmed; force close remains bounded and supervised.
- Unsupported version: embedded BUFFER requires **`nvim 0.9.0` or newer** and
  shows `Embedded Neovim requires nvim 0.9.0 or newer` before falling back.
- Unexpected exit: the BUFFER status includes the child exit code or signal
  and a bounded stderr tail when available. The crash card offers **Restart**
  with the configured init policy, **Restart clean** without user init,
  **Use inline** for the current restart, and **Copy details** for reporting.
  Fix the reported init/plugin failure rather than assuming a dead process is
  still an editor.

## Process lifetime and cleanup

Embedded Neovim runs inside the strongest process-lifetime boundary available
on the host. BUFFER cleanup sends a graceful quit, waits for the child, and
then terminates and verifies that platform's supported boundary when graceful
shutdown does not complete within the configured timeout. Linux uses a private
cgroup v2 leaf when the host permits it. When cgroup delegation is unavailable,
AgenC starts the command through its bundled native subreaper broker: the
broker establishes
`PR_SET_CHILD_SUBREAPER` before launching Neovim, arms `PR_SET_PDEATHSIG`, and
kills and reaps every orphaned descendant before reporting cleanup complete.
That kernel reparenting boundary cannot miss a child that immediately calls
`setsid` and outlives its leader. Windows uses a bundled, precompiled broker
to start Neovim suspended, assign it to a `KILL_ON_JOB_CLOSE` Job Object, and
watch the exact parent-process handle without compiling code during startup.

Darwin has no equivalent public, unprivileged recursive ownership API. AgenC
therefore terminates Neovim's process group and retains start-time identities
for descendants observed while they remain in its PPID tree. That covers the
normal plugin/job lifecycle and the hosted detached-job regression, but it
cannot prove ownership of an immediate double-fork plus `setsid` escape that
finishes between process-table snapshots. User init remains trusted code, as
described below; do not treat BUFFER as a sandbox for deliberately daemonizing
configuration.

The POSIX owner watchdog, Linux subreaper broker, and Windows broker apply
their corresponding cleanup if the TUI itself is killed, including
`SIGKILL`/forced termination.
The startup and cleanup deadlines are configurable with the env knobs above;
unknown dirty state is never treated as safe permission to exit or launch an
external editor.
Hosted Linux, Darwin, and Windows gates launch a detached, TERM-resistant
Neovim job, ensure it has entered the platform's tracked boundary, kill the
TUI, and require the editor, observed job, owner watchdog/broker, and temporary
state to be gone before the scenario passes.

## Trust boundary

In the default `init = "auto"` mode, embedded Neovim first tries your full user
configuration — `init.lua`/`init.vim` and any plugins it sources. That
configuration executes as **your user**, with your privileges, when BUFFER
opens. This is the same trust you already extend to running `nvim` yourself,
but it is worth calling out explicitly because BUFFER can be opened from
within an agent session:

- **Interactive use on a workspace you trust:** the default user-init path is
  expected and convenient.
- **Unattended / background agents, or untrusted workspaces:** prefer clean
  embedded mode, which starts `nvim --embed --clean` and loads **no** user
  config or plugins, by setting `buffer.neovim.init = "clean"` or
  `AGENC_BUFFER_NVIM_USE_INIT=0`. This removes the arbitrary-code-execution
  surface of a hostile or unreviewed user init.

AgenC owns process supervision and lifecycle cleanup (see Process lifetime and
cleanup), but it does **not** sandbox the Neovim process or vet its
configuration — config trust is the user's, exactly as with a normal `nvim`
invocation.

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
  tests/tui/workbench/buffer-neovim-agent-bridge.contract.test.ts \
  tests/tui/workbench/buffer-neovim-process.contract.test.ts \
  tests/tui/workbench/buffer-neovim-recovery.contract.test.ts \
  tests/tui/workbench/buffer-file-safety.contract.test.ts \
  tests/tui/workbench/buffer-provider-config.contract.test.ts \
  tests/tui/workbench/buffer-workbench-rendering.contract.test.tsx \
  tests/tui/workbench/buffer-surface-handlers.test.tsx \
  tests/tui/workbench/buffer-surface.test.tsx \
  tests/tui/workbench/dirty-buffer-leave-overlay.test.tsx \
  tests/tui/workbench/captured-attachments.test.ts \
  tests/tui/workbench/reducer.test.ts \
  tests/tui/workbench/buffer-fallback-inline.contract.test.ts \
  tests/tui/workbench/buffer-external-editor-provider.contract.test.ts \
  tests/tui/workbench/buffer-external-editor.test.ts \
  tests/tui/workbench/buffer-neovim-e2e-contract.test.ts \
  tests/tui/workbench/buffer-docs-config.contract.test.ts \
  --reporter=dot
# Hosted `platform-tests / neovim` provisions the exact v0.12.1 binary.
# This command deliberately fails when that pinned capability is unavailable.
node runtime/scripts/run-hermetic-vitest.mjs --require-zero-skips \
  run --config vitest.neovim.config.ts --allowOnly=false
# The hosted five-target lane adds provider, observed-descendant, and platform
# contracts on Linux x64/arm64, Darwin x64/arm64, and Windows x64.
node runtime/scripts/run-hermetic-vitest.mjs --require-zero-skips \
  run --config vitest.neovim-platform.config.ts --allowOnly=false
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-buffer-neovim
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-visual-smoke
npm run build
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
node scripts/check-embedded-neovim-buffer.mjs
```

## Related

- TUI / workbench overview: [`reference/tui-workbench.md`](reference/tui-workbench.md)
- In-tree TUI notes: [`runtime/src/tui/README.md`](../runtime/src/tui/README.md)
