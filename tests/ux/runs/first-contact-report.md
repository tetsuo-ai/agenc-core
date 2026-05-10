# Persona: First Contact

## Task
Launch `agenc` with zero prior knowledge. Figure out what it is from the screen
alone, find help, run one useful command. No source-code reading, no external
docs.

## Outcome
Partial success. After ~4 sessions, I figured out this is an AI agent / coding
CLI with slash commands and a multi-provider model setup. `/help` and `?`
exist and work. I successfully ran one useful command (`agenc providers`,
which produced a clean, informative readout) and one useful prompt
(`agenc --no-tui "..."`). I never learned **what AgenC is for** from the TUI
itself; the only thing that explained the product was `agenc --help` from
outside the TUI (lines 4-21 of agenc --help). The TUI cold-launch screen
shows only horizontal rules, a `❯` prompt, and `? for shortcuts`. No
banner, no product name, no one-liner.

## Friction log

- **High / cold launch (screen.log L2):** Empty TUI, no banner, no version,
  no "what is this" — just a prompt and `? for shortcuts`. **Expected:**
  one-line "AgenC v0.2.0 — local AI coding agent." Branding on a 0.x earns
  trust. **Repro:** `agenc`. **Fix:** static banner above the rule on cold
  launch (suppress on `-r`/`-c`).

- **High / `?` overlay (screen.log L5):** Shortcut overlay is a packed grid
  where labels and key names collide ("`! for bash mode  double tap esc to
  clear input  ctrl + shift + -  to`"). On 80-col it almost certainly wraps
  mid-row. **Expected:** two columns KEY | DESC. **Fix:** one shortcut per
  row, fixed widths.

- **Med / `/help` (screen.log L11):** Shows a long list of project-installed
  skills (`/release-notes-drafter`, `/remotion-best-practices`,
  `/skill-creator`, ...) but **no built-in command summary** — no "type a
  message to chat", no mention of `agenc providers`, `agenc init`,
  permission modes, models, how to pick one. **Fix:** prepend a fixed
  orientation block to `/help`, then builtin commands, then user skills.

- **Med / `/` autocomplete (screen.log L8):** Shows first 5 commands
  (`/agents`...`/buddy`) but nothing hints there are dozens more. **Fix:**
  count badge ("5 of 47") or Up/Down indicator.

- **Med / model self-identification (screen.log L35):** `agenc --no-tui "In
  one sentence, what is this tool?"` returned "I cannot answer this
  question because no specific tool has been identified." An earlier run
  invented "**FileRead**". The agent has no system-prompt awareness that
  it is AgenC, so it can never answer "what are you" correctly. **Fix:**
  prepend identity to system prompt.

- **Low / cold launch (screen.log L2):** Stray escape bytes leak to screen
  (`[>0q` — terminal-mode query echoed). Invisible in modern terminals,
  visible under `script`. Suggests raw-mode/first-render ordering bug.

- **Low / shortcut overlay (screen.log L5):** "ctrl + shift + -" truncates
  ("to" trails off-screen) — grid layout clips labels.

- **Low / shortcut overlay (screen.log L5):** Two competing footer hints
  ("? for shortcuts" and "Press Ctrl-C again to exit") render together
  instead of one prevailing.

## Discoverability score: 3 / 5
Help is reachable (`?`, `/`, `--help`). But cold launch tells you nothing,
and `/help` shows project skills before built-ins.

## Latency feel: 4 / 5
TUI starts under 1s, model response in `--no-tui` returned in ~3s. Smooth.

## Error message quality: 4 / 5
`agenc providers` is excellent — readable table, clearly states which keys
are missing and which env var to set. Best surface I saw.

## Notable surprises
- No login required by default — "Auth: local; subscription: free" (L14).
  Pleasant.
- 16 providers listed including 3 local servers detected up (ollama,
  lmstudio, openai-compatible). The breadth surprised me.
- A `/buddy` command ("Hatch, pet, and manage your AgenC companion") sits
  in the top-5 slash list. Cute but odd as a first impression alongside
  serious tools.
- The agent itself doesn't know it's AgenC. That's the sharpest finding.
