# Decisions

## 2026-04-29: Planner/TUI source split

- AgenC planner and plan-mode TUI parity tracks `../openclaude` first.
- `VerifyPlanExecutionTool` may be sourced from `../openclaude`; if absent there, inspect `../Claude`.
- AgenC agent execution and runtime behavior continue to track the Codex-derived runtime port.
- Current-main terminal UI wiring lives in `runtime/src/watch`; do not revive the deleted React/Ink `runtime/src/tui` shell as the live TUI unless a later architecture decision explicitly restores it.
- All work for the OpenClaude TUI parity closure is local-only: no push, no remote branch, no PR.
