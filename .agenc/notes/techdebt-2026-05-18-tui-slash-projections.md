## Tech Debt Report - 2026-05-18

Scope: local scan of the TUI files changed by commit `8c4c28e1`.
The full parallel-agent scan was not run because this session can only launch
subagents when explicitly requested by the user.

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None found in the changed surface. | n/a | n/a | n/a |

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Exact design-cell parity still has known remaining drift outside the slash-state projection fix. | `.agenc/notes/tui-design-goal-audit-2026-05-17.md` | The broad smoke and runtime gates pass, but the strict no-drift goal is not fully closed. | Continue state-by-state exact parity work before marking the visual replacement goal complete. |

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Large design smoke fixture file remains difficult to review. | `runtime/src/tui/components/v2/designStateSmoke.test.tsx` | State-specific alignment tweaks are easy to regress because many fixtures share helper code. | Split long fixture groups only after the exact parity push is complete, preserving the current gate behavior first. |

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| None found by the scoped text scan. | n/a | n/a | n/a |

### Summary
- Total issues: 2
- Critical issues: 0
- Commands run: focused design smoke, runtime typecheck, changed-file branding scan, whitespace check, full TUI validation gate, scoped debt text scan
- Recommended priority: finish the remaining strict design-cell parity drift before closing the TUI visual replacement goal
