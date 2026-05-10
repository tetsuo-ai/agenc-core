# Wide Terminal (220x60) — Round 2 Report

AgenC 0.2.0 / HEAD `4999c596`. Run 2026-05-10. Persona: operator with a 220-col window expecting tooling to actually use the extra width.

220x60 confirmed: every full-width separator and panel border in `wide-terminal-screen.log` is exactly 220 chars (e.g. S2 lines 3,5; S4 lines 12,15; S6 lines 3,5,68; S8 line 24).

## Summary verdict
The TUI **starts at 220 cols and stretches horizontal chrome (rules, panel borders, composer top/bottom rails) to the full width**, but **zero functional surface uses the extra width**. Every popover is a single tall narrow column glued to the left edge with ~190 cols of dead space inside its own 220-col frame. No two-pane diff, no multi-column slash list, no side-by-side help, no inline-table usage view, no wide layout opt-in. The single concrete width benefit is that a 200-char typed prompt fits on one composer line without wrapping (S10 line 7, len=201).

## Findings (severity / scenario / evidence / expected / fix)

### HIGH / Slash menu (S1; descriptions in `wide-help.log` lines 43–66)
After `/`, commands list one per row. Each row sits in a full-width 220-col panel (S2 lines 12, 67 = `╭─`/`╰─` at len=220) but content is single-column with descriptions wrapping at ~80 cols (S2 lines 43–66 — e.g. `/agenc-umbrella-public-surface` continues onto a second row at len=83). ~140 cols empty per row.
Expected: multi-column packer above `cols >= 160`; or widen description column to ~`cols-30`.

### HIGH / `/diff` (S6 lines 12–68)
Single-column unified text inside a 220-col-bordered panel (line 12, 68 len=220). Content rows are short (line 14 len=54, line 55 `│tests/ux/round-1/PHASE0.md│` len=28). ~140 cols inner blank. This is the highest-leverage wide command: side-by-side HEAD vs working-tree should auto-engage.
Expected: at `cols >= ~160`, two-pane diff viewer; flat unified falls back narrow.

### HIGH / `/keybindings` (S7 lines 14–18)
Spawns `nano` in `$EDITOR` inside the same PTY (line 14 chrome `GNU nano 7.2 …/keybindings.json`, line 15 `^G Help ^O Write Out…`, line 17 dumps one JSON blob at len=1146). No table view, no inspector, no width awareness. Operator drops out of the TUI into a modal editor.
Expected: native in-TUI inspector at width (context / chord / action columns); `$EDITOR` only for an explicit "Edit raw" action.

### MED / `/permissions` (S4 lines 12–15)
220-col border around two lines: `│Mode:default│` (len=14), `│(nopermissionrulesconfigured)│` (len=31). ~190 cols empty inside.
Expected: at width, render permission-rule table (Tool / Scope / Mode / Source) plus bypass status.

### MED / `/usage` (S8 lines 16–24) and `/cache-stats` (S9 lines 12–16)
220-col borders around 7 short label:value rows (`/usage`, max len=21) or 3 rows (`/cache-stats`, max len=46).
Expected: inline budget bar / gauge; cached-vs-uncached split panes at width.

### MED / `/files` (S5 lines 18–20) and `/agents` (S3 lines 17–23)
`/files`: `│Nofilesincontext.│` (len=19) in 220-col panel. `/agents` empty state stops at len=91. Both could pair empty state with inline quick-create panel; populated states should be multi-column tables.

### LOW / Composer wrap (S10 line 7)
200 A's at len=201 on one composer line; no wrap, no right-edge ruler, no remaining-cols indicator.
Expected: optional column indicator past ~150 chars.

### LOW / Submitted reply (S11 lines 9–14)
`❯ …prompt…` at len=220 (line 9). `●OK` reply at len=3 (line 14). No wrap problem and no width gain.

## Discoverability of width-only features: 0/5
There is no width-only feature. Every popover and command behaves identically to narrow mode except chrome scales. The TUI advertises no `cols >= N` opt-in, no two-pane mode, no `/wide` toggle.

## Notable surprises
- The `/help` body itself is the *catalog* of slash commands (lines 13–66 of S2), not a help screen — and it wraps long descriptions at ~80 cols even with 220 available.
- `/diff` and `/keybindings` are the two commands a wide-terminal operator would expect the most leverage from, and they are the two with the *least* width awareness (`/diff` = single-pane unified text; `/keybindings` = literally launches `nano`).

## Word count: 798
