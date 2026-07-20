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

| Layout | When |
| --- | --- |
| **Workbench** (`workbench/WorkbenchLayout.tsx`) | Default fullscreen when `isWorkbenchEnabled()` is true |
| **Classic fullscreen** (`FullscreenLayout.tsx`) | `AGENC_TUI_WORKBENCH=0` or workbench disabled |

Workbench panes (not mounted inside the transcript `ScrollBox`):

- Explorer (interactive): file-type icons/colors; click to open, mouse wheel
  or arrows to scroll, file preview inside the TUI
- Center work-surface (switches by active surface)
- Agents rail (visible at wide widths): live swarm panel with per-agent
  progress, tokens, and duration while background agents run
- Approvals / tasks
- BUFFER editor surface (embedded Neovim preferred — see
  [`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md))

## Operator surfaces added in 0.7.2

- **`ctrl+r` review rail** — moves the open file to a shiki-highlighted
  right-hand rail; chat keeps the center so you can review while prompting.
- **Todo board** — pins itself below the composer while the agent has open
  tasks and hides after completion. Backed by per-task JSON files shared with
  the daemon under the conversation id; the TUI learns of daemon writes via
  `fs.watch` plus an unconditional fallback poll.
- **Plan approval overlay** — clamped markdown plan (14 lines, `ctrl+o` to
  expand) with approve / review / keep-planning options always on screen.
- **`AskUserQuestion` picker** — numbered options, arrows, free-text Other;
  answers are recorded client-side and shipped with the `tool.approve` RPC
  (`askUserQuestionInput`) so the daemon-side tool resumes with them.
- **Turn lifecycle** — `esc` always clears busy latches immediately; a 20s
  submit-ack watchdog recovers turns the daemon never acknowledged, and a
  60s daemon-stall watchdog closes turns that go fully silent.
- **`/effort`** — show or set reasoning effort (`low`/`medium`/`high`) for
  the current model, validated against the model catalog; `/effort default`
  restores the model default.

Classic fullscreen owns v2 top chrome and status bar (`BrandCells`,
`TuiHeader`, `StatusBar`). Plan mode shows a `PlanModeBanner` above scrollback.

## v2 design primitives

`runtime/src/tui/components/v2/` — shared header/status/menu/message chrome.
Legacy `components/messages/` and `components/permissions/` visual subtrees
were removed; live transcript and permission rendering use v2 primitives.

Theme roles: `runtime/src/utils/theme.ts` (+ design-system resolvers under
`components/design-system/`).

## Important slash commands

Interactive menus (via `MenuModal`) include:

`/model`, **`/provider`**, `/hooks`, `/skills`, `/mcp`, `/plugins`,
`/permissions`, `/memory`, `/resume`, `/config`, `/agents`, `/status`, `/diff`

- Provider switch is **`/provider` only** — there is **no** `/model-provider`.
- `/context` (alias `/ctx`) uses `ContextUsageModal` when the TUI bridge is
  available.
- Protocol commands `/claim`, `/delegate`, `/proof`, `/settle`, `/stake` are
  registered from `commands/protocol.ts` with plugin-style attribution.

## BUFFER (editor)

Providers: `auto` | `neovim` | `inline` | `external` via
`AGENC_BUFFER_PROVIDER`. Full contract:
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
