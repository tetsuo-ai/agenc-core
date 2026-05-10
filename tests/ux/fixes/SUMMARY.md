# UX issue fixes

Branch: `fix/ux-issues` (off `main`).

## Fixed

| ID | Persona reach | Commit | Verified |
|---|---|---|---|
| **M1** "Found 4 keybinding errors" banner | 10/10 | `60acb5a4` | banner line absent in cold-launch screen.log |
| **B1** `unsafePeek` family across 5 commands | 5/10, 5 cmds | `8f0307cd` | `/status`, `/usage`, `/effort`, `/model` all render panels with no `Cannot read properties of undefined` line |
| **B2** `/help` returns "registry pending" | 4/10 | `74f14752` | full command list renders in panel |
| **B4** `/context` crash with `newDefaultTurnWithSubId` | 1/10 | `3afca4f6` | renders friendly "requires the in-process runtime" message |
| **M4** `/history` silently runs `/clear` | 1/10 | `baefea2f` | typing `/history` + Enter completes input to `/clear` but does not execute |
| **M7** Up-arrow / Ctrl+R history empty | 3/10 | `bb7405fc` | submitted prompts now land in `~/.agenc/history.jsonl` |

## How each was fixed

### M1 — keybinding banner
Two changes:
1. `tui/keybindings/validate.ts` — `validateBindings` now filters out user bindings whose `(context, key, action)` exactly matches the runtime default in `defaultBindings.ts`. Echoes-of-default are not real rebinds and shouldn't trip the "reserved" warning.
2. `commands/keybindings.ts` — removed `ctrl+c`/`ctrl+d` entries from the scaffolded `~/.agenc/keybindings.json`. They are NON_REBINDABLE and the runtime defaults handle them unconditionally.

Plus orphan `RemoteAgentTask` import in `src/tasks.ts` removed (residual from earlier donor-purge sweep).

### B1 — `unsafePeek` family
Each affected command (`/status`, `/usage`, `/effort`, `/model`) was reading `session.state.unsafePeek()` directly. The TUI's `AgenCBridgeSession` (daemon client; `tui/session-types.ts:36`) doesn't expose `state`. Added defensive accessor pattern:

```ts
const peekState = (session as unknown as { state?: { unsafePeek?: () => unknown } }).state?.unsafePeek;
const stateObj = typeof peekState === "function"
  ? peekState.call((session as unknown as { state?: unknown }).state) as ...
  : null;
```

For commands that need session config: fall back to `session.sessionConfiguration` carried directly on the bridge session. For mutator paths in `/effort`: refuse with "Reasoning-effort changes from the TUI are not supported when running against the daemon" instead of taking a non-existent state lock.

Files: `commands/{status,effort,model,cache-stats}.ts`. The `cache-stats` change covers `/usage` (which uses `readTokenUsageSummary`).

### B2 — `/help`
The TUI dispatch path (`App.tsx`) builds a fresh registry per-call and passes it through `ctx.commandRegistry`. It never calls `setGlobalCommandRegistry`, so `helpCommand.execute` hit the "registry pending" placeholder.

`commands/help.ts`: prefer `ctx.commandRegistry` over the global slot. Fall back to global, only emit placeholder when neither is available.

### B4 — `/context`
`/context` and `/compact` both called `ctx.session.newDefaultTurnWithSubId(...)` without guarding. Bridge sessions don't expose that method, so dispatch crashed with the raw JS error.

`commands/session-compact.ts`: extracted `tryAllocateTurnContext` helper that checks for the in-process methods and returns a typed result. Both commands return "This command requires the in-process runtime and is not yet supported when the TUI is running against the daemon" instead of leaking the JS error.

### M4 — `/history` → `/clear` footgun
`useTypeahead.handleEnter` unconditionally executed the highlighted command suggestion. Typing `/history` (no real command) + Enter → `/clear` was the top fuzzy hit (its description contains "history") → silent destructive run.

`tui/hooks/useTypeahead.tsx`: only auto-execute when the typed input (lowercased, stripped of leading `/`) matches the suggestion's name or one of its aliases. Otherwise still apply the suggestion to the composer (so Tab-style completion works) but skip the run. Also exported `isCommandMetadata` from `utils/suggestions/commandSuggestions.ts`.

### M7 — history not persisted
`tui/screens/REPL.tsx` (legacy moved-source) calls `addToHistory` on submit. The live mount path (`AgenCTuiApp` → `submit()` in `App.tsx`) didn't. Added the same call in `App.tsx submit()`. Verified entries land in `~/.agenc/history.jsonl` with project + sessionId.

## Deferred

| ID | Reason |
|---|---|
| **B3** resume path dead | Two project-key schemes coexist on disk (`-home-...` legacy vs `home-...-f932f164` hashed). Picker reads the new path; resume reads the old. Real architecture work — needs migration path for existing rollouts plus unification on one slug. Not minimal-wiring. |
| **M2** Ctrl-C never cancels | TextInput's raw `useInput` exit-warning intercepts the keystroke before keybinding resolution can route it to `CancelRequestHandler`. The cancel-active-turn RPC IS wired (`tui/daemon-session.ts:323`), the keybinding handler IS registered (`useCancelRequest.ts:219`), but the chord doesn't reach the resolver. Fixing this requires changing input handler priority, which is architectural rather than wiring. |
| **M3** daemon agents leak | Partly addressed in earlier merge `7d23df5a` (runner→lifecycle terminal-status hook). The remaining gap — CLI disconnect should stop ephemeral one-shot agents — needs an `ephemeral?: boolean` field on `AgentCreateParams` plus client-id ownership tracking. Real protocol work. |
| **M5** `/buddy` "requires interactive TUI" | After M4's exact-match fix the panel error case may already be unreachable from the typed-name path — repro under script(1) shows the legacy-spec lookup catches `/buddy` and `executeLegacyCommandSurfaceForTui` runs with `tuiHandlers` defined. Persona may have hit a corner I can't reproduce now. Not a clear minimum fix. |
| **M6** no "what is AgenC?" surface | UX content addition. Not wiring existing code — new copy in the composer empty-state. |
| **M8** auto-memory writeback broken | The agent says "I'll remember" but `~/.agenc/memory/entries/` stays empty. The directory + db schema exist; the writeback path doesn't fire. That's a real implementation, not wiring. |
| **M9** no injection-detection signal | No scanner exists in the runtime today. Can't wire what isn't there. |
| **M10** bare Tab no-op outside `@`-picker | Real autocomplete behavior change. The `@`-picker handles its own completion correctly; promoting unprefixed text to an `@`-mention on Tab is new behavior, not wired-but-disabled. |
| **M11** `/memory` is file-editing launcher | The TUI lists the memory files in five edit-folder/edit-file shortcuts. Adding an in-TUI list/audit/revoke surface backed by `memory.db` is real implementation, not wiring. |

The deferred items are real product work. None of them is "wired-but-broken existing code" — searches confirmed each.

## Repo state

11 commits on `fix/ux-issues`. Build green, daemon healthy, TUI startup smoke passes, no source still references the donor-purged paths. No remote pushes.
