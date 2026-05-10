# Error Recoverer UX Report (round 2)

Binary: `agenc 0.2.0` HEAD `4999c596`. Working dir: `/home/tetsuo/git/AgenC/agenc-core`.
Driver: util-linux `script` with timed keystroke recipes.

## 1. Invalid model

**TUI `/model nonexistent-model-xyz`** (screen.log L1-12, test 1a): bordered error box leaks
runtime exception verbatim `Error: session.setPendingProviderSwitch is not a function`. No
suggestion. Prompt usable after. **Bug**: missing method on session shim. Should be
`Unknown model "X" — see /model for valid IDs`.

**One-shot `agenc --no-tui --model nonexistent "hi"`** (L13-18, test 1b): says `--model is not yet
supported as a CLI flag`, lists the remediation: edit `~/.agenc/config.toml` or run `agenc config
set model <id>` / `agenc config set model_provider <name>`. Excellent: WHAT + WHERE + COMMAND.

## 2. Network unavailable

`OPENAI_BASE_URL=http://localhost:1` env override is **silently dropped**: the long-running daemon
issues the HTTP call and does not inherit per-invocation env from `agenc --no-tui`. Even
`agenc daemon stop` then a fresh invocation auto-respawns the daemon ignoring the env. After
forcing the active provider to `openai` to provoke a real call (L20, test 2d): `openai error: The
model gpt-5 does not exist. [openai_category=model_not_found] Hint: The selected model is not
installed or not available on this endpoint.` Clear category + hint. No retry guidance, no offer
to switch provider. **Gap**: no agenc-owned wrapper for `ECONNREFUSED`/`ENOTFOUND` on bad
configured base URLs — users would just see the upstream error.

## 3. @-mention non-existent file

`@/does/not/exist.md explain` (L22-31, test 3): TUI sends the literal string verbatim to the
model; no path resolution, no warning, no preview chip. Model gracefully replies that the file
doesn't exist. **Gap**: @-mention is not validated client-side. User could waste a turn and tokens
before realising the file wasn't loaded. Suggest: resolve `@<path>` at composer time, mark
unresolved paths visually before submit.

## 4. Malformed slash

- `/totally-not-a-command` (L33-43, test 4a): renders raw JSON
  `{"kind":"error","message":"Unknown command: /totally-not-a-command"}` in transcript. Correct
  WHAT, no recovery suggestion ("type `/` for command list" would help). Raw JSON is leakage —
  should be plain prose.
- `/help nonsense` (L45-65, test 4b): argument silently ignored; full command catalogue rendered.
  Tolerant behaviour.
- `/   ` whitespace (L67-78, test 4c): triggers the suggestion popover starting at `/agents`. Acts
  as autocomplete; no error. Fine.

## 5. Expired / missing credentials

`XAI_API_KEY= agenc providers` (L80-81, test 5a): table cell reads `no  missing(XAI_API_KEY)
n/a  free  set XAI_API_KEY`. The `Detail` column explicitly tells the user what env var to
set. Excellent.

Trying to actually invoke grok with an empty `XAI_API_KEY` env: the env was again swallowed by the
daemon path so the call succeeded with the daemon's cached key. Not reproducible from the user
shell.

## 6. Daemon down

`agenc daemon stop` then `agenc agent list` / `agenc daemon status` (L83-87, test 6 / 6b): daemon
**silently auto-respawns** for any subcommand. `agent list` returned `No active agents`;
`daemon status` returned a new pid. No "daemon was down — restarted" notice, no `--no-autospawn`
flag. UX win: never user-visibly broken. UX gap: no observability of original failure state.

## 7. Invalid config / nonexistent profile

`--profile nonexistent` (L89-90, test 7a): one-line, exit-nonzero, explicit:
`agenc: Unknown profile "nonexistent". Available: <none>`. Lists allowed values. Excellent.

Corrupted `config.toml` (line 12 trailing junk; L92-99, test 7b): a single corruption causes
**8-10 duplicate log lines** in one invocation:
```
[agenc:config] invalid TOML at /home/tetsuo/.agenc/config.toml: TOML parse error at line 12: ...
[agenc:config-migration] skipped config.toml migration: invalid TOML ...
```
Then the command falls through to its happy path (`Hi! How can I help you today?`).
**Bugs**: (a) the validator is invoked many times during a single run instead of once + cached;
(b) `agenc config validate` itself emits `cannot edit config.toml after skipped config migration
(toml:invalid)` but exit 0, so scripts that depend on `validate` will not catch the failure.

## Summary verdict

| # | Scenario | WHAT? | RECOVERY hint? | Returns to prompt? |
|---|---|---|---|---|
| 1a | invalid /model (TUI) | leak: `setPendingProviderSwitch is not a function` | none | yes |
| 1b | invalid --model | clear | yes (3 paths) | n/a (one-shot) |
| 2 | network bad | upstream verbatim | partial (hint) | n/a |
| 3 | bad @-mention | not detected | none (model improvises) | yes |
| 4a | unknown slash | raw JSON | none | yes |
| 4b | /help garbage | tolerated | n/a | yes |
| 5a | missing key | clear table | yes (set env) | n/a |
| 6 | daemon down | silently respawned | n/a | yes |
| 7a | bad profile | clear | yes (lists allowed) | n/a |
| 7b | corrupt config | clear text, spammed 10x + bad exit code on validate | partial | yes (degrades) |

Daemon restored to `running (pid 244558)`.
