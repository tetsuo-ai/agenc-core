# Embedded Neovim BUFFER

BUFFER is the fullscreen workbench's workspace editor. It prefers a supervised
`nvim --embed` process when Neovim 0.9.0 or newer is available. Neovim owns the
editing model, commands, buffers, plugins, command line, messages, and popup
menus. AgenC owns the process boundary, terminal-grid rendering, editor/chat
handoff, disk-conflict checks, and the rules for leaving a workspace with
unsaved changes.

The important operator model is:

- **Agent** and **Editor** are sibling views of one workspace and one daemon
  session, not separate agents. `Alt+1` opens Agent, `Alt+2` opens Editor, and
  the `Alt`+backtick chord cycles between them; the tab labels are also
  clickable. Agent keeps the normal conversation/task surface while Editor
  keeps the live Neovim workspace. Each view restores its own focus, side rail,
  active file, in-progress composer draft, and captured attachment set.
- Both views submit to the same canonical conversation through the same
  composer mechanism, while drafts and attachments remain owned by the view
  where they were created. Submitting from Editor leaves Neovim mounted and
  opens the transcript beside it, so the response is visible without replacing
  the buffer.
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
- `Alt+H` focuses the project explorer, including from a fresh Editor that
  still shows **No file selected** and has not started a provider.
- `Ctrl+R` remains Neovim's native redo. `Alt+R` moves the current file to the
  workbench review rail.
- `Alt+L` focuses the Editor's open AI/proposal panel. Page Up, Page Down,
  mouse wheel, Ctrl+Home, and Ctrl+End scroll that panel; `Ctrl+W H` returns
  focus to Neovim. With no panel open, `Alt+L` remains available to Neovim.
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

[buffer.prediction]
enabled = "ask"         # ask | on | off
debounce_ms = 160
timeout_ms = 2500
max_output_tokens = 256
# provider = "grok"      # optional user-selected prediction route
# model = "grok-4.5"
```

Provider modes:

| Mode             | Behavior                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Prefer embedded Neovim; fall back to basic inline BUFFER when discovery fails or every configured startup attempt fails with cleanup confirmed                          |
| `neovim`         | Request embedded Neovim; discovery failure keeps BUFFER usable through inline fallback, but a discovered executable that fails startup remains an explicit Neovim error |
| `inline`         | Use the basic in-process editor; it does not claim exact Vim behavior                                                                                                   |
| `external`       | Use the explicit external-editor handoff provider                                                                                                                       |

Environment variables override `config.toml` for the current AgenC process:

| Environment variable                     | Config equivalent / effect                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `AGENC_BUFFER_PROVIDER`                  | `[buffer].provider`                                                         |
| `AGENC_BUFFER_NVIM`                      | `[buffer.neovim].executable`                                                |
| `AGENC_BUFFER_NVIM_USE_INIT=1`           | Force user init (`init = "user"`)                                           |
| `AGENC_BUFFER_NVIM_USE_INIT=0`           | Force clean mode (`init = "clean"`)                                         |
| `AGENC_BUFFER_NVIM_TIMEOUT_MS`           | `discovery_timeout_ms`                                                      |
| `AGENC_BUFFER_NVIM_STARTUP_TIMEOUT_MS`   | `startup_timeout_ms`                                                        |
| `AGENC_BUFFER_NVIM_OPERATION_TIMEOUT_MS` | `operation_timeout_ms`                                                      |
| `AGENC_BUFFER_NVIM_CLEANUP_TIMEOUT_MS`   | `cleanup_timeout_ms`                                                        |
| `AGENC_BUFFER_NVIM_SESSION=file`         | Temporary rollback to the legacy per-file process lifetime for this session |

Provider, executable, init, and deadline changes apply the next time AgenC
safely starts an editor provider. Saving `/config` never tears down a live
workspace—or its hidden dirty buffers—just to apply a setting.

Unset values use the defaults shown above. Invalid environment values do not
become partial configuration: unknown provider values resolve to `auto`,
unrecognized init booleans leave init selection automatic, and non-positive
deadlines are ignored.

Predictive completion is consent-gated by default. With `enabled = "ask"`, the
first eligible insert-mode request opens a modal before any source is sent:
`Alt+Y` persists `enabled = "on"`, `Alt+N` persists `enabled = "off"`, and
`Esc` dismisses the question without changing configuration. Ordinary editor
typing and Enter pass through unchanged while the question is visible, so an
in-flight edit cannot accidentally grant consent. `/config` can change the
choice later. Provider and model selection come only from the owner's trusted
`[buffer.prediction]` configuration; file contents and daemon RPC callers
cannot change the route. When no override is configured, prediction
independently uses the active session route.

After the configured debounce, an eligible regular, modifiable Neovim buffer
sends a bounded source prefix/suffix to a separate, tool-free prediction
provider. The request never enters the conversation transcript. AgenC filters
ignored, binary, credential, and secret-bearing files, and cancels stale work
when the buffer, revision, cursor, insert mode, or viewport changes. A result
appears as dim inline/multiline ghost text without changing the buffer.

The first eligible prediction in a cold workspace provisions the same daemon
session that later Editor and Agent turns use, but leaves it turn-free: it
creates no user message or conversation model call and keeps hooks, MCP,
recovery, watchers, and other Agent startup work staged. The first real
submission reuses that attached session and preserves any context queued before
prediction began. Closing before a real submission stops the idle session
instead of leaving a background agent behind.

- `Tab` accepts the whole visible prediction when Neovim's completion popup is
  closed.
- `Ctrl+Right` accepts the next whitespace/token segment and leaves the
  remainder visible.
- `Esc`, leaving insert mode, editing, moving away, or scrolling dismisses it.
- With no current ghost, AgenC replays the buffer's previous mapping or native
  Neovim behavior for `Tab` and `Ctrl+Right`.

Displayed/accepted/dismissed feedback is content-free; source text is not
included in feedback events.

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

| Value            | Behavior                                                                                |
| ---------------- | --------------------------------------------------------------------------------------- |
| `auto` (default) | Show the strip when at least two eligible buffers exist                                 |
| `always`         | Show it whenever at least one eligible buffer exists                                    |
| `never`          | Hide the host strip; Neovim's own `:buffer`, `:bnext`, plugins, and mappings still work |

Unlisted and unloaded buffers stay in Neovim's safety manifest but are not
rendered as host tabs. Regular unnamed buffers are the exception: they appear
as `[No Name]` (with the buffer handle added when disambiguation is needed).
Hiding a tab therefore never means a hidden buffer is omitted from dirty-state
or exit checks.

## Neovim-to-Agent bridge

Embedded sessions install six primary AgenC commands after user init:

| Neovim command                 | Policy and handoff                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:AgenCAttach [prompt]`        | Capture live context and focus the shared composer. An argument pre-fills the draft; it never submits by itself or forces open the transcript rail. |
| `:AgenCAsk [question]`         | Read-only AI turn. A supplied question submits immediately; without one, AgenC opens the transcript rail and waits in the composer.                 |
| `:AgenCExplain [instruction]`  | Read-only AI turn submitted immediately, using `Explain this editor context.` when no instruction is supplied.                                      |
| `:AgenCFix [instruction]`      | Proposal-only AI turn submitted immediately, using `Fix this editor context.` by default.                                                           |
| `:AgenCEdit [instruction]`     | Proposal-only AI turn. A supplied instruction submits immediately; without one, AgenC waits in the composer.                                        |
| `:AgenCRefactor [instruction]` | Proposal-only AI turn. A supplied instruction submits immediately; without one, AgenC waits in the composer.                                        |

`:AgenCReview` remains a compatibility alias for the proposal-only Refactor
flow; new mappings should use `AgenCRefactor`.

Without a range, a command captures the current buffer. An Ex range captures
those complete lines, for example `:'<,'>AgenCExplain`. Regular unnamed
buffers are captured as `[No Name]` live snapshots without inventing a
filesystem path.

Matching `<Plug>` mappings are installed for user configuration:

- `<Plug>(AgenCAttach)`
- `<Plug>(AgenCAsk)`
- `<Plug>(AgenCExplain)`
- `<Plug>(AgenCFix)`
- `<Plug>(AgenCEdit)`
- `<Plug>(AgenCRefactor)`
- `<Plug>(AgenCReview)` (compatibility alias)

In normal mode a `<Plug>` action captures the current buffer; in visual mode
it captures the exact characterwise, linewise, or blockwise selection. No
default key mappings are installed. For example:

```lua
vim.keymap.set({ "n", "x" }, "<leader>aa", "<Plug>(AgenCAttach)")
vim.keymap.set({ "n", "x" }, "<leader>ae", "<Plug>(AgenCExplain)")
vim.keymap.set({ "n", "x" }, "<leader>af", "<Plug>(AgenCFix)")
```

### Exact unsaved attachment semantics

An editor capture records the live buffer's path, range, selection mode, text,
dirty flag, buffer handle, and Neovim `changedtick`. If the buffer is modified,
the composer labels it an **unsaved live-buffer snapshot**. AgenC wraps
captured text as untrusted workspace data and sends those exact live bytes,
not a later disk read, when the prompt is submitted.

Capture and proposal ranges use one explicit coordinate contract: lines are
1-based, columns are 0-based UTF-8 byte offsets, and the end position is
exclusive. Characterwise, linewise, and blockwise selections retain their
selection mode across the TUI, daemon, policy prompt, and proposal validation
boundary.

These captures deliberately do not materialize as a stale `@path` reference:
resolving `@path` later would read disk and could silently replace unsaved
editor bytes with older content. Text inside the framed Editor request is
never reparsed as `@file` or `@agent` syntax either: a buffer line such as
`@.env` remains untrusted text and cannot create a second attachment. Only
chips the user explicitly captured before submission are admitted. An
attachment chip can be removed directly; Backspace removes the last chip when
the composer is empty, and a successful submission clears the captured
attachments.

Exact capture is bounded to **64 KiB** and **2,000 lines**. AgenC refuses a
larger buffer or selection with an actionable “select a smaller range” error;
it never labels a truncated prefix as exact.

Every Ask, Explain, Fix, Edit, or Refactor handoff keeps BUFFER mounted, opens
the transcript rail beside it, and focuses that rail so the response is
immediately visible and scrollable, including in compact overlay layouts.
`Ctrl+W H` returns focus to Neovim. Attach deliberately stops at the composer.

### Read-only turns and shadow proposals

Editor interactions are request-scoped and daemon-enforced:

- Ask and Explain are **read-only**. The model may use explicitly read-only
  tools, but cannot call the editor proposal tool or mutate files, processes,
  tasks, configuration, or git state.
- Fix, Edit, and Refactor are **proposal-only**. The model may inspect with
  read-only tools and must return the requested change through one validated
  `EditorProposal`; ordinary mutating tools are unavailable for that turn.
- Attach only captures context. What happens next is determined by the prompt
  the user submits through the normal composer.

This policy also covers work that normally surrounds an Agent turn. An Editor
request may start the selected primary model, perform audited local text/image
reads, and record the normal private transcript, rollout, cost, error,
file-history, proposal, and lease metadata needed to make the request
recoverable. Its captured attachments are resolved in local-read-only mode:
they cannot invoke MCP resources, memory lookup, or PDF helper processes, and
`FileRead` refuses PDFs for the same reason. Grep, Glob, and Orient use the
lockfile-pinned ripgrep binary by absolute path and pass `--no-config`; an
Editor query therefore cannot select a PATH executable or activate an
operator-configured `rg --pre` command. Missing packaged ripgrep is an explicit
tool error with `agenc doctor` and same-version reinstall guidance, never a
JavaScript search fallback.

An Editor request does **not** initiate configured lifecycle or prompt hooks,
MCP startup or discovery, cron/job recovery, skill-watcher configuration
hooks, prompt suggestions, memory or documentation learning, tool summaries,
or any secondary model call. A cold daemon session stages those Agent
facilities without starting them. The first ordinary submission without an
Editor read-only/proposal policy activates them in their normal order,
beginning with the matching
`SessionStart`; closing an Editor-only session discards the staged work and
does not emit an unmatched `SessionEnd`. Shutdown closes turn admission
synchronously, cancels startup in flight, and cleans up a daemon attachment
that finishes after the TUI has already closed.

The boundary is an initiation guarantee for the Editor request. Work already
running elsewhere in the shared daemon, and unsolicited notifications from
that work, may still overlap in time. User Neovim configuration remains
trusted executable code when `init = "user"` or the default automatic
user-init attempt is selected; use clean mode for an untrusted workspace.

A proposal is a shadow edit: Neovim highlights replaced text and renders added
lines virtually, while the real buffer remains unchanged. The proposal rail
shows each edit and its old/new text. Use `j`/`k` to inspect changes, Page Up /
Page Down or the mouse wheel to scroll the selected change, `y`/`Enter` to
accept, or `n`/`q` to reject.

Editor admits one review at a time. The gate begins as soon as a proposal is
announced and remains active while Neovim stages it and while the resulting
shadow proposal is unresolved. Another Editor submission remains in its
originating draft instead of replacing the proposal rail or creating an
unreviewable second edit. Accept or reject the current proposal first; the
Agent tab remains available for normal conversation.

That review boundary also owns shutdown and session switching. `/exit`,
`/quit`, `Ctrl+D`, and `/resume` cancel their transition and return to Editor
while a proposal-only model turn is active, its result is being staged, or its
shadow proposal still needs a decision. Once the proposal is accepted or
rejected, the requested transition can be repeated normally.

The daemon validates the captured path, buffer handle, content hash, and
`changedtick` when the model returns a proposal. Neovim then validates the
path, handle, `changedtick`, ranges, and exact `old_text` when staging and again
at acceptance. If the buffer, path, revision, or replaced text changed,
acceptance fails as stale instead of applying to newer work. Accepted edits
join into one Neovim undo step and leave the buffer modified but unsaved;
rejection only clears the shadow proposal.

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

### Daemon workspace mutation lease

While embedded Neovim is live, the TUI holds one renewable daemon lease for
the workspace and synchronizes the exact handle, path, hash, `changedtick`, and
dirty state of every loaded file buffer. Clean buffers send revision metadata
only; dirty buffers send their live content to the in-memory lease so agent
reads see the editor's current bytes instead of stale disk.

Coordinated file writes use a fail-closed admission protocol:

- A path that is not loaded in Editor receives a one-use mutation token. The
  daemon rechecks editor authority immediately before commit.
- Every loaded path—clean or dirty—is protected by Editor authority. An Agent
  write becomes a reviewable proposal bound to the exact buffer hash and
  `changedtick`. This closes the publication race where the user starts typing
  after a tool read but before the next debounced editor sync.
- A dirty path whose editor lease expired, crashed, or stopped reporting is
  quarantined as stale and all reads/writes are blocked until the editor
  reconnects and proves its revision or the user deliberately resolves it.

On reconnect, orphaned Editor authority replaces the Editor surface with a
recovery card. This includes dirty revisions and last-known-clean buffers whose
disk path changed while the daemon was stopped. Prefer **Recover** from a
matching private Neovim swap when one is offered; durable quarantine retains
revision fingerprints, not the previous source text. The card reviews one path
at a time. Press `E` to enter the loaded Recovery Editor when you first need
`:edit!` to reload it or `:bd!`/`:bdelete!` to unload a missing path. This is a
host-owned hard-quarantine command surface: arbitrary native input, mappings,
shell/Lua commands, paste, mouse input, and tab selection are not forwarded to
Neovim. `Ctrl+G` returns to the review. Ordinary embedded Neovim and user
configuration remain intentionally unsandboxed outside this recovery surface.

If no usable revision remains, **Use Disk** is the explicit destructive
choice: press `D` (or click) once to arm it and again to confirm. The daemon
re-reads that disk path and requires its exact reviewed hash and byte count to
still match. That final descriptor-bound read is the decision point; a later
external write is treated as a new disk revision. A changed or unavailable
path rejects the operation and keeps the card active; after restoring or
removing an unavailable path, press `R` to re-read only its disk evidence; the
refresh does not synchronize the loaded buffer or resolve its quarantine.
Success permanently discards that orphaned revision and any pending proposals
based on it. Remaining paths are reviewed separately, and Agent and shell
operations resume only after protected Editor authority is resolved.

Heartbeats renew the lease; editor close and TUI cleanup release it without
silently abandoning dirty authority. The same coordinator covers direct file
edits, file writes, and apply-patch operations, and records whether each
attempt was applied, proposed, blocked, or discarded.

Native full-buffer writes use the same authority boundary. Before Neovim runs
user init, AgenC installs a fail-closed launch guard. Once the embedded RPC
channel is ready, `BufWritePre` synchronously publishes the exact manifest and
waits for the daemon acknowledgement; an executing Agent mutation therefore
aborts `:write` before disk changes. `:saveas` is supported because Neovim
adopts the new buffer path before that check. Workspace range/alternate-path
writes (`:[range]write path`) and append writes (`:write >> path`) are also
intercepted, but refused because their destination bytes cannot be represented
as one exact loaded-buffer revision. Write those forms outside the workspace,
or use a full-buffer `:saveas` inside it.

Project Explorer create and file-delete operations reserve an authenticated
topology fence before touching disk. The fence spans the disk change and the
matching Neovim buffer update, then publishes the complete post-operation
buffer manifest atomically. They pin the admitted workspace-parent and target
identity, recheck exact file contents immediately before deletion, and never
roll back through a pathname whose identity changed. A pre-effect identity
exchange releases the fence without touching the new path; a post-effect
identity mismatch stays quarantined as unknown instead of releasing the path
as clean.

Explorer and Agent file transactions share a supervised private-Node helper.
It binds its working directory to the captured parent before the final
caller-controlled check, verifies that cwd identity before every command, and
accepts only validated path segments and basenames. Existing-file rewrites stay
on a verified file descriptor. Missing create parents are traversed or created
one segment at a time, and file/symlink deletes run inside the bound parent.
An ancestor rename or symlink exchange can therefore move the intended
directory but cannot redirect bytes outside it; helper startup is the
capability probe, and failure refuses the operation instead of falling back to
a raw pathname.

Recursive Explorer directory deletion first moves the verified directory to a
cryptographically random same-parent quarantine name, verifies that the moved
inode is the admitted directory, then removes that private subtree. Same-parent
regular-file rename uses the same quarantine step, publishes the destination
with an exclusive hard link, and removes the private name, so it cannot
overwrite a competing destination. Cross-parent, directory, and symlink rename
remain intentionally unsupported because portable Node exposes no
identity-bound atomic no-clobber destination primitive; the rename prompt keeps
the actionable error visible so the user can choose another name or close
Editor and use trusted external tooling.

Node does not expose an identity-matched `unlinkat`, so a hostile
same-directory actor can still exchange the source leaf name in the final
unlink/quarantine-rename syscall boundary. The helper rechecks identity at the
last available point and the bound parent prevents that known leaf race from
escaping the admitted directory.

MCP, plugin, dynamically discovered, code-mode, and other uncoordinated tools
are not allowed to execute while Editor owns loaded workspace buffers.
Operator pre/post/failure hooks are also suppressed across coordinated editor
writes, because extension code cannot participate in the revision protocol.
Close Editor first when an external mutation tool is intentionally required.

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
Normal TUI teardown waits for a final exact workspace sync and daemon-lease
release before destroying the Neovim provider. If either step cannot be
confirmed, teardown fails visibly and leaves the provider available for
recovery instead of claiming the editor was safely detached.
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
