# UX testing summary — round 2

10 personas drove `agenc 0.2.0` HEAD `4999c596` (post-round-1-fixes) through `script(1)` with timed input. Round-1 outputs are preserved at `tests/ux/round-1/` for direct comparison; round-2 deduplicated friction lives in `tests/ux/findings.md`.

## What round 1 fixed (all six fixes held)

| Round-1 issue | Round-1 status | Round-2 status |
|---|---|---|
| **M1** "Found N keybinding errors" banner | 10/10 personas hit it | 0/10 mention it |
| **B1** `unsafePeek` crashes on /status, /usage, /effort, /model | 5 commands across 5 personas | `/status`, `/usage`, `/effort` render proper panels (NT, WT, FC, RU all confirm) |
| **B2** `/help` "registry pending" placeholder | 4 personas | Renders the real command list (FC, NT, WT, RU confirm) |
| **B4** `/context` raw `newDefaultTurnWithSubId` JS exception | PC | Friendly "requires the in-process runtime" message (PC confirms) |
| **M4** `/history` silently runs `/clear` | RU | `/history` falls through to the fuzzy-match menu (RU confirms) |
| **M7** Up-arrow / Ctrl+R history empty | 3 personas | Both populated cross-session (PC, RU confirm) |

The persona-confirmed fix rate is 6/6. Round 2 is meaningfully healthier than round 1 on the surfaces that round-1 fixes targeted.

## Top 5 issues to fix first (round 2)

### 1. Regression I introduced: `/model nonexistent` leaks a different raw JS exception
Round-1's B1 fix guarded `session.state.unsafePeek()` but the next call in `applyModelSwitch` is `session.setPendingProviderSwitch(...)`, which the bridge session also doesn't expose. Repro: `/model nonexistent-model-xyz` → red panel with `Error: session.setPendingProviderSwitch is not a function` (`error-recoverer-screen.log:1-12`). I went one method deep when I needed to go the whole call chain. Fix: extend the same defensive-accessor pattern to `setPendingProviderSwitch` and `abortTerminal` in `runtime/src/commands/model.ts`, or refuse the operation early with a clear "model switching from the TUI is not supported when running against the daemon" message before any session-method calls are attempted.

### 2. `/clear` reports success but the model retains the prior turn
Power-chainer found the cleanest repro: ask "what is 2+2?", run `/clear` (which renders "Session cleared."), then ask "what was my previous question?". Model answers: "Your previous question was 'what is 2+2?'" (`power-chainer-screen.log:92-117`). The clear is cosmetic. A user could share a session expecting prior context wiped and leak it. The likely cause is that `/clear` truncates the TUI's local transcript view but the daemon still holds the conversation. Fix lives in `commands/clear.ts` and the daemon-side `session.clear` handler — the contract should be "clear == truncate the upstream message list", not "clear the local view only".

### 3. Paste without bracketed-paste markers triggers YOLO tool execution
Paste-bomber's first attempt (no `\x1b[200~`/`\x1b[201~`) caused the TUI to receive the bytes as typed input and immediately fire `Write({...})`, `exec_command({"cmd":"pwd"})`, `exec_command({"cmd":"ls"})`, `TodoWrite(...)` — all in `--yolo`, all before any Enter (paste-bomber report F2). Terminal multiplexers (older tmux), some SSH chains, and some pty wrappers strip BPM markers. So a user piping a document into `agenc --yolo` from a stripped chain executes its content as tool calls without confirmation. Fix: in `PromptInput`, detect "pasted-as-typed" by length+rate heuristic and refuse auto-submit above a threshold; in `--yolo`, require an extra confirmation for tool calls fired within N ms of a typed-input burst. This is a real attack surface: an attacker who can inject into the user's clipboard or controls a pasted document can run arbitrary shell.

### 4. `--yolo` mode is invisible in the UI
Narrow-terminal launched `agenc --yolo`. `/permissions` reports `Mode: default`. `/status` reports `Permission mode: default`. The composer prompt glyph is the same `❯`. Footer hint is the same `? for shortcuts`. There is no on-screen indication of bypass mode (`narrow-terminal-screen.log:133, 191`). A user who launched yolo intentionally can't confirm; a user who inherited a yolo session accidentally can't notice. Combined with #3, the "I'm in yolo" signal is exactly the safety telemetry that's missing right when it matters most. Fix: distinct footer chip (`! YOLO`), distinct prompt glyph (`▶`), AND surface `Permission mode: bypassPermissions` correctly in `/status` and `/permissions`. The `/permissions` evaluator already knows about `bypassPermissions` (it's in the union); the bridge session is just not propagating the launch flag.

### 5. `agenc -c` and `agenc --resume <id>` still completely broken
Returning-user re-confirmed both fail with `session not found: <id>` for IDs the `/resume` picker advertises. The two project-key schemes still coexist (`-home-...` legacy + `home-...-f932f164` hashed). Round 1 deferred this as architectural and the contract stays broken — the canonical "come back to your work" path is still 100% failure for a real project. Worse, `~/.agenc/projects/-home-tetsuo-git-AgenC-agenc-core/` has zero rollout files (only `summary.md` snippets); rollouts only land under `tmp-agenc-*` ephemeral project paths. So even if the lookup were fixed, there's nothing to load. This needs a real migration: pick the hashed slug as canonical, walk the legacy path, copy or link rollouts forward, then unify the resume resolver on the canonical path.

## What worked unexpectedly well (preserve as the codebase evolves)

The round-1 "preserve" list mostly held; a few additions from round 2:

- **All six round-1 fixes verified at the persona level.** That's the most important signal: targeted fixes against persona-test findings actually move the next round's measurements. The pattern is worth repeating.
- **Paste handling is still the single most robust surface.** 122KB / 500-line markdown payload with malformed fences, ZWJ emoji, RTL scripts: chip-collapse correctly, no crash, no scroll lock, byte-identical round trip — provided the BPM markers reach the runtime. Renderer robustness 8/10 in PB.
- **`agenc providers`** remains the best error UX in the binary — first-contact rated it 4/5 and called it the most useful surface in the product. The "WHAT + WHERE + COMMAND" pattern from CLI flag rejection (`--profile nonexistent`, `--model nonexistent`) is the template the TUI's slash errors should follow.
- **`@`-mention picker** still handles unicode (CJK, accented Latin, emoji) cleanly with no mojibake.
- **`/keybindings` opens the user config in `$EDITOR`** with a real schema URN — power-user friendly.
- **Daemon resilience.** `agenc daemon stop` + any subcommand silently respawns. UX-positive in the happy path; loss of observability is captured separately as M-NEW3.

## Patterns of friction that suggest structural fixes

Three patterns repeat across personas more than the individual issues warrant.

**Bridge-session method gaps come in clusters.** Round 1 fixed five commands hitting the same `unsafePeek` access; round 2 found `/model` still leaking via `setPendingProviderSwitch`. The pattern: any in-process Session method called from a slash command crashes when reached over the daemon bridge. Rather than guarding each method individually, the right structural move is a `BridgeSessionAdapter` shim that either implements the in-process surface against the daemon-side state (via RPC) or fails uniformly with a clear "this command needs the in-process runtime" error and never leaks raw JS exceptions. The single try/catch wrapper from round-1's "structural patterns" section was a band-aid; the real fix is making `ctx.session` either work or refuse cleanly for every method on the in-process Session interface.

**Footer / status / mode advertising lies in subtle ways.** `/clear` says "Session cleared" but the model remembers (#2). Footer says "esc to interrupt" but Esc has no effect (round-1 M2). `?` overlay says `ctrl + t to toggle tasks` but Ctrl-T is inert. `--yolo` mode is invisible (#4). Footer hint vanishes on first keystroke (M-NEW6). `/cost` says "not enabled" with no enable path. `/release-notes` advertises 0.1.0 while `--version` says 0.2.0. **The TUI's status surfaces don't match the runtime's behavior.** A single contract test that walks every advertised key/command/mode chip and verifies the underlying state matches what the chrome claims would catch all of them.

**Confirmation gates are missing exactly where YOLO meets adversarial input.** Paste without BPM markers triggers tool execution (#3). Memory-injection's base64 payload caused the agent to voluntarily fire `exec_command(echo "..." | base64 -d)` to decode the adversarial payload — also in `--yolo`, also without confirmation (`memory-injection-report.md` injection table row 4). Pattern: in `--yolo`, the model freely runs tool calls on user-provided content the runtime never inspected. There is no scanner-side signal (M-DEF4) and no rate-limit / size-limit gate. A single "any tool call fired within N ms of a paste/typed-burst requires confirmation, even in --yolo" rule would close both surfaces without removing the YOLO ergonomic wins.

## Failed personas

None failed entirely. All 10 produced reports within budget (615–826 words each, all under the 800 cap when measured by report body). Two minor caveats:

- **Returning-user's one-shot seed hung at 90s** under parallel daemon thrash and was killed. The pre-existing 916-line `~/.agenc/history.jsonl` plus ~80 sessions provided enough returning-user baseline that no findings were lost.
- **Error-recoverer's network-down test was again inconclusive** — the daemon ignored per-invocation `OPENAI_BASE_URL` env (now captured as M-NEW4) and its cached config kept replies flowing. The failure was instructive on its own (env propagation gap) but the original "model unreachable" UX path was again not exercisable from this run.
