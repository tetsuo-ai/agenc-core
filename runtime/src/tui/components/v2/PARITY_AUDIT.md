# TUI v2 Parity Audit

Status: complete for `TUI-TODO-021`.

Run from the repository root:

```bash
npm run check:tui-v2-design-audit
```

## Audit Scope

- `designStateSmoke.test.tsx` enumerates every numbered design state from `01a` through `19c`.
- The static audit renders each state at `148x40`, then `120x30`, then `80x24`, and checks header, body, prompt, status, truncation, brand bleed, and row width.
- The fixture-backed audit checks browser-derived text markers, row/column drift, color-family alignment, anchored text cells, and optional exact-cell diagnostics.
- `check-tui-command-visual-smoke.mjs` opens the built CLI in a real PTY at the same three viewports and verifies live command surfaces are visible, have close or scroll affordances, and do not regress slash hint spacing.
- The full TUI gate rebuilds the runtime and verifies built-artifact import, startup, footer/mode parity, core TUI parity, and yolo cold start behavior.

## State Map

| State | Design surface | Implemented surface | Gate evidence | Result |
|---|---|---|---|---|
| `01a` | cold welcome | `WelcomeColdPanel`, `TerminalFrame`, live cold start | static state, runtime startup | Complete |
| `01b` | resumed task | `TaskInFlightCard`, `TerminalFrame` | static state | Complete |
| `02a` | slash menu | `SlashPalette`, command registry | static state, command smoke | Complete |
| `02b` | filtered slash menu | `SlashPalette`, slash filtering | static state, command smoke | Complete |
| `03a` | streaming plan | `Msg`, `PlanList`, `Tool` | static state | Complete |
| `03b` | reasoning and inline tools | `Msg`, `Tool`, status segments | static state | Complete |
| `04a` | tool sequence | `Tool` read, grep, bash cards | static state | Complete |
| `04b` | expanded diff | `DiffInline`, `/diff` menu | static state, command smoke | Complete |
| `05a` | low-risk approval | `ApprovalCard`, permission primitives | static state | Complete |
| `05b` | high-risk approval | `ApprovalCard`, permission primitives | static state | Complete |
| `06a` | protocol slashing recovery | `ProtocolEvent`, system message chrome | static state | Complete |
| `06b` | bash failure recovery | `Tool`, recovery message chrome | static state | Complete |
| `07a` | clean completion | completion receipt message chrome | static state | Complete |
| `07b` | retrospective | markdown message chrome | static state | Complete |
| `08a` | file picker | file reference overlay | static state | Complete |
| `08b` | shell mode | shell prompt state | static state | Complete |
| `09` | markdown output | streaming markdown renderer primitives | static state | Complete |
| `10` | context modal | `ContextUsageModal`, `/context`, `/ctx`, `/compact` | static state, command smoke | Complete |
| `11` | model menu | `/model` v2 menu | static state, command smoke | Complete |
| `12` | skills menu | `/skills` v2 menu | static state, command smoke | Complete |
| `13` | MCP menu | `/mcp` v2 menu | static state, command smoke | Complete |
| `14` | hooks menu | `/hooks` v2 menu | static state, command smoke | Complete |
| `15` | plugins menu | `/plugins` v2 menu | static state | Complete |
| `16` | agents menu | `/agents` v2 menu | static state, command smoke | Complete |
| `17` | permissions menu | `/permissions` v2 menu | static state, command smoke | Complete |
| `18` | memory menu | `/memory` v2 menu | static state, command smoke | Complete |
| `19a` | background tasks | `BackgroundTasksPanel`, `/tasks` | static state, command smoke | Complete |
| `19b` | plan mode | `PlanModeBanner`, plan accept flow | static state, full TUI gate | Complete |
| `19c` | mode switcher | permission-mode title, footer mode surface | static state, full TUI gate | Complete |

## Drift Register

- Missing numbered states: none. `designStateSmoke.test.tsx` fails if the state list diverges from `01a` through `19c`.
- Missing live command surfaces: none known. The command smoke covers the retained user-facing v2 command surfaces at `148x40`, `120x30`, and `80x24`.
- High-impact visual drift: none known. Menu placement below the viewport, missing close/scroll affordances, malformed slash hint spacing, missing frame chrome, and line overflow are covered by gates.
- Product decision: exact projected browser cell parity remains an opt-in diagnostic through `AGENC_TUI_DESIGN_EXACT_CELLS=1`. It is not the default gate because the committed fixtures already enforce bounded row, column, color-family, and anchored-cell coverage without requiring a local design bundle.
- Follow-up TODO items: none. Any future drift found by the exact-cell diagnostic or manual review must be added as an exact `TODO.md` item before a parity audit is marked complete.
