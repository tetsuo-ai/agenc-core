# Persona: Wide Terminal (220x60)

## Task
Drive `agenc --yolo` at 220x60. Open slash menu, run `/help /agents
/permissions /files /diff /keybindings /usage /cache-stats`, type a
200-char prompt, submit a single-line response prompt, look for
width-only features.

## Outcome
TUI launches at 220x60. Top/bottom dividers draw full width 220 cols
(screen.log L7, L28), so the renderer detects cols. But every popover
draws a bordered card stamped to full width with content collapsed in the
upper-left, leaving 90%+ of the box empty. No side-by-side, no two-column,
no expanded view appeared at any point. Width is detected, width is not
used.

## Friction log

- HIGH / `/help` (L28) / Pops a 220-col card whose entire body is
  "registry pending" jammed top-left. No actual help text. /
  Expected: command grid + key hints using 220 cols. /
  Repro: `/help` Enter. /
  Fix: real `/help` content; if backend not wired, surface a clear
  "help registry not implemented" instead of leaking internal state.

- HIGH / `/usage` (L70) / Card body is the raw exception
  `Error: Cannot read properties of undefined (reading 'unsafePeek')`. /
  Expected: token meter, per-tool breakdown, budget bar at width. /
  Repro: `/usage` Enter. /
  Fix: guard `unsafePeek`; on missing data, render zeros + an empty-state
  note like `/cache-stats` does (L77).

- HIGH / global header / "Found 4 keybinding errors · /doctor for details"
  appears on `/usage` and `/cache-stats` (L70, L77) on a fresh launch,
  stock config, no edits. Not actionable. /
  Expected: inline names of failing bindings (220 cols has room). /
  Fix: list the 4 names inline; auto-suppress when ratio is small.

- MED / All popovers (`/help` L28, `/permissions` L42, `/files`, `/diff`,
  `/cache-stats` L77) / Card frame stretches to 220 cols, content stays
  in left ~30 cols, right ~190 cols blank. /
  Expected: cap card at min(120, cols-8) and center, OR put key/value
  content in two columns. /
  Fix: width-clamp + center small cards; two-column layout for kv lists.

- MED / `/diff` (L55) / Diff card single-column, hard-left, right ~85%
  empty. Wide width is exactly when side-by-side diff helps. /
  Expected: side-by-side at cols >= ~160. /
  Fix: auto-engage two-pane diff at width threshold.

- MED / `/keybindings` (L62) / Spawns nano in $EDITOR inside the same
  pty; chrome bleeds in (max line 1134 chars across folded frames). /
  Expected: native in-TUI inspector at width with table view. /
  Fix: native viewer; $EDITOR only when user picks "Edit".

- LOW / 200-char typed prompt (L20) / 200 A's fit one composer line
  cleanly. No wrap. But no ruler / remaining-cols indicator, so users
  don't know the wrap boundary. /
  Fix: optional right-edge ruler or remaining counter past ~150 cols.

- LOW / Submitted prompt (L83) / Single-line "OK" reply prints inline
  full-width cleanly. No issue.

## Discoverability score: 1/5
Slash menu shows only ~5 catalog entries with no "more below" hint
(L13). No mention anywhere of features that only activate at width.

## Latency feel: 3/5
Prompt round-trip ~6s (L83). Command popovers feel instant.

## Error message quality: 2/5
`/usage` leaks raw `unsafePeek` exception (L70). The 4-keybinding-errors
warning is unactionable without `/doctor`. `/help` body is literally
`registry pending`.

## Notable surprises
- No feature gained anything from 220 cols vs standard 80 cols. The TUI
  draws wider borders and stops there. No side-by-side, two-column,
  ruler, margin, or expanded variant of any view exists.
- `/help` body is literally `registry pending` — wired command pointing
  at an unimplemented backend.
- Keybinding error count (4) appears on a fresh stock launch with no
  edits.
- `/cache-stats` is the only popover that has a clean empty-state
  message ("No API requests yet this session"); other commands should
  follow that template.
