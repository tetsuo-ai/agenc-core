# Persona: Power Chainer

## Task
Compose three real ops in one TUI session; probe history recall, piping, saved sequences, shortcut/slash menu. Target: `agenc --yolo` 0.2.0 at HEAD `4999c596`. Three chains: (1) Q&A then `/clear` then memory probe, (2) bash-mode `!` toggle + chat, (3) Q&A then `/context` then `/cost`. Aux: `?` menu, `/keybindings`, Up-arrow recall, `;`. ~8 slash commands invoked: `/help`, `/clear`, `/exit`, `/keybindings`, `/context`, `/cost`, plus `/files` and `/init` (listed in menu).

## Outcome
Discovery surfaces work: `?` shows a shortcut card (screen.log:49) advertising `!`, `@`, `&`, `ctrl+r`, `ctrl+s`, `ctrl+g`, `ctrl+o`, `ctrl+t`, `meta+p`, `shift+tab`, double-esc, `\+⏎` newline, `/keybindings`. Slash menu autocompletes on `/`. Up arrow recalls history (screen.log:168-171 — `world` recalled, `ctrl+r to search history` hinted). `/keybindings` opens nano on `~/.agenc/keybindings.json` (screen.log:250-253) showing Global/Chat/Composer contexts with verbs (`app:redraw`, `history:search`, `scroll:pageUp`). Major regression: `/clear` claims "Session cleared" (screen.log:100) but the model still answers "Your previous question was 'what is 2+2?'" on the next turn (screen.log:117). No native macro/recipe/replay; `;` and `&&` pass through as natural language (screen.log:88 — model said "Hi! / Bye!").

## Friction log

- **CRITICAL / `/clear` semantics / screen.log:92-117** — `/clear` UI claims success but model retains prior turn. Expected: actual history wipe (or rename to `/clear-ui`). Repro: ask anything, run `/clear`, ask "what was my previous question?". Suggested fix: either truncate the upstream message list when `/clear` fires, or rename the command and document the divergence in the help string.

- **HIGH / `/context` broken under daemon / screen.log:275-283** — `Error: This command requires the in-process runtime and is not yet supported when the TUI is running against the daemon.` But the daemon path is the default user surface. A power user composing a long session can't see token usage. Suggested fix: implement a daemon RPC for context stats, or at minimum surface the daemon endpoint in `/context` output rather than rejecting the command.

- **HIGH / `/cost` disabled silently / screen.log:299** — "Cost tracking is not enabled for this session." With no hint about how to enable it (no flag, no env var, no `/config` pointer). Suggested fix: link to the config key or print the exact env/flag needed (`AGENC_TRACK_COST=1`?).

- **HIGH / Bash mode `!` toggle confusing / screen.log:190-225** — Pressing `!` shows the `! !` banner suggesting bash mode is active, but typing `ls package.json` and Enter sent it as a chat prompt with literal `!` appended (model then chose to run `exec_command` itself). Expected: in bash mode, Enter runs the shell command directly without invoking the model. Repro: press `!`, type `ls package.json`, press Enter — observe model turn instead of direct shell output. Suggested fix: bash mode must intercept Enter and bypass model dispatch.

- **MEDIUM / Spinner verbs are jokes, not status / screen.log:84,112,144,155,193,225,267** — Spinner cycles through `Retracing…`, `Resolving…`, `Cross-compiling…`, `Parsing…`, `Triggering…`, `Verifying…`, `Transcoding…`. Cute but misleading: no actual cross-compilation or transcoding is happening on `count to 3`. A power user reading these can't tell whether the spinner reflects real phase progress. Suggested fix: real phase verbs (`thinking`, `tool-call`, `streaming`) or remove entirely.

- **MEDIUM / No native chain or macro surface / screen.log:88** — `;` and `&&` are not first-class. Persona-relevant gap: no `/macro`, `/recipe`, `/replay`, `/save`. Suggested fix: add a `/replay <n>` to re-send the Nth prior user message, or `/macro save NAME` from history.

- **LOW / Shortcut card collapses lines / screen.log:49-57** — The `?` card is rendered as one continuous wrapped line: `! for bash modedouble tap esc to clear inputctrl + shift + - to / for commands…`. Hard to scan even before ANSI strip. Suggested fix: render each shortcut on its own line.

- **LOW / Redundant slash autocomplete entries / screen.log:289-291** — After `/cost` ran, the suggestion popup re-listed `/context` and `/files` for the next keystroke, but they were already shown.

## Discoverability score (3/5)
`?` and `/keybindings` are real wins. Lost a point for `/clear` lying, another for `/context`/`/cost` being trapdoors under the default daemon path.

## Latency feel (4/5)
First-token latency is good. `count to 3` returned in ~3-4 s; longer turns ~6-8 s. The spinner runs continuously so there is no dead air.

## Error message quality (2/5)
`/context` error names the cause cleanly but offers zero remediation. `/cost` says "not enabled" with no pointer to how to enable. `/clear` doesn't error at all — it succeeds while quietly lying.

## Notable surprises
- `/keybindings` opening nano on a live JSON file is powerful; the schema URN (`urn:agenc:schema:keybindings`) hints at future editor integration.
- `ctrl+r` history search hinted (screen.log:171) but no overlay rendered — own test pass.
- Card mentions `&` background and `ctrl+t` tasks, suggesting a hidden async-job surface worth probing.
