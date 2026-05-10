# Narrow Terminal — Round 2 (80x24)

**Binary:** `/home/tetsuo/.local/bin/agenc 0.2.0` (HEAD `4999c596`)
**Persona:** Narrow Terminal — 80 columns, 24 rows, `agenc --yolo`
**Geometry verified:** baseline render (`narrow-terminal-screen.log:1-26`)
shows a 24-row display whose horizontal dividers measure exactly 80
dashes (`screen.log:21,23`).

## Layout breakage / silent truncation / off-screen state

### B1. Slash-menu descriptions silently truncated (medium)
Open `/`. Each row is laid out as `name (col 5–25) description (col 27–80)`.
At 80c the description field is ~51 characters and is hard-truncated with
`…`, no tooltip, no expansion.
Evidence: `screen.log:42` (`/branch  Create a branch of the current
conversation at th…`), `screen.log:44` (`/btw    Ask a quick side question
without interrupting th…`), `screen.log:537` (`/init    Generate an
AGENC.md contributor guide in the cur…`). The full description is
unreachable from the picker — only `/help` shows it.

### B2. Footer hint vanishes the moment you start typing (medium)
Empty composer shows `  ? for shortcuts` on line 24
(`screen.log:24`). One keystroke removes it
(`screen.log:469-494`, typing `h`: line 24 is blank). The hint also
disappears whenever the slash picker is open (`screen.log:50,572`). At 80c
this is the only on-screen guidance, so dropping it on first input is the
worst time to drop it.

### B3. `?` shortcuts overlay is misaligned at 80c (medium)
`screen.log:469-494` (the `?` capture). The overlay packs 4 columns into 7
rows but visual columns drift:
- line 17 column 2 reads `double tap esc to clear`, line 18 column 2 reads
  bare `input` — that orphan `input` is the wrapped tail of
  `shift + tab to auto-accept edits` that lives on line 17/18 of column 3.
- line 20 column 3 reads `meta + p to switch model` then line 22 column 3
  reads `ctrl + x ctrl + e to edit in` — column 3 is wrapping into column
  4 with no separator.
- line 22 column 1 (`question`) is the wrapped continuation of
  `/btw for side question` from line 21 — fine — but it sits next to the
  orphaned `backslash (\) + return (⏎) for newline` (lines 22-23 column 2),
  producing a wall of fragmented text that is unreadable without already
  knowing the intended grouping.

### B4. `--yolo` mode is invisible in the UI (medium)
The session was launched with `agenc --yolo` (bypass). Nothing on screen
reflects this:
- `/permissions` reports `Mode: default` (`screen.log:133`).
- `/status` reports `Permission mode : default` (`screen.log:191`).
- The composer prompt is the same `❯` glyph as non-yolo
  (`screen.log:22,46,...`).
- Footer hint is the same `? for shortcuts` (`screen.log:24`).
A narrow-terminal user has no way to tell if they're in bypass mode.

### B5. `/buddy` rejects itself inside the interactive TUI (medium)
`screen.log:240-242`: `/buddy` immediately returns a JSON error
`"/buddy requires the interactive TUI command surface."` even though we
are clearly in the interactive TUI. The error is also unwrapped JSON
rather than a formatted message; on a narrower terminal it would also
break the layout.

### B6. `/branch` silently no-ops (low)
`screen.log:495-520`: typed `/branch` + Enter, no overlay, no error, no
status message. The composer just clears. At 80c there is no contextual
hint that arguments are required (and even at 120c, the slash menu's
description is itself truncated — see B1).

### B7. `/btw` silently no-ops on bare submit (low)
`screen.log:157-182`: bare `/btw` + Enter clears the composer and emits
no feedback. Compounds with B1 — at 80c the menu hint is truncated
at `Ask a quick side question without interrupting th…`, so the user has
no way to discover the required argument from inside the TUI.

## What works correctly at 80x24

- Boxed-overlay commands (`/help`, `/status`, `/files`, `/effort`,
  `/cache-stats`, `/usage`, `/diff`, `/permissions`) draw a 78-inner-col
  box that wraps prose cleanly. Example: `/help` page
  (`screen.log:79-104`, `screen.log:53-78`) reflows full paragraphs
  inside the box, no off-right truncation.
- `/agents` empty state is well-laid-out within 80c
  (`screen.log:105-130`).
- `/keybindings` shells out to `nano` which adapts to 80x24 natively
  (`screen.log:287-312`).
- 200-character composer input wraps cleanly across three composer rows
  with the `❯` margin preserved on row 1 and two-space indent on
  continuations (`screen.log:391-416`, lines 20-22).
- Submitted prompt + model response with manual wrapping fits and wraps
  inside transcript without overflow (`screen.log:417-442`, lines 11-16
  show the cat-facts list wrapping at col 78).

## Model behavior, not UI

"Echo a 1500 character line" caused the model to run `python3 -c
"print('A' * 1500)"` but its assistant text only said "Here's your
1500-character line" without printing it (`screen.log:573-598`). The
tool-card preview truncation with `...)` (`screen.log:577`) is the
standard ledger preview, not a width regression.

## Summary

Seven issues at 80x24. Highest-impact fixes: slash-menu description
truncation (B1), footer-hint loss on first keystroke (B2), `?` overlay
column packing (B3), and missing `--yolo` indicator (B4). `/buddy`,
`/branch`, `/btw` all fail silently or with malformed errors and should
render a boxed message at 80c.
