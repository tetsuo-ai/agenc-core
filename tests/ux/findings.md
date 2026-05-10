# UX testing findings — round 2 (deduplicated)

10 personas drove `agenc 0.2.0` HEAD `4999c596` (post-fixes) under `script(1)`. Every entry below cites a transcript under `tests/ux/runs/`. Personas in `[brackets]`. Sorted by severity, then persona count, then earliest position in journey.

Persona keys: **FC** first-contact, **PC** power-chainer, **PB** paste-bomber, **NT** narrow-terminal, **WT** wide-terminal, **TC** tab-completer, **ER** error-recoverer, **IR** interrupter, **MI** memory-injection, **RU** returning-user.

Round-1 baseline lived in `tests/ux/round-1/` for direct comparison.

---

## Verified fixes from round 1 (none of these reproduced)

| ID | Round-1 status | Round-2 status |
|---|---|---|
| **M1** "Found 4 keybinding errors" banner on every cold launch | 10/10 personas hit it | 0/10 mention it |
| **B1** `unsafePeek` crashes on `/status`, `/usage`, `/effort`, `/model` | 5/10, 5 commands | `/status`, `/usage`, `/effort` render proper panels (NT, WT, RU all confirm) |
| **B2** `/help` returns "registry pending" | 4/10 | renders the real command list (FC, NT, WT, RU confirm) |
| **B4** `/context` raw `newDefaultTurnWithSubId` JS exception | PC | renders friendly "requires the in-process runtime" message (PC confirms) |
| **M4** `/history` silently runs `/clear` | RU | typing `/history` falls through to the fuzzy-match menu (RU confirms) |
| **M7** Up-arrow / Ctrl+R history empty after submit | PC, RU, FC | Up-arrow + Ctrl+R "Search prompts" both populated cross-session (PC, RU confirm) |

---

## Regression introduced by round-1 work

### R1. `/model nonexistent` now leaks a *different* raw JS exception — `[ER]`
The B1 fix guarded `session.state.unsafePeek()` but the next call in `applyModelSwitch` is `session.setPendingProviderSwitch(...)`, which is also missing on the bridge session. Repro: `/model nonexistent-model-xyz` → red panel with `Error: session.setPendingProviderSwitch is not a function` (`error-recoverer-screen.log:1-12`). Same shape as B1, one method deeper. Fix: extend the same defensive-accessor pattern to `setPendingProviderSwitch` and `abortTerminal` in `runtime/src/commands/model.ts`, OR refuse the operation with a clear "model switching from the TUI is not supported when running against the daemon" message.

---

## Blockers (new in round 2)

### B-NEW1. `/clear` reports success but the model retains prior turn — `[PC]`
After `/clear` rendered "Session cleared." (`power-chainer-screen.log:100`), the very next user turn got: "Your previous question was 'what is 2+2?'" (line 117). The clear is cosmetic. A returning user could share a session expecting the prior context wiped and leak it. Fix: either truncate the upstream message list when `/clear` fires, or rename to `/clear-ui` and document the divergence. Likely lives in `commands/clear.ts` and the daemon's session-state trim path.

### B-NEW2. Paste without bracketed-paste markers triggers YOLO tool execution — `[PB]`
Paste-bomber's first attempt without `\x1b[200~`/`\x1b[201~` markers caused the TUI to receive bytes as typed input and fire `Write({...})`, `exec_command({"cmd":"pwd"})`, `exec_command({"cmd":"ls"})`, `TodoWrite(...)` — all in YOLO, all before any Enter (paste-bomber report F2). With markers, the chip-collapse path triggers and behavior is correct. Risk surface: terminal multiplexers (older tmux), some SSH chains, some pty wrappers strip BPM markers. In `--yolo`, this means an attacker who can inject into the user's clipboard or controls a pasted document can run arbitrary shell. Fix: detect "pasted-as-typed" by length + speed heuristic in PromptInput and refuse auto-execution above a size/speed threshold, OR require an extra confirmation in `--yolo` for any tool call within N ms of a typed-input burst.

### B-NEW3. `agenc -c` and `agenc --resume <id>` still fail — same root as round-1 B3 — `[RU]`
Returning-user re-confirmed: `agenc -c` exits with `session not found: <id>` for the most-recent ID; `agenc --resume <conv-id>` fails for picker-listed IDs. The two project-key schemes still coexist (`-home-...` legacy + `home-...-f932f164` hashed). Round 1 deferred this as architectural; the contract stays broken for returning users. Same fix as round 1: unify the project-key schemes and migrate existing rollouts. `~/.agenc/projects/-home-tetsuo-git-AgenC-agenc-core/` has zero rollout files; rollouts only exist under `tmp-agenc-*` ephemeral project paths, so even if the lookup were fixed there's nothing to load.

---

## Major (new in round 2)

### M-NEW1. `--yolo` mode is invisible in the UI — `[NT]`
Launched `agenc --yolo`. `/permissions` reports `Mode: default` (`narrow-terminal-screen.log:133`). `/status` reports `Permission mode: default` (line 191). The composer prompt glyph is the same `❯`. Footer hint is the same `? for shortcuts`. There is no on-screen indication the user is in bypass mode. A user who launched yolo intentionally has no way to confirm; a user who accidentally inherited a yolo session has no way to notice. Fix: distinct footer chip, distinct prompt glyph, or `Permission mode: bypassPermissions` in `/status`/`/permissions`.

### M-NEW2. `/buddy` rejects itself inside the interactive TUI — `[NT]`
Re-confirmed from round 1's M5 (which I deferred under "couldn't repro"). `/buddy` + Enter renders the raw JSON `{"kind":"error","message":"/buddy requires the interactive TUI command surface."}` (`narrow-terminal-screen.log:240-242`) — from inside `agenc --yolo`. Real bug, not a phantom. Fix: trace the dispatch path the picker takes when the user types `/buddy` and either fix the TUI-detection check used by buddy's command or make the legacy dispatcher always pass `tuiHandlers` when invoked through the App.tsx slash path.

### M-NEW3. Daemon silently auto-respawns on every subcommand, no observability — `[ER]`
`agenc daemon stop` followed by `agenc agent list` or `agenc daemon status` transparently respawns the daemon (`error-recoverer-screen.log:83-87`). No "(daemon was down — restarted)" notice, no `--no-autospawn` flag. UX win: never user-visibly broken. UX gap: no observability of the original failure state. Fix: emit a one-line stderr notice when the auto-respawn fires; offer `--no-autospawn` for scripts that need to detect daemon-down explicitly.

### M-NEW4. `OPENAI_BASE_URL` and similar env overrides silently dropped — `[ER]`
`OPENAI_BASE_URL=http://localhost:1 agenc --no-tui "hi"` produced normal model replies — the daemon ignores per-invocation env and uses its cached config. Even after `daemon stop`, the auto-respawned daemon reads from prior state. Returning user-relevant: a developer expecting "set env, get specific behavior" gets unintended cached behavior instead. Fix: either propagate per-invocation env to the daemon (re-init provider) or document that env is read at daemon-start only.

### M-NEW5. `agenc config validate` exits 0 even when the config is broken — `[ER]`
`agenc config validate` emitted `cannot edit config.toml after skipped config migration (toml:invalid)` AND exited with status 0 (`error-recoverer-screen.log:92-99`). Scripts that depend on `validate` for CI/pre-commit will not catch the failure. The same corrupt config also emits the same parse error **8–10 times** in one invocation (round 1 noted 5; this run is worse). Fix: `validate` must exit non-zero on any reported failure; dedupe parse-error emissions to once per command run.

### M-NEW6. Footer hint vanishes on first keystroke at 80×24 — `[NT]`
Empty composer shows `? for shortcuts` on line 24. One keystroke removes it (`narrow-terminal-screen.log:469-494`). The hint also disappears whenever the slash picker is open. At 80c that line is the only on-screen guidance, so dropping it on first input is the worst time to drop it. Fix: keep the hint visible until a slash command is dispatched or the user sends a real prompt, OR replace it with an even shorter live hint when typing.

### M-NEW7. `/branch` and `/btw` silently no-op when invoked without args — `[NT]`
`/branch` + Enter: composer clears, no overlay, no error, no status (`narrow-terminal-screen.log:495-520`). `/btw` + Enter: identical (`screen.log:157-182`). Both compound with the slash-menu description truncation issue (B-NEW8 below) — at 80c the menu hint is `Ask a quick side question without interrupting th…`, so the user can't even discover from inside the TUI that arguments are required. Fix: render an "argument required" boxed message; widen menu descriptions to wrap or expand on Tab.

### M-NEW8. Slash-menu descriptions still truncated at 80×24 — `[NT, WT]`
Same finding as round-1 MD2: descriptions hard-truncate at ~51 chars with `…`, no expansion. NT and WT both flag this — at 220 cols it's even more painful (the menu uses ~80 chars while ~140 cols sit empty). Fix: widen the description column to `cols-30`, OR show an expanded panel when a row is highlighted.

---

## Major (deferred-as-documented in round 1, still pending)

These were deferred in round 1's `tests/ux/fixes/SUMMARY.md` and remain unchanged in round 2:

### M-DEF1. Ctrl-C never cancels in-flight work; Esc footer hint is a lie — `[IR]`
Round 2 IR re-confirmed all the round-1 specifics: single Ctrl-C only flips the footer to "Press Ctrl-C again to exit"; second Ctrl-C is absorbed by re-renders during streaming; `sleep 60` runs to completion with triple Ctrl-C ignored; Esc has no observable effect (`interrupter-report.md` scenarios 1, 2, 6, 8). Architectural priority change required.

### M-DEF2. Daemon agent zombies on aborted CLI sessions — `[IR, RU]`
Round 1's `agenc agent list` zombies are still listed `running` (`returning-user-report.md`: "agent list reports stale status: running for clearly dead sessions"). IR notes pre-existing zombies from round 1 still present; new agents from concurrent personas show same pattern.

### M-DEF3. Auto-memory writeback never fires — `[MI]`
Re-confirmed: agent says "I'll remember", `~/.agenc/memory/entries/` empty, `~/.agenc/AGENC.md` doesn't exist, `/knowledge` reports `0 goals, 0 milestones, 0 technical facts learned` (`memory-injection-report.md` "Filesystem ground truth"). 

### M-DEF4. No injection-detection signal in TUI — `[MI]`
6 of 6 injection inputs refused at the model layer. 0 of 6 surfaced any TUI scanner badge or filter notice. Pattern is identical to round 1.

### M-DEF5. `/memory` is a file-editing launcher, not a manager — `[MI]`
Same surface as round 1 — five edit-folder/edit-file shortcuts, no in-TUI list/audit/revoke.

### M-DEF6. Bare Tab outside `@`-picker is a no-op — `[TC]`
Same as round-1 M10. Tab is silent in the plain composer (`tab-completer-report.md` F9).

### M-DEF7. No "what is AgenC?" surface on cold launch — `[FC]`
Same as round-1 M6. Cold launch shows only `❯` + `? for shortcuts` (`first-contact-screen.log:2`). The agent itself doesn't know it's AgenC ("In one sentence, what is this tool?" returned "no specific tool has been identified"; another run hallucinated "FileRead").

---

## Medium (new in round 2)

### MD-NEW1. `?` shortcut overlay is misaligned at 80c — `[FC, NT, PC]`
Three personas hit this. NT's analysis is the most precise: 4 columns wrap into 7 rows but visual columns drift — "double tap esc to clear / input" fragmenting across rows, "ctrl + x ctrl + e to edit in" wrapping into a neighboring column without a separator (`narrow-terminal-report.md` B3). FC and PC describe the same thing differently. Fix: lay out shortcuts vertically as KEY | DESCRIPTION rows when `cols < 100`.

### MD-NEW2. `/release-notes` content is stale — `[RU]`
Advertises `[Unreleased]` and `[0.1.0] 2026-02-14` while CLI says `agenc --version` → `0.2.0`. Still references Solana-era `acceptedMints` / `rewardMint` deprecations (`returning-user-report.md` "What's-new surface"). Fix: regenerate or trim CHANGELOG.md to match the actual 0.2.0 ship surface.

### MD-NEW3. `/cost` is a placeholder with no enable hint — `[PC]`
"Cost tracking is not enabled for this session." with no flag, env var, or `/config` pointer (`power-chainer-screen.log:299`). Fix: print the exact env/flag needed, or hide the command when not enabled.

### MD-NEW4. `!` bash mode banner is a lie — `[PC]`
Pressing `!` shows the `!` banner suggesting bash mode is active, but typing `ls package.json` and Enter sent it as a chat prompt with literal `!` appended (model then chose to run `exec_command` itself; `power-chainer-screen.log:190-225`). Fix: bash mode must intercept Enter and bypass model dispatch, or remove the mode if the path doesn't actually shortcut.

### MD-NEW5. `/status` reports `Model: unknown` while config has a real model — `[NT, RU]`
After my B1 fix, `/status` falls back to `unknown` for the model field when the bridge session can't read state directly. RU confirms `agenc config get model` returns `qwen3.6-35b-a3b-fp8` while `/status` shows `Model: unknown`. NT same. The fallback I introduced reads from `session.sessionConfiguration` but provider works there while model doesn't — needs verification of the bridge-session shape. Fix: add `collaborationMode.model` to `tui/session-types.ts` `AgenCBridgeSession.sessionConfiguration` if not already there, or read from the daemon-vended config instead.

### MD-NEW6. `/status` reports synthetic `agenc-tui-idle-XXXXX` SessionID at idle — `[RU]`
Returning user has no way to learn the current session's resume key without sending a message first. Fix: surface the real conv-id once the daemon assigns it, or hide the field at idle.

### MD-NEW7. Tab-completer: typing space inside `@` path silently strips it — `[TC]`
`@/tmp/agenc-completion-test/with spaces/` echoes back as `with spaces/` collapsed to `withspaces/` and switches to unrelated cwd matches (`tab-completer-screen.log:31`). A user with one `my docs/` folder cannot reach it via `@`. Fix: accept spaces inside `@` queries; treat the buffer as one path until whitespace+token.

### MD-NEW8. Tab-completer: result list capped at 5 with no overflow indicator — `[TC]`
200-file `bigdir/` looks identical to a 5-entry directory (`tab-completer-screen.log:67`). Fix: show `+195 more` count or scroll affordance.

### MD-NEW9. Mid-cursor Tab unsupported, emits stray `l` glyph — `[TC]`
Round 1 also flagged the mid-cursor Tab issue but reported a stray `e`; round 2's stray glyph is `l`. Same root: `\x1b[D` (left arrow) is parsed correctly but Tab in the middle of an `@` token doesn't reopen the picker scoped to substring-before-cursor; instead, a final byte of the escape sequence leaks. Fix: handle Tab inside an `@` token as "reopen picker for the segment under cursor"; suppress the stray glyph emit.

---

## Low / nits

- **L1. Stray `[>0q` escape bytes leak to screen on cold launch** under `script(1)` `[FC]`. Terminal-mode query echoed before the renderer claims raw mode. Invisible in modern terminals; visible under `script`.
- **L2. Spinner labels are personality, not status** `[PC, PB]`: `Exfiltrating…`, `Cross-compiling…`, `Transcoding…`, `Multiplexing…`, `Injecting…`. PB notes that "Exfiltrating…" rendered next to a fresh user paste is a tone hazard. Fix: real phase verbs (`thinking`, `tool-call`, `streaming`) or remove.
- **L3. Slash autocomplete shows first 5 commands with no "more below" hint** `[FC]`. Same as round-1 first-contact; no count badge.
- **L4. `/help` lists project-installed skills before built-ins** `[FC]`. New users see a foreign skill catalogue. Fix: prepend a fixed orientation block (built-ins first, then project skills).
- **L5. Two competing footer hints render together** `[FC]`: "? for shortcuts" + "Press Ctrl-C again to exit" instead of one prevailing.
- **L6. Hidden-file visibility inconsistent in `@`-picker** `[TC]`: empty query auto-lists `.agenc/`/`.git/` etc.; explicit `.hi` prefix returns empty.
- **L7. Tab in `@`-picker descends into the top match rather than cycling** `[TC]`: readline/fzf users expect Tab-cycle.
- **L8. Deep paths collapse to one truncated row losing all disambiguating segments** `[TC]`.
- **L9. Broken symlinks listed without health hint** `[TC]`.
- **L10. Exit-warning footer changes mid-quit (`Ctrl-C` then `Ctrl-D`)** `[PB]`. Slight inconsistency.
- **L11. `Pasting text…` toast collides with placeholder chip on first paint** `[PB]`. Layout race; not user-blocking.
- **L12. `/sessions` and `/history` aren't real commands** `[RU]`. Fall through to fuzzy match. Both names are extremely natural guesses for a returning user.
- **L13. `agent list` shows stale `running` for clearly-dead sessions** `[IR, RU]`. Same root as M-DEF2.
- **L14. Single-quote/escape JSON envelope rendered for unknown slash command** `[ER]`. Round-1 finding still present; cosmetic. Should render `message` field as plain inline error.
