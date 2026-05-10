# Persona: Paste Bomber

## Task
Paste a 500-line, 122KB markdown payload (mixed code fences with bash/TS/Python/SQL/JSON, a tilde-wrapped nested fence, an unclosed Ruby fence, a 4-vs-3 backtick mismatched fence, inline-backtick walls, CJK + Arabic + Hebrew + Cyrillic + Greek mixed scripts, ZWJ emoji sequences with skin tones, three URLs >200 chars) into `agenc --yolo` under `script(1)`. Probe paste rendering, scroll/freeze, dropped input, malformed-fence resilience. Comparison: 50-line variant. Six runs: smoke; big-no-submit; big+Enter; small+Enter; markers-bracketing-paste; explicit-BPM markers.

## Outcome
The TUI handled the 500-line paste gracefully. The composer collapsed the 122KB blob into a single inline placeholder `[Pasted text #1 +498 lines]` instead of dumping raw content. Submit worked; the model received intact content (verified via the small-paste round trip where the model wrote the payload back to disk and diff matched: every emoji ZWJ sequence, every RTL Arabic glyph, every 200-char URL preserved exactly). No freeze >2s, no scroll lock, no crash on any of the four malformed fences. `BEFORE_MARKER` and `AFTER_MARKER` typed before/after the paste both survived in the composer, ruling out dropped input. Paste-write to the pty took ~2ms; placeholder rendered within one redraw cycle.

## Friction log

- **LOW** / `paste-bomber-screen-big-submit.log` lines 1-3 / Placeholder counts newlines rather than lines: a 499-line paste reports `+498 lines`; a 50-line paste reports `+49 lines`. Off-by-one from a user's mental model. / Expected: `+499` / `+50`. / Repro: paste any N-line content; placeholder shows `+(N-1)`. / Fix: count via `splitlines().length`, or `+1` when content does not end with `\n`.

- **MED** / `paste-bomber-screen-small.log` lines 1-3, search `Write({"file_path":...)` / Streaming tool-call previews get visibly mangled when long JSON args stream in. The same Write call rendered four times in succession with progressively-different filenames (`smal_paste_s.md`, `smal_pase_test.md`, `small_paste_test.md`, truncated variant), each redraw overwriting the prior at column boundaries without clearing the line. Visible state-leak between updates. / Expected: stable in-flight tool-call rendering, ideally one growing line. / Repro: any model-Write call with >100 chars of JSON content. / Fix: throttle/debounce streaming arg previews, or full-line clear between updates.

- **LOW** / `paste-bomber-screen-bpm.log` lines 1-3 / Explicit `\x1b[200~ ... \x1b[201~` markers around the payload produced **identical** behavior to no markers. Cannot distinguish heuristic-fold vs BPM-driven fold from outside. / Expected: same UX (which it is) but logs should distinguish paths. / Fix: log which detection path fired.

- **LOW** / `paste-bomber-screen.log` lines 4, 9, 21, 28 / Startup banner shows `Found 4 keybinding errors · /doctor for details` on every yolo launch. Recurring, not actionable for end users. / Fix: investigate via `/doctor`; fix or downgrade the warning when the user has not customized.

- **LOW** / `paste-bomber-screen-small.log` (post-test cwd inspection) / Model wrote `small_paste_test.md` into the agenc-core repo cwd in response to the paste. Not a paste-handling bug — the model interpreted a document-shaped paste ending in `# END OF ...` as a save request. / Out of scope; flag for prompt-engineering review.

## Discoverability score (4/5)
The collapsed `[Pasted text #N +M lines]` placeholder is exactly the right affordance — large pastes do not blow up the composer, the user sees a tidy summary, typed text wraps around it. Lost a point for the off-by-one line count.

## Latency feel (5/5)
Zero perceptible lag. 122KB write took 2ms; placeholder rendered within one redraw cycle. Model first-token-out at ~8s (provider latency, not TUI). No freeze, no scroll lock at any size.

## Error message quality (n/a)
No error messages during paste handling. Malformed fences (unclosed Ruby, mismatched-length Go fence, backtick walls) silently became part of the pasted blob, which is correct — a paste is opaque content, not parsed.

## Notable surprises
1. **Paste survives intact through the round trip** — verified by having the model write a 50-line paste back to disk and comparing: byte-identical for Unicode, ZWJ emoji, long URLs. The TUI is not corrupting payloads.
2. **BPM markers vs no markers produce identical results** under `script(1)` — the runtime appears to fold rapid multi-line input bursts heuristically regardless of explicit markers.
3. **Streaming tool-call argument previews are the only real renderer issue found** (MED entry above). Triggered consistently by the small-paste run when the model made a Write call. Big paste did not trigger any tool calls so the issue did not surface there.
4. **No malformed-fence crashes**. The renderer treats the collapsed paste as opaque, sidestepping parser fragility on the four malformed-fence variants — likely intentional and correct.
