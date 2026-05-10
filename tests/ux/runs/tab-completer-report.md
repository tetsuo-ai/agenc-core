# Persona: Tab Completer

## Task
Stress-test path completion in `agenc --yolo` against a fixture tree at
`tests/ux/_uxfix/` containing deep paths (`a/b/c/d/e/f/g/file.txt`), spaces
(`with spaces/inside name.txt`), unicode (`日本語/ファイル.txt`,
`émoji/🚀.txt`), hidden files (`.hidden/.alsohidden`), a broken symlink
(`broken -> /nonexistent`), and a 200-file `bigdir/`. Probed `@` picker,
literal Tab, mid-cursor Tab, arrow+Enter selection.

## Outcome
The `@`-mention picker is the working completer. It handles unicode, spaces,
hidden, deep paths, and broken symlinks when the user types the
disambiguating prefix. Bare `Tab` outside the picker does nothing. Mid-cursor
Tab is broken. Listings are fast even on 200-file dirs.

## Friction log

- **HIGH / `tab-completer-screen.log:73` / Bare Tab is a no-op.** Typed
  `runtime/sr` then `\t`; input stayed `runtime/sr`, no picker opened. Help
  at `:8` shows `@ for file paths` and `shift + tab to auto-accept`,
  implying Tab is bound. Users from any shell/IDE press Tab first.
  Expected: open the picker on Tab when the cursor is on a path-shaped
  token. Fix: bind Tab outside the picker to promote the current word to
  an @-mention if it looks like a path.

- **HIGH / `tab-completer-screen.log:78` / Mid-cursor Tab is broken.**
  Typed `@runtime/srhelp/types.ts`, moved cursor 12 left with `\x1b[D`,
  pressed Tab. Input became `@runtime/srhelp/types.ts e`: the picker had
  closed (no literal match), and Tab inserted text or focus moved (stray
  `e` two cells right of the prompt). Expected: completion against the
  fragment under the cursor. Fix: if cursor sits inside an `@`-prefixed
  token, reopen the picker scoped to substring-before-cursor.

- **MEDIUM / `tab-completer-screen.log:18` / Picker is fuzzy, not
  prefix-first.** Typed `@runtime/sr`; suggestions were `runtime/src/`
  (good) then `runtime/src/memory/`, `runtime/src/memdir/`,
  `runtime/src/mcp/`, `runtime/src/llm/` — none start with `sr` after
  `runtime/`. A `git` user expects `sr<Tab>` to disambiguate to `src/`
  alone. Fix: rank strict-prefix matches above subsequence matches.

- **MEDIUM / `tab-completer-screen.log:33` / Default browse hides spaces,
  hidden, broken symlinks.** `@tests/ux/_uxfix/` shows `a/`, `bigdir/`,
  `日本語/`, `émoji/`, but NOT `with spaces/`, `.hidden/`, or `broken`.
  They DO surface when typed (`:38`, `:43`, `:48`). Hiding dotfiles is
  defensible; silently dropping a spaced name and a broken symlink is
  not. Fix: include spaced names in unfiltered top-N.

- **LOW / `tab-completer-screen.log:58` / Big-dir listing skips file001.**
  `bigdir/` (files 001-200) shows `bigdir/`, then `file002.txt`,
  `file003.txt`, `file004.txt`, `file005.txt`. `file001.txt` never shows.
  Looks like an off-by-one in the ranker that hides the highlighted entry
  from the visible list. Repro: `@tests/ux/_uxfix/bigdir/`.

- **LOW / `tab-completer-screen.log:28` / Symlink outside cwd silently
  falls through.** Created `_uxfix -> /tmp/agenc-completion-test` at the
  project root. `@_uxfix/` returned suggestions from
  `runtime/src/tools/apply-patch/__fixtures__/` instead of anything under
  `_uxfix/`. Symlink was not followed and the picker fuzzy-matched the
  substring `uxfix` against the whole repo with no UI signal. Fix:
  explicit "no matches under <symlink>" state.

- **LOW / `tab-completer-screen.log:8`,`:93` / Help omits Tab-in-picker.**
  Shortcut help mentions `shift + tab` and `@` but not Tab inside the
  picker, which DOES accept the highlighted entry (`:93`: Tab against
  `@tests/ux/_uxfix/a/b` produced `a/b/c/d/e/f/g//`). The trailing `//`
  is a minor glitch.

- **LOW / `tab-completer-screen.log:88` / 4 startup keybinding errors are
  noise.** `/doctor` shows `error reserved: "ctrl+c"` and `"ctrl+d"` each
  appearing twice — duplicate registrations. Footer warning
  `Found 4 keybinding errors` flashes on every screen (`:33, :38, :43,
  :48`). Fix: dedupe registrations; demote to `/doctor`.

## Discoverability score
2/5 — `?` help mentions `@ for file paths` but no inline hint. Tab does
nothing useful.

## Latency feel
4/5 — `@bigdir/` (200 files) and the 7-level-deep path return instantly.
Repo-wide fuzzy fallback also returned within the sleep budget.

## Error message quality
1/5 — Symlink-outside-cwd, no-match, and broken-symlink cases all silently
fall through. The persistent "Found 4 keybinding errors" footer is
unrelated to completion.

## Notable surprises
1. `@_uxfix/` becomes a fuzzy substring search across the entire repo when
   the literal path has zero matches — no signal that the literal failed.
2. Tab in the picker confirms the suggestion AND immediately reopens a new
   round, producing trailing `//` (`:93`).
3. Arrow-down + Enter correctly inserts the selected path (`:83`) — so
   keyboard selection works, just not via Tab.
