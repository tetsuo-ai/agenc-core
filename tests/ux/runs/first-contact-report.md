# Persona: First Contact

## Task
Launch `agenc` with zero prior knowledge, find help, run one useful command.

## Outcome
partial — figured out it's an LLM agent CLI, found two help paths, ran a one-shot prompt successfully. Inside the TUI, the most natural first-user commands (`/help`, `/status`) both errored. Never saw a "what is AgenC?" surface.

## Friction log

### 1. `/help` returns the literal string "registry pending"
- Severity: blocker
- Where: TUI, after typing `/help` + Enter
- What happened: Bordered box renders body `registry pending` and nothing else (`first-contact-screen.log` Run 4). Picker tooltip on the same line correctly says "Show help and available commands" — handler is a stub.
- Expected: A list of commands and descriptions, like the picker on `/`.
- Repro: type `/help`, Enter.
- Suggested fix: route `/help` to the registry that drives the picker (Run 3 proves it works there). At minimum render a real error instead of the internal state string.

### 2. `/status` crashes with an internal-looking exception
- Severity: blocker
- Where: TUI, after typing `/status` + Enter
- What happened: Red error box, `Error: Cannot read properties of undefined (reading 'unsafePeek')` (Run 5). Stack-trace-grade message to a new user.
- Expected: status panel with model, provider, session id, sandbox.
- Repro: type `/status`, Enter.
- Suggested fix: guard the call site, and wrap uncaught throws from slash commands in a generic "command failed" message rather than leaking JS property names.

### 3. Startup banner: "Found 4 keybinding errors" with no actionable cause
- Severity: major
- Where: composer footer, every cold launch
- What happened: New user sees `Found 4 keybinding errors · /doctor for details` before doing anything. `/doctor` shows all 4 are dupes: ctrl+c twice, ctrl+d twice, "cannot be rebound — used for interrupt/exit (hardcoded)" (Run 6).
- Expected: fresh install should not show keybinding errors. Hardcoded keys are reservations.
- Repro: any fresh launch.
- Suggested fix: dedupe and downgrade from `error` to silent-suppress or `info`.

### 4. No "what is AgenC?" surface on cold launch
- Severity: major
- Where: TUI initial frame and `?` overlay
- What happened: Cold screen shows a bordered composer, `❯`, `? for shortcuts`. `?` lists keystrokes (`! for bash`, `/ for commands`, `@ for files`, `& for bg`, `/btw`) but never says what AgenC is.
- Expected: one-line tagline or sample prompt above the composer.
- Repro: any cold launch.
- Suggested fix: 2–3 line zero-state hint above the composer until the first message is sent.

### 5. Model gives a wrong, internal-flavoured answer to "what is this tool?"
- Severity: major
- Where: TUI, after sending the prompt `what is this tool?`
- What happened: Model (`lmstudio/qwen3.6-35b-a3b-fp8`) described "the SendUserMessage tool", an internal AgenC tool, claiming it is "nearly identical to the Brief tool" (Run 7). First-contact user gets internal jargon instead of a product description.
- Expected: a short answer about AgenC the product.
- Repro: type `what is this tool?`, Enter.
- Suggested fix: system prompt should anchor a "what AgenC is" answer. The default local model also lacks capability for the introduction turn — consider shipping a stronger default.

### 6. Slash-picker arrow-key navigation does nothing
- Severity: minor
- Where: TUI `/` picker
- What happened: After `/`, picker shows first 5 (`/agents`, `/branch`, `/brief`, `/btw`, `/buddy`); Down 30 times does not scroll. Filter-by-typing works.
- Expected: arrow keys scroll the candidate list.
- Repro: type `/`, press Down repeatedly.
- Suggested fix: wire arrow-key handling into the picker, or document filter-by-typing in the `?` overlay.

## Discoverability score (0 to 5)
2 — `?` and `/` are discoverable from the footer; picker tooltips read well. But the two commands a new user reaches for first (`/help`, `/status`) are both broken, the picker has no keyboard nav, and there is no "what is this?" tagline.

## Latency feel (0 to 5)
4 — TUI cold start under 1s, one-shot `agenc --no-tui "..."` completed in 0.63s wall, streamed responses appear within 1–2s of pressing Enter.

## Error message quality (0 to 5)
1 — `Cannot read properties of undefined (reading 'unsafePeek')` and `registry pending` both leak internal state. `/doctor` is well-categorised (sandbox / MCP / keybindings) and would score 4 alone.

## Notable surprises
- Terminal title shows `AgenC lmstudio/qwen3.6-35b-a3b-fp8`.
- Trust-this-project dialog appeared on first run from `/tmp`; auto-remembers per-path.
- The `?` overlay teaches `! for bash mode`, `/btw for side question`, `& for background` — unusual primitives worth surfacing more prominently.
- `/doctor` is the most polished command. Startup banner correctly points at it.
