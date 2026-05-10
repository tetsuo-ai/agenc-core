# UX testing findings — deduplicated

10 personas drove `agenc 0.2.0` (HEAD `6ace5164`) under `script(1)` with timed input. Every entry below cites at least one persona transcript under `tests/ux/runs/`. Personas that hit each issue are listed in `[brackets]`. Sorted by severity, then persona count, then earliest position in user journey.

Keys: **FC** first-contact, **PC** power-chainer, **PB** paste-bomber, **NT** narrow-terminal, **WT** wide-terminal, **TC** tab-completer, **ER** error-recoverer, **IR** interrupter, **MI** memory-injection, **RU** returning-user.

---

## Blockers

### B1. Slash commands crash with raw `unsafePeek` JS exception — `[WT, ER, NT, FC, RU]`
Five distinct slash commands hit the same root: `/status`, `/usage`, `/effort`, `/model`, `/version`. Each renders `Error: Cannot read properties of undefined (reading 'unsafePeek')` in a red user-facing box. Repro: any of those + Enter. Citations: `wide-terminal-screen.log:70`, `error-recoverer-screen.log:8-13`, `narrow-terminal-screen.log:23,97,122`, `first-contact-screen.log` Run 5, `returning-user-screen.log:53,63`.

The error pattern points to a single shared accessor (`<store>.unsafePeek()`) being invoked when `<store>` is `undefined`. One nil-guard at the shared call site fixes all five commands. Wherever the underlying store/conversation/session-state object is built — likely in the slash-command session shim (the same area touched by B5 below) — adding a defensive existence check converts the crash to an empty-state panel like `/cache-stats` already does.

### B2. `/help` returns the literal string "registry pending" — `[WT, ER, NT, FC]`
The first command a new user types renders a panel whose entire body is `registry pending`. The picker tooltip on `/` correctly says "Show help and available commands", so the registry exists somewhere — but `/help`'s handler isn't wired to it. `/help <topic>` (e.g. `/help nonsense`) shows the same string with no error or suggestion path.

Fix: wire `/help`'s slash handler to the same registry that powers the `/` picker. Likely lives near `runtime/src/commands/help.ts` or wherever `helpCommand` is registered in `commands/registry.ts`. If the backend really isn't ready, render an empty-state with command list rather than internal state text.

### B3. `agenc --resume <id>` and `agenc -c` fail for every session the picker lists — `[RU]`
`/resume` opens a picker, advertises `Resume with: agenc --resume <sessionId>` in its body, lists 8 sessions with rollout filenames. Every one of those ids returns `agenc: session not found: <id>` when fed to `--resume`. `agenc -c` (continue latest) is permanently stuck on a stale id and exits 1 every time. Repro: `agenc -c` from any cwd, or `agenc --resume <any-id-from-picker>`. Citations: `returning-user-screen.log:8,14,20,26,32,114-115`.

Root cause is two parallel project-key schemes coexisting under `~/.agenc/projects/`: the legacy unhashed slug `-home-tetsuo-git-AgenC-agenc-core/` and the hashed slug `home-tetsuo-git-AgenC-agenc-core-f932f164/sessions/`. The picker reads the hashed scheme (where rollouts actually land); resume looks up the unhashed scheme. The entire returning-user path is dead until they're unified.

### B4. `/context` crashes with `newDefaultTurnWithSubId is not a function` — `[PC]`
Distinct from B1's `unsafePeek` family. `/context` invokes `ctx.session.newDefaultTurnWithSubId(...)` where `ctx.session` lacks that method. Likely the same slash-command session shim B1 lives in — but a different missing API. Fix the shim to expose the renamed method, or fall back to a read-only context summary that doesn't require allocating a new turn.

---

## Major

### M1. "Found 4 keybinding errors · /doctor for details" banner on every cold launch — `[FC, PC, PB, NT, WT, TC, ER, IR, MI, RU — 10/10]`
Every persona, every cold start, every screen. `/doctor` reveals the four "errors" are duplicated reservations: `ctrl+c` and `ctrl+d` each declared twice (once per context that uses them) and the validator flags them as reserved/hardcoded. The shipped default `keybindings.json` triggers its own warning. Citations: `narrow-terminal-screen.log:132-141`, `power-chainer-doctor.log` keybindings section, `tab-completer-screen.log:88`.

This is the most-confirmed bug in the entire report and it's also the cheapest fix: dedupe the registrations in `runtime/src/tui/keybindings/defaultBindings.ts`, OR demote the validator from `error` to `info` when the entry matches its own hardcoded action.

### M2. Ctrl-C does not cancel in-flight work + Esc is a lie — `[IR, PC, FC]`
Footer hint says "esc to interrupt". Esc has no observable effect during streaming or tool calls. Ctrl-C's "Press Ctrl-C again to exit" warning fires, but a second Ctrl-C neither cancels the in-flight turn nor exits — it just re-arms. Multi-paragraph essays stream to completion; `sleep 60` runs to completion; the model is even told `write_stdin yield_tim_ms 55000` AFTER both Ctrl-Cs. Citations: `interrupter-keys.log:5,8,26,35`.

The fix has two halves: (a) honor Esc as documented (or correct the footer); (b) during a busy turn, treat the first Ctrl-C as cancel-turn and reset the exit counter. The cancel must SIGTERM child tool processes — currently long Bash tool calls cannot be killed at all.

### M3. Daemon agents leak: `agent list` always reports `running` — `[IR, RU]`
Every aborted TUI session leaves a daemon-side conversation in `running` state forever. Returning user observed every row in `agent list` showing `running` regardless of whether the conversation finished or was aborted. Interrupter cleaned up two zombies they created (`conv-mp02f93v`, `conv-mp02ekrl`) but counted 12+ left over from sibling personas. Citations: `interrupter-report.md` finding 5, `returning-user-screen.log:77-90`.

The earlier runner→lifecycle terminal-status hook (commit `7d23df5a`) wired `#cleanupWhenComplete` → `handleRunnerTerminated`, but the live-path observation here suggests it isn't firing on the paths these personas exercised — most likely because the root agent thread never reaches a "completed" status (it's designed to stay alive across user turns) and `awaitTerminalStatus` never resolves. The CLI-disconnect → ephemeral-agent-stop wiring (the deferred follow-up to that commit) is what's actually missing.

### M4. `/history` resolves to `/clear` via prefix-match — silently wipes session — `[RU]`
A returning user typing `/history` to recall prior prompts gets `Session cleared.` (`returning-user-screen.log:43`). The slash dispatcher prefix-matches on a destructive command. Fix: register `/history` as a real history viewer or as an explicit no-op; in any case, never resolve an unknown command to a destructive one. The same prefix-match logic also resolves `/version` → `/status` (inheriting B1's crash).

### M5. `/buddy` falsely claims "requires the interactive TUI command surface" while in TUI — `[NT]`
Inside `agenc --yolo` (the interactive TUI), `/buddy` rejects itself with `{"kind":"error","message":"/buddy requires the interactive TUI command surface."}`. The TUI-detection check is misidentifying its own host. Citation: `narrow-terminal-screen.log:66-70`.

### M6. No "what is AgenC?" surface anywhere — `[FC]`
Cold launch shows composer, prompt rune, `? for shortcuts`. The `?` overlay teaches keystrokes (`! for bash`, `/ for commands`, `@ for files`, `& for background`, `/btw`) but never says what AgenC is. A new user typing `what is this tool?` got an answer about an internal AgenC tool (SendUserMessage), not the product. Fix: a 2-3 line zero-state hint above the composer until the first message is sent, plus a system-prompt anchor for the introduction turn.

### M7. Up-arrow does not recall prior prompts; Ctrl+R "Search prompts" claims "No history yet" — `[PC, RU, FC]`
Two history affordances both empty. Up arrow on empty composer is a no-op (`returning-user-screen.log:64,69`, `power-chainer-history2.log`). Ctrl+R opens a "Search prompts" picker labelled `Filter history…` that says "No history yet" right after submitting a prompt in the same session (`power-chainer-ctrlr.log`). Power users and returning users both bounce off here. Fix: bind Up to history:prev when composer empty/cursor on top line; persist current-session prompts to the same store the picker reads, with in-memory fallback when the store is empty.

### M8. Auto-memory writeback is broken — agent claims to remember but nothing persists — `[MI]`
`/memory` shows `Auto-memory: on` (default). User says "Remember: I prefer pnpm over npm." Agent verbally acknowledges: "Got it. I'll keep in mind that you prefer pnpm over npm." But `~/.agenc/memory/entries/` is empty, `~/.agenc/AGENC.md` does not exist, and `memory.db` mtime is from 2026-04-29 — untouched by the test session. The user is told an action happened that didn't. Citation: `memory-injection-report.md` finding 1.

This is a half-built surface, not a missing one — the directory tree, db schema, and toggle UI all exist. The writeback path doesn't fire. Either implement it or change the affirmation to "I'll keep that in mind for this session."

### M9. No injection-detection signal in the TUI — `[MI]`
Six injection payloads sent (`ignore previous instructions`, `<system>...DAN...</system>`, `[INST]...[/INST]`, base64 `aWdub3JlIGFsbCBwcmlvciBpbnN0cnVjdGlvbnM=`, `rm -rf` in markdown TODO, role-play). All six refused at the model layer. Zero surfaced as injection by the TUI. No banner, no chip, no transcript marker, no "kept N of M tokens" indicator. The base64 payload was decoded and named by the model itself ("it says 'ignore all prior instructions' in base64") but the TUI gives this zero visual emphasis. From a security UX standpoint, "no error" is the bug: the user has no idea whether the runtime stripped, sanitized, or just forwarded the payload. Either surface a scanner result in the message envelope, or document explicitly that there is no scanner.

### M10. Bare Tab is a no-op outside @-picker; mid-cursor Tab is broken — `[TC]`
`?` help mentions `@ for file paths` and `shift+tab to auto-accept`, implying Tab is bound. Typed `runtime/sr` + `\t` outside the picker: nothing happens. Mid-cursor Tab is worse — `@runtime/srhelp/types.ts` with cursor moved 12 left, then Tab: input becomes `@runtime/srhelp/types.ts e`, picker closed, stray `e` two cells right. Repro: `tab-completer-screen.log:73,78`. Fix: bind Tab to "promote current word to @-mention" outside the picker; reopen the picker scoped to the substring-before-cursor when mid-cursor Tab fires inside an `@`-token.

### M11. `/memory` is a file-editing launcher, not a memory manager — `[MI]`
Five options (`~/git/AgenC/AGENTS.md`, `Project memory ./AGENTS.md`, `User memory ~/.agenc/AGENC.md`, `Open auto-memory folder`, `Open team memory folder`). Each opens an editor or folder. No in-TUI list of recorded entries, no audit log, no per-entry revoke control. To audit "what does AgenC remember about me", the user has to leave the TUI for the filesystem.

---

## Medium

### MD1. Wide width (220 cols) detected but not used by the layout — `[WT]`
TUI draws full-width 220-col borders, but every popover (`/help`, `/permissions`, `/files`, `/diff`, `/cache-stats`) renders content collapsed in the upper-left ~30 cols, leaving the right ~190 cols blank. No side-by-side, no two-column kv layout, no expanded view at any width. Particularly painful for `/diff`, where side-by-side is the canonical wide-width win. Fix: cap card width at `min(120, cols-8)` and center for small content; engage two-pane diff when `cols >= 160`.

### MD2. Slash menu descriptions truncate at ~46 cols at narrow widths — `[NT]`
Examples (all from `narrow-terminal-screen.log:7,34,57,122`): "Create a branch of the current conversation at th…", "Show uncommitted changes (git diff HEAD + untrack…", "Copy the latest message or transcript text to the…". Fix: shorten descriptions to ≤45 chars in their metadata, or wrap into a second line when COLUMNS<100.

### MD3. `/keybindings` shells out to nano full-screen with no warning — `[NT, WT]`
Spawns `$EDITOR` (defaults to nano) over the entire viewport, replaces the TUI without confirmation, returns on exit. At 80x24 this is jarring; at 220 the editor inherits the wide pty and bleeds chrome (line lengths up to 1134 chars in the captured frame). Fix: prompt `Open ~/.agenc/keybindings.json in $EDITOR? [y/N]` first; offer a native in-TUI viewer at width.

### MD4. Streaming tool-call argument previews mangle (overprint without line clear) — `[PB]`
When the model emits a `Write` tool call whose JSON args stream in over time, the same in-flight call renders four times in succession with progressively-different filenames, each redraw overwriting the prior at column boundaries without a full line clear. State leaks between updates. Citation: `paste-bomber-screen-small.log:1-3`. Fix: throttle/debounce streaming arg previews, or full-line clear between updates.

### MD5. Default tab browse hides files-with-spaces, hidden files, broken symlinks — `[TC]`
`@tests/ux/_uxfix/` shows `a/`, `bigdir/`, `日本語/`, `émoji/` — but NOT `with spaces/`, `.hidden/`, or `broken` symlink. They surface only when typed. Hiding dotfiles is defensible; silently dropping a spaced name is not. Citation: `tab-completer-screen.log:33,38,43,48`.

### MD6. Slash-picker is fuzzy, not prefix-first — `[TC, FC]`
Typing `@runtime/sr` returns `runtime/src/`, `runtime/src/memory/`, `runtime/src/memdir/`, `runtime/src/mcp/`, `runtime/src/llm/` — none start with `sr` after `runtime/`. A git/IDE user expects `sr<Tab>` to disambiguate to `src/` alone. Slash picker has the same shape and no arrow-key navigation. Fix: rank strict-prefix matches above subsequence matches; wire arrow keys for navigation.

### MD7. Ctrl-C while typing silently destroys composer draft AND arms exit-warning — `[IR]`
With composer text typed, Ctrl-C clears it AND fires "Press Ctrl-C again to exit". One more press = unintentional exit + lost work. Fix: when composer has text, Ctrl-C clears buffer only; arm exit-warning only when a subsequent Ctrl-C lands on an empty composer.

### MD8. Ctrl-Z silently eaten — `[IR]`
No suspend, no error, no documentation. Eating SIGTSTP silently breaks a long-standing terminal contract. Fix: implement suspend, or at minimum surface a "(Ctrl-Z not supported)" hint.

### MD9. Corrupt config emits parse error 5x with no "using defaults" notice — `[ER]`
TOML parse error message text is good, but it fires from two code paths × three load passes = 5 emissions, then runtime silently continues with built-in defaults. Citation: `error-recoverer-screen.log:85-89`. Fix: dedupe the warning, add an explicit "Falling back to defaults" line.

### MD10. `@`-mention to missing path sends verbatim to model — `[ER]`
TUI sends `@/does/not/exist.md explain this` to the model unchanged; only the model's own polite reply tells the user the file was missing. Fix: resolve `@`-paths in the composer; flag missing ones inline before submit.

### MD11. `/   ` (slash + only whitespace) auto-completes to `/agents` and submits silently — `[ER]`
No "empty command" feedback. Fix: trim composer input; short-circuit submit when trimmed command is empty.

### MD12. Ctrl-D contract is undocumented and timing-sensitive — `[IR]`
The only clean exit path is double-Ctrl-D within ~500ms on an empty composer. Single Ctrl-D shows a warning but no countdown. Non-empty Ctrl-D is a silent no-op. Fix: footer countdown like Ctrl-C handling; visible cursor flash on non-empty Ctrl-D.

### MD13. `Ctrl+T` advertised as "toggle tasks" in `?` overlay but inert — `[PC]`
Citation: `power-chainer-ctrlt.log`. Fix: wire it, or remove the line from `?`.

### MD14. `ls -la` rendered as 2-column markdown table with model-invented per-row prose — `[PC]`
Asked to list cwd, agent rendered "Path | Description" with editorialized descriptions and dropped real entries (`package.json`, `runtime/`, `scripts/`, `node_modules/`). More a model/system-prompt issue than a TUI bug, but it's the user-visible failure of a basic prompt. Fix: when a tool result is a directory listing, render flat list, not editorialized table.

### MD15. Two project-key schemes coexist under `~/.agenc/projects/` — `[RU]`
Root cause of B3. Sparse legacy `-home-...` slug + hashed `home-...-f932f164/sessions/` slug. Picker uses the new one; resume uses the old. Migrate to one.

### MD16. `/resume` picker is read-only, not selectable — `[RU]`
Lists sessions; pressing Enter on a row exits the TUI. The picker is a list, not a picker. Fix: make Enter launch the chosen session.

---

## Low / nits

- **L1. Paste placeholder counts newlines, not lines — off by one** `[PB]`. 50-line paste shows `+49`. Fix: `splitlines().length` or `+1` when no trailing newline.
- **L2. Unknown slash command renders raw JSON envelope** `[ER]`: `{"kind":"error","message":"Unknown command: ..."}`. Render `message` field as plain inline error.
- **L3. `bigdir/` listing skips `file001.txt`** `[TC]`. Off-by-one in visible-N ranker hides the highlighted entry.
- **L4. Symlink outside cwd silently falls through to repo-wide fuzzy** `[TC]`. No "no matches under <symlink>" state.
- **L5. Spinner verbs are uninformative (`Decrypting…`, `Heap-walking…`, `Spoofing…`)** `[PC]`. Power users want concrete state.
- **L6. `/cost` is a placeholder ("Cost tracking not enabled")** sitting in the slash menu like a first-class feature `[PC]`.
- **L7. `/release-notes` shows "Geolocating…" spinner before changelog** `[RU]`. Wrong label for a local file.
- **L8. `/resume` picker shows `(no preview)` for most rows** `[RU]`. Persist first-prompt at session creation.
- **L9. 200-char prompt input has no ruler / char-count indicator at width** `[WT, NT]`.
- **L10. Help overlay (`?`) packs three columns of shortcuts that visually crowd at 80 cols** `[NT]`.
- **L11. `/diff` lead-in spinner overlaps the bottom border before settling** `[NT]`.
- **L12. Tab in @-picker confirms-and-reopens, producing trailing `//`** `[TC]` (`tab-completer-screen.log:93`).
- **L13. BPM markers vs heuristic-fold path indistinguishable from outside** `[PB]`. Log which path fired.
- **L14. `/skills` description "Show loaded skills and effective plugin skill roo[t]" is truncated** `[MI]`.
