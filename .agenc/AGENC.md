# AgenC Agent Memory

## Durable Rules

### AgenC Agent State Home
- **Trigger:** Creating, describing, or looking for AgenC-specific agent/session/tooling state, notes, traces, design handoffs, run logs, or durable artifacts.
- **Correct approach:** Store and reference AgenC-owned state under `.agenc/`, not `.claude/`. Treat `.claude/` as legacy external-agent state only; do not present it as the correct home for AgenC artifacts, and prefer migrating or recreating relevant AgenC state in `.agenc/` when touched.
- **Learned:** 2026-05-17
