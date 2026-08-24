# TUI & workbench

Operator-facing summary of the fullscreen terminal UI (not a full keybinding
manual). Implementer depth, Ink fork notes, and theme details live in the
in-tree README:

**→ [`runtime/src/tui/README.md`](../../runtime/src/tui/README.md)**

## What the TUI is

- Custom **Ink fork** under `runtime/src/tui/ink/` (react-reconciler + Yoga),
  not upstream `ink`.
- Process entry: `main.tsx` → `render(<AgenCTuiApp …/>)` with alt-screen
  teardown, FPS tracking, and backpressure recording.
- All real work still flows through the **daemon**; the TUI is a client view
  onto daemon-owned sessions.

## Layouts

| Layout                                          | When                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| **Workbench** (`workbench/WorkbenchLayout.tsx`) | Default fullscreen when `isWorkbenchEnabled()` is true |
| **Classic fullscreen** (`FullscreenLayout.tsx`) | `AGENC_TUI_WORKBENCH=0` or `false`                     |

`WorkbenchPane` is `explorer | surface | agents | composer | rail`. Approvals
are an overlay (`ctrl+w d`), not a pane. Tasks live in the spinner board
(above the composer) and the Agents rail.

Workbench chrome (not mounted inside the transcript `ScrollBox`):

- Explorer (interactive): file-type icons/colors; click to open, mouse wheel
  or arrows to scroll, file preview inside the TUI. A bound helper safely
  creates missing parent directories and supports file, symlink, and recursive
  directory deletion. Rename is no-clobber for regular files that stay in the
  same directory; cross-directory and non-file rename remains fail-closed with
  an actionable prompt error. Hidden below 100 columns unless focused.
- Center work-surface (transcript, preview, BUFFER, diff, test, shell, search,
  agent)
- Agents rail: only at `>= 130` columns, Agent tab, not maximized, and either
  there are agent tasks or no review rail
- Optional right-hand rail for file review, transcript, or change review
- BUFFER editor surface (embedded Neovim preferred — see
  [`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md))

Workbench status bar shows `agenc / WORKBENCH`, activity, model, ctx, version.
Permission-mode pill and `PlanModeBanner` are **classic fullscreen only**.
Workbench layout is derived from the active viewport and session state; there
is no inert operator layout setting.

## Operator surfaces added in 0.7.2

- **Review rail** (`Alt+R` in embedded Neovim, `Ctrl+R` in the inline
  fallback) — moves the open file to a shiki-highlighted right-hand rail; chat
  keeps the center so you can review while prompting.
- **Todo board** — `TaskListV2` in the spinner, **above** the composer. Hides
  ~5s after all tasks complete (`HIDE_DELAY_MS`). Backed by per-task JSON
  files; `fs.watch` plus a 5s poll.
- **Plan approval overlay** — clamped markdown plan (14 lines, `ctrl+o` to
  expand). On-screen choices: “yes, and auto-accept edits” / “yes, and
  manually approve edits” / “no, keep planning”.
- **`AskUserQuestion` picker** — numbered options, arrows, free-text Other;
  answers are recorded client-side and shipped with the `tool.approve` RPC
  (`askUserQuestionInput`) so the daemon-side tool resumes with them.
- **Turn lifecycle** — `esc` always clears busy latches immediately
  (`handleTurnCancel`). A 20s submit-ack watchdog (`SUBMIT_ACK_WATCHDOG_MS`)
  recovers turns the daemon never acknowledged. There is no 60s stall timer.
- **`/effort`** — show or set reasoning effort (`low` / `medium` / `high` /
  `xhigh` when the model catalog lists it) for the current model;
  `/effort default` restores the model default.

Classic fullscreen owns v2 top chrome and status bar (`BrandCells`,
`TuiHeader`, `StatusBar`). Plan mode shows a `PlanModeBanner` above scrollback.

## v2 design primitives

`runtime/src/tui/components/v2/` — shared header/status/menu/message chrome.
Legacy `components/messages/` and `components/permissions/` visual subtrees
were removed; live transcript and permission rendering use v2 primitives.

Theme roles: `runtime/src/utils/theme.ts` (+ design-system resolvers under
`components/design-system/`).

## Workbench chords and composer

`?` toggles HelpV2. Footer when not in BUFFER: `/ commands`, `@ attach`,
mode cycle, `ctrl+o` transcript, `? shortcuts`.

| Keys | Action |
| --- | --- |
| `Ctrl+W H/L/J/K/W` | Explorer / surface / composer / up / next pane |
| `Ctrl+W D` | Diff / full hunk review |
| `Ctrl+W F` | Search surface |
| `Ctrl+R` | File review rail (workbench / inline BUFFER). Neovim uses `Alt+R` |
| `Alt+1` / `Alt+2` / `` Alt+` `` | Agent / Editor / cycle |
| `Ctrl+C` | Interrupt |
| `Ctrl+D` | Exit |
| `Ctrl+T` | Todos |
| `Shift+Tab` | Composer: cycle permission mode. BUFFER: focus composer |

Composer vim: `tui.vimMode = true` in canonical `config.toml`. Esc in INSERT goes
NORMAL instead of cancel. Mouse tracking is on unless `AGENC_DISABLE_MOUSE`.

## Important slash commands

Interactive menus (via `MenuModal`) include:

`/model`, **`/provider`**, `/hooks`, `/skills`, `/mcp`, `/plugins`,
`/permissions`, `/memory`, `/resume`, `/config`, `/keybindings`, `/agents`, `/status`,
`/diff`, `/help`, `/output-style`

Full registry: [slash-commands.md](slash-commands.md).

- Provider switch is **`/provider` only** — there is **no** `/model-provider`.
- `/context` (alias `/ctx`) uses `ContextUsageModal` when the TUI bridge is
  available.
- `/keybindings` creates a canonical `tui.keybindings` scaffold when needed,
  opens `config.toml` through the locked validated editor workflow, and reloads
  the ConfigStore snapshot. Explicit removals use each block's `unbind` array.
- Protocol commands `/claim`, `/delegate`, `/proof`, `/settle`, `/stake` are
  registered from `commands/protocol.ts` with plugin-style attribution.

## BUFFER (editor)

BUFFER is a workspace surface, not a modal editor subprocess that disappears
when its pane is hidden. By default, one embedded Neovim process keeps all
loaded buffers alive across project-tree navigation and editor/chat handoffs.
Agent and Editor are sibling tabs over that same workspace and daemon session;
switching tabs never starts a second conversation or editor process. Each tab
retains its own draft and captured attachments, so delayed editor handoffs
cannot replace or submit Agent-tab context.

| Shortcut               | BUFFER action                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `Alt+1`                | Open the Agent tab and restore its transcript, rail, focus, and composer draft        |
| `Alt+2`                | Open the Editor tab and restore its Neovim workspace, rail, focus, and composer draft |
| `Alt`+backtick         | Cycle between Agent and Editor                                                        |
| `Shift+Tab` or `Alt+J` | BUFFER-focused: composer. Composer-focused: cycle permission mode (`chat:cycleMode`)  |
| `Alt+Q`                | Hide BUFFER; the Neovim workspace remains alive                                       |
| `Alt+Z`                | Maximize or restore the center editor                                                 |
| `Ctrl+S`               | Save the active buffer with AgenC's disk/agent conflict checks                        |
| `Alt+R`                | Neovim: review rail. Inline BUFFER: `Ctrl+R` is the review rail (`Ctrl+X Y` is redo) |
| `Alt+H`                | Focus the project explorer, including from a fresh **No file selected** Editor        |
| `Alt+L`                | Focus the open Editor AI/proposal panel; pass through to Neovim when no panel is open |
| `Alt+E`                | Open the configured external editor, only when every Neovim buffer is confirmed clean |

Neovim's command line, messages, completion popups, user init, and plugins
render in its native grid. The grid tracks the measured center pane, including
when rails are toggled or BUFFER is maximized. A clickable host tab strip shows
eligible loaded buffers according to `buffer.show_tabs = "auto" | "always" |
"never"`; modified tabs carry a `●`.

`Ctrl+X`, `Ctrl+K`, `Ctrl+G`, and `Ctrl+R` pass through to embedded Neovim
instead of starting workbench chords. The basic inline fallback keeps its
existing `Ctrl+X H/J/L/Q/Z`, `Ctrl+X Y`, `Ctrl+R`, and
`Ctrl+X Ctrl+E`/`Ctrl+G` host bindings. User keybinding overrides therefore
target the `BufferHost` context for embedded Neovim and `Buffer` for inline.
An Editor AI request focuses its panel as it opens, including when the panel is
a compact overlay. Surface `pageup`/`pagedown` and `g`/`G` scroll the proposal
chrome. `Ctrl+Home` / `Ctrl+End` work only while `ScrollKeybindingHandler` is
active (Editor rail focused). `Ctrl+W H` from a focused rail returns to the
editor.

Ask/Explain run under a daemon-enforced read-only Editor policy; Fix/Edit/
Refactor run under proposal-only policy and never apply model output directly
to the buffer. Editor requests cannot start configured hooks, MCP, background
job recovery, skill watchers, memory/docs learning, or secondary model calls.
Framed buffer text is never reparsed as `@file`/`@agent` syntax, and Editor
searches use AgenC's pinned ripgrep binary rather than an executable or config
selected through the operator environment. Grep, Glob, and Orient fail closed
if that packaged binary is unavailable; they never evaluate model patterns in
a synchronous JavaScript regular expression.
On a cold workspace, the first eligible prediction may provision the shared
daemon session without creating a conversation turn; the first real Editor or
Agent submission reuses it, and closing first tears it down. Agent-only startup
facilities remain staged until the first normal submission outside an Editor
read-only/proposal policy. The exact
allowed side effects, local-only attachment rules, proposal validation, and
shutdown behavior are documented in
[`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md).

If a transition would abandon one or more modified loaded buffers—including a
hidden Neovim buffer—the workbench stops it and offers **Save All**, **Discard
All**, or **Cancel**. Discard All requires a second confirmation; Save All
preflights the complete buffer set before it writes. The same gate covers
`/exit`, `/quit`, `Ctrl+D`, and `/resume`. Those transitions also remain
blocked during a proposal-only Editor turn, asynchronous proposal staging, and
shadow review; AgenC focuses the proposal panel so the user can accept or
reject it before retrying the transition.

After a crash leaves orphaned dirty authority—or a last-known-clean Editor path
changes during downtime—BUFFER shows a recovery card instead of leaving the
workspace silently blocked. It reviews one path at a time. Prefer a matching
Neovim swap when available; press `E` to open the loaded Recovery Editor. Its
hard-quarantine command surface is host-owned: only exact `:edit!`/`:bd!`
(`:bdelete!`) recovery actions are accepted, and native Neovim input, mappings,
paste, mouse input, and tab selection are not forwarded. Press `Ctrl+G` to
return. This narrow recovery restriction does not sandbox ordinary embedded
Neovim or user configuration outside quarantine. Otherwise **Use Disk**
requires two
`D` presses (or clicks), warns that the reviewed revision and proposals will be
discarded, and succeeds only if the daemon revalidates its exact disk
fingerprint (hash and byte count). Changed or unavailable disk state keeps the
recovery card and workspace protection in place. After restoring or removing
an unavailable path, press `R` to re-read only the card's disk evidence; this
does not synchronize the loaded buffer or resolve its quarantine.

Providers are `auto`, `neovim`, `inline`, and `external`. Configure them from
`/config`, `[buffer]` in `config.toml`, or temporary `AGENC_BUFFER_*`
environment overrides. Full lifecycle, recovery, editor/chat integration, and
troubleshooting contract:
[`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md).

## Permission modes in the header

Header mode pill reads `toolPermissionContext.mode`. User-addressable modes and
internal `unattended` / `bubble` — see
[`tools-permissions-sandbox.md`](tools-permissions-sandbox.md).

## Validation (common)

```bash
cd runtime && npx vitest run tests/tui/components/v2/ --reporter=dot
npm --workspace=@tetsuo-ai/runtime run check:tui-runtime-startup
npm --workspace=@tetsuo-ai/runtime run check:tui-workbench-visual-smoke
```

Broader suites and env knobs for design-state smoke are listed in
[`runtime/src/tui/README.md`](../../runtime/src/tui/README.md).

## Related

- Architecture: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Embedded Neovim BUFFER: [`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md)
- Agents rail / multi-agent: [`agents.md`](agents.md)
