# Persona: Returning User

## Task
Come back after a week. Find a previous session, reuse a recent prompt from history, detect what changed since last use. Probes: `/resume`, `/sessions`, `/history`, `/rewind`, `/status`, `/release-notes`, `/version`, `agenc -c`, `agenc --resume <id>`, Up-arrow recall, `agenc agent list`, on-disk session storage.

## Outcome
Mixed-to-broken. Past work is discoverable through the `/resume` picker and `agenc agent list`, but every actual continuation path is dead. **`agenc -c` and `agenc --resume <id>` both fail with `session not found`** for ids the picker just listed. **Prompt-history recall via Up-arrow does not exist.** **`/status` and `/version` crash** every time. The "what changed" surface (`/release-notes`) is the single bright spot.

## Friction log

- **CRITICAL / `agenc --resume <id>`** / `agenc: session not found: <id>` for every id the picker advertises (screen.log L20, L26, L32; tested 4 ids). Rollout file exists at `~/.agenc/projects/home-...-f932f164/sessions/<id>/` (L114-115). / **Expected**: opens the prior session. **Repro**: `script -q -c 'agenc --resume conv-mp02d6ni' /tmp/x.log`. **Fix**: resume lookup reads the legacy `~/.agenc/projects/-home-...` slug; sessions are written to the hashed `home-...-f932f164/sessions/` slug. Unify the two project-key schemes.

- **CRITICAL / `agenc -c` (continue latest)** / Errors `agenc: session not found: conv-mp02dd6u` (L8, L14). Latest-session pointer is stuck on a stale id. / **Expected**: opens most recent session. **Fix**: when the recorded "latest" id is missing, fall back to the next valid rollout; same slug mismatch as above.

- **CRITICAL / `/resume` picker docstring lies** / Picker ends with `Resume with: agenc --resume <sessionId>` (L3) but that command does not work for any listed id. Picker lists ids, exits, dumps user back to shell with no working resume path. / **Fix**: make the picker launch the chosen session on Enter (it is a list, not a picker today), and fix the `--resume` lookup.

- **HIGH / `/history` resolves to `/clear`** / Prints `Session cleared.` (L43). A returning user typing `/history` to recall prior prompts silently destroys the active session. / **Fix**: register `/history` as a real history viewer or a no-op; never prefix-match the destructive `/clear`.

- **HIGH / `/status` crash** / `Error: Cannot read properties of undefined (reading 'unsafePeek')` (L53). The most natural command for a returning user is broken. / **Fix**: null-guard the peek call.

- **HIGH / `/version` crash** / Resolves to `/status` via prefix-match and inherits the `unsafePeek` crash (L63). / **Fix**: register `/version` as a real command.

- **HIGH / No prompt history recall** / Up-arrow on empty composer does nothing (L64); after typing and backspacing, still nothing (L69). Composer has no history navigation, in-session or cross-session. / **Expected**: bash/readline norm — Up cycles previous prompts. **Fix**: wire composer Up/Down to per-project rollout-derived prompt history.

- **MEDIUM / `agent list` always says `running`** / Every row shows `running` regardless of state (L77-90). / **Fix**: persist terminal status when a session ends.

- **MEDIUM / Two project-key schemes on disk** / `~/.agenc/projects/-home-tetsuo-git-AgenC-agenc-core/` (sparse, `session-memory` only) AND `~/.agenc/projects/home-tetsuo-git-AgenC-agenc-core-f932f164/sessions/` (real rollouts) coexist. Picker uses the new one; resume uses the old. (L94-115). / **Fix**: migrate to one hashed-slug scheme.

- **LOW / `Found 4 keybinding errors · /doctor for details`** / Shown on every TUI launch (L3+). / **Fix**: scope or auto-prune.

- **LOW / `/resume` picker shows `(no preview)` for most rows** / 6 of 8 listed sessions are unidentifiable (L3). / **Fix**: persist first-prompt at session creation.

## Discoverability score: 2/5
`/resume`, `agenc agent list`, `/release-notes` exist and reach. But `/history` is destructive, `/status` and `/version` crash, no Up-arrow recall.

## Latency feel: 3/5
TUI startup ~2-3s. `/resume` picker is fast. `/release-notes` shows a "Geolocating..." spinner before changelog (L54 — odd label for a local file). `agenc -c` exits in <1s with the bogus error.

## Error message quality: 2/5
- `session not found: <id>` is misleading — the rollout exists, the resolver can't find it.
- `Cannot read properties of undefined (reading 'unsafePeek')` is a raw JS stacktrace leaking to the user.
- No error suggests `/release-notes` or `agenc agent list` as fallbacks.

## Notable surprises
- Picker docstring "Resume with: agenc --resume <sessionId>" is documentation that **lies**: the cited CLI command never succeeds. Worse than no docs.
- `/history` deleting your session is a footgun a returning user hits in 30 seconds.
- `/release-notes` works and shows real changelog (Unreleased + 0.1.0), but is undiscoverable — not surfaced from /help-equivalent or `--version`.
- `agenc agent list` is the only working "find my prior work" surface; it belongs in the slash menu (it isn't).
- Environmental note: `~/.agenc/config.toml` was reported TOML-invalid by parallel one-shots even though the file inspected clean — likely concurrent rewrites by other testers. Daemon-shared-state concern, not this persona's bug.
