## Tech Debt Report - 2026-05-17

Scope: TUI design replacement WIP, changed tracked files, and untracked files
created for this goal. Subagents were not used because this environment only
allows delegation when explicitly requested by the user.

### Critical (Fix Now)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| None found in this scan. | n/a | n/a | n/a |

### High (Fix This Sprint)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Live design URL still cannot be fetched in this environment. | `goal.md`; `runtime/src/tui/README.md` | The implementation is validated against the local bundle snapshot, not a newly fetched remote copy. | Re-run the fetch with credentials/scopes that can access the design endpoint, then compare bundle hash and regenerate fixtures if the source changed. |

### Medium (Backlog)

| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
| Source-backed design smoke scaffold is very large. | `runtime/src/tui/components/v2/designStateSmoke.test.tsx`; `runtime/src/tui/components/v2/designBrowserTextFixture.ts` | The parity net is useful, but future review/edit cycles are heavier because generated fixture data and test logic live together. | Split extraction helpers and generated fixtures into smaller modules after the visual replacement lands. |
| v2 primitive module is broad. | `runtime/src/tui/components/v2/primitives.tsx` | Many core visual atoms live in one file; unrelated future edits can conflict. | Once stable, split frame chrome, menus, message primitives, and approval primitives along existing exports. |
| Existing stale-signature FIXME markers remain outside the TUI visual layer. | `runtime/src/utils/swarm/inProcessRunner.ts` | Not introduced by this visual work, but still visible in changed-file debt scan. | Track separately with the swarm/compact conversation owner; do not fold it into the TUI visual replacement. |

### Duplications Found

| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
| No new actionable exact duplicate blocks found in the changed TUI visual layer during this scan. | n/a | n/a | n/a |

### Validation Notes

- `git diff --check` passed.
- `node scripts/branding-scan.mjs --changed` passed: 79 files scanned clean.
- Touched-file marker scan found no new critical TODO/FIXME/HACK debt in the TUI visual layer. Existing hits are stale-signature swarm FIXME notes, retained bash-permission fallback names, permission vocabulary strings, and `TODO.MD` test fixtures.
- `cd runtime && npm run typecheck` passed.
- `cd runtime && AGENC_TUI_DESIGN_HTML='/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html' npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot` passed: 103 tests.
- `cd runtime && AGENC_TUI_DESIGN_HTML='/tmp/agenc-tui-handoff/agenc-tui/project/AgenC TUI.html' AGENC_TUI_DESIGN_BROWSER=1 npx vitest run src/tui/components/v2/designStateSmoke.test.tsx --reporter=dot` passed: 103 tests with live browser extraction from the local design HTML.
- `node /home/tetsuo/.agenc/skills/agenc-tui-validate/scripts/run-tui-validate.mjs --repo /home/tetsuo/git/AgenC/agenc-core --full` passed: rebuild, artifact import, PTY startup at 148x40/120x30/80x24, footer parity, core parity, and yolo parity.

### Summary

- Total issues: 3 tracked follow-ups, 0 critical.
- Estimated cleanup: 3 files or modules, plus one credential/provenance recheck.
- Recommended priority: obtain valid access to the live design URL and re-run the source snapshot check before marking the larger goal complete.
