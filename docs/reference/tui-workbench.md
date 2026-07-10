# TUI & workbench

Summary of the fullscreen terminal UI. Durable design notes and implementation
detail live in the in-tree README:

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

- Explorer (interactive)
- Center work-surface (switches by active surface)
- Agents rail (visible at wide widths)
- Approvals / tasks
- BUFFER editor surface (embedded Neovim preferred — see
  [`../embedded-neovim-buffer.md`](../embedded-neovim-buffer.md))

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
