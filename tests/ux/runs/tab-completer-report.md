# UX Report — Tab Completer persona (agenc 0.2.0 / HEAD 4999c596)

Date: 2026-05-10. Driver: `script` (util-linux 2.39.3) under `agenc --yolo`.
Evidence: `tab-completer-screen.log` (84 lines, 12 scenarios) and
`tab-completer-keys.log`. Fixture rooted at `/tmp/agenc-completion-test/`.

## Summary verdict

Path completion exists only via the `@` file-picker. ASCII fuzzy match works,
but five behaviors damage trust: (1) typing a space silently drops the path;
(2) only five results render regardless of viewport width, so 200-entry
directories look identical to 5-entry ones; (3) Tab descends but never cycles;
(4) hidden-file visibility is inconsistent (auto-listed at workspace root,
empty for explicit `.hi` prefix); (5) cursor position is ignored.

There is no Tab completion in the plain composer; `\t` outside the picker is
a silent no-op (`11-bare-tab.log`, screen.log line 73).

## Findings

### F1 — Spaces in paths break completion entirely (HIGH)

Typing `@/tmp/agenc-completion-test/with spaces/` swallows the space: query
echoes as `/tmp/agenc-completion-test/withspaces/` (line 31) and results
switch to unrelated cwd matches (`runtime/src/prompts/attachments/*`). No
escape, no quoting hint, no visual cue. A user with one `my docs/` folder
cannot reach it via `@`.

### F2 — Result list capped at 5, no overflow signal (MEDIUM)

`bigdir/` (200 files) renders the same row count as a 5-entry directory
(line 67). Five identical truncated entries `/tmp/agenc-completion-test/bi…`
with no `+195 more`, scrollbar, or keyboard hint. Users can't tell whether
the picker is broken, slow, or hiding results.

### F3 — Mid-cursor Tab unsupported, emits stray glyph (MEDIUM)

Scenario 10: buffer `runtime/srhelp/types.ts` with cursor between `sr` and
`help`, then `\t`. No completions; instead a stray `l` is rendered in the
result row area (line 79). Arrow-key escape `\x1b[D` is consumed correctly
for cursor movement, but Tab appears to emit a character into the result
area instead of acting on the prefix to the cursor. Missing feature plus
rendering bug.

### F4 — Hidden-file visibility inconsistent (MEDIUM)

Empty query auto-lists `.agenc/`, `.git/`, `.githooks/`,
`.github/`, and other-tool dotted dirs (line 5). Explicit dotted prefix
`/tmp/agenc-completion-test/.hi` returns empty (line 61). Either both
or neither is defensible — the mismatch is the problem.

### F5 — Broken symlink listed without health hint (LOW)

`…/bro` returns `/tmp/agenc-completion-test/br…` (line 73). The
broken-symlink target (`/nonexistent`) isn't surfaced. Accepting would
hand the model an unresolvable path. A muted "(broken)" badge would help.

### F6 — Tab descends rather than cycles (LOW)

Scenario 12 (`@/tmp/agenc-completion-test/` + 3 Tabs): each Tab accepts the
top match and steps in (`a/` → `b/` → `c/` chips, line 84). No way to pick
the second result via Tab. Users from readline/fzf expect Tab-to-cycle.
Either keep Tab-as-descend with explicit Down/Up cues, or add Shift-Tab
cycle.

### F7 — Deep path collapses to one truncated row (LOW)

`@/tmp/agenc-completion-test/a/b/c/d/e/f/` returns only
`/tmp/agenc-completion-test/a/…` (line 24), losing every disambiguating
segment. Always-show-final-segment-after-ellipsis would help.

### F8 — Unicode renders and accepts (POSITIVE)

`日本語/` and `émoji/` surface correctly in row chips (lines 38, 47) and
input buffer. No mojibake across CJK or combining accents. Wide-char width
math is correct (no column-shift artifacts).

### F9 — No Tab completion in plain composer (LOW)

Outside `@`, `\t` is a no-op — no popup, no character insertion (line 73,
buffer `runtime/sr` unchanged). If Tab is picker-only, the help overlay
should say so.

## Latency / accuracy notes

Picker render after `@` was sub-second in every scenario under a 14s timeout.
ASCII fuzzy match was accurate (`runtime/sr` → `runtime/src/...`, line 13).
No hangs, crashes, or terminal corruption beyond the F3 stray glyph.

## Recommended fixes (priority order)

1. Accept spaces inside `@` queries (treat buffer as one path); add an
   escape syntax if disambiguation is needed.
2. Show overflow count and scroll affordance when results exceed the cap.
3. Implement cursor-aware Tab or document Tab-acts-on-full-query; remove
   the stray glyph emitted in scenario 10.
4. Reconcile hidden-file visibility — pick one rule and apply uniformly.
5. Mark broken symlinks visibly in the result row.
