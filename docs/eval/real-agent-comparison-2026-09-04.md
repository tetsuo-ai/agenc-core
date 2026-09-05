# Real-agent comparison: AgenC against Hermes on grok-4.6, 2026-09-04 to 2026-09-05

All runs use the same model, xAI grok-4.6, the same 13 tasks from `runtime/eval/tasks` (12 single-prompt
command tasks and the 15-step `asteroid-drift-15` session), the same deterministic verifiers, and the same
machine. AgenC runs in an isolated home through `agenc -p` (command tasks) or the AgenC SDK (session task);
Hermes v0.14.0 runs through `hermes chat -Q --yolo --provider xai -m grok-4.6 -q <prompt>` with `-c` to
resume its last session on later steps. Reports are in `runtime/eval/reports/compare-*.json`.

## Command tasks (12 single prompts)

| agent | effort | passed | total wall time | per task | input tokens |
| --- | --- | --- | --- | --- | --- |
| Hermes v0.14.0 | medium (its config) | 12 of 12 | 577 s | 26 to 76 s | not reported by Hermes |
| AgenC 0.17.0, main before today | xhigh | 12 of 12 | 391 s | 23 to 49 s | 1.07M |
| AgenC 0.17.0 + retention (#2147) | xhigh | 12 of 12 | 312 s | 17 to 33 s | 1.12M |
| AgenC 0.17.0 + retention | medium | 12 of 12 | 313 s | 12 to 49 s | 1.17M |

## 15-step session (asteroid-drift-15)

| agent | effort | steps passed | wall time | input tokens | tool calls | tool errors | re-reads | compactions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AgenC main before today (baseline r2) | xhigh | 14 of 15 (changelog verifier too strict, since fixed) | 2743 s | 34.5M | 201 | 0 | 17 of 78 (22%) | 0 |
| Hermes v0.14.0 | medium | 15 of 15 | 2203 s | not reported | not observable | not observable | not observable | not observable |
| AgenC + retention (#2147) over the SDK | xhigh | 15 of 15 | 2367 s | 25.1M | 134 | 0 | 3 of 49 (6%) | 0 |
| AgenC + retention through the desktop app | xhigh | 15 of 15 (all 8 verifiers) | 1955 s of turns, 1972 s wall | rollout: 75 model calls, 13 cache misses | 208 | 0 | | 1 committed |
| AgenC + retention over the SDK | medium | 15 of 15 | 1275 s | 24.9M | 140 | 0 | 3 of 48 (6%) | 0 |

Per-step wall time, seconds:

| step | Hermes (medium) | AgenC SDK (medium) | AgenC SDK (xhigh) | AgenC desktop (xhigh) |
| --- | --- | --- | --- | --- |
| 01 scaffold | 118 | 41 | 92 | 118 |
| 02 asteroids | 57 | 37 | 32 | 64 |
| 03 score | 68 | 31 | 33 | 43 |
| 04 start-pause | 83 | 35 | 54 | 57 |
| 05 modules | 116 | 58 | 83 | 93 |
| 06 effects | 133 | 53 | 136 | 66 |
| 07 audio | 164 | 41 | 119 | 103 |
| 08 powerups | 199 | 104 | 197 | 154 |
| 09 levels | 87 | 46 | 126 | 115 |
| 10 touch | 108 | 56 | 252 | 85 |
| 11 tests | 185 | 212 | 268 | 103 |
| 12 readme | 99 | 85 | 47 | 97 |
| 13 review | 274 | 174 | 198 | 316 |
| 14 highscores | 434 | 154 | 543 | 463 |
| 15 final | 75 | 147 | 186 | 78 |

## Prompt cache

Per-call `cachedInputTokens` from the rollout, two-step smoke, same task, same model:

| | main before #2147 | with #2147 |
| --- | --- | --- |
| consecutive request pairs with an unchanged prefix | 0 of 10 | 7 of 7 |
| first call of turn 2 | 0 cached of 25046 | 20736 cached of 24432 |
| hit ratio after the session's first call | 55 to 92% with drops to 512 or 0 | 78 to 88%, no drops |

In the 15-step SDK session the remaining misses were the first call of a turn right after a memory-extraction
run rewrote MEMORY.md, which sits at the head of the prompt (#2154 keeps that head stable for the session),
and a few mid-turn re-projections that shrink older tool results (open).

## Reading

- On single prompts AgenC is faster than Hermes at the same pass rate: 312 s against 577 s at xhigh and 313 s
  at medium, so reasoning effort does not drive single-task latency; the per-call overhead does.
- On the 15-step session both pass every step. Like for like at medium effort, AgenC finished in 1275 s against
  Hermes's 2203 s, 42% less wall time, with 140 tool calls, no tool errors and 3 re-reads in 48 file reads. At
  xhigh AgenC took 2367 s over the SDK and 1972 s through the desktop app, so reasoning effort, not the harness,
  sets the session's pace: the medium run's steps were 31 to 212 s, the xhigh run's 32 to 543 s.
- Token cost did not move with effort: 24.9M input tokens at medium against 25.1M at xhigh, both with the prompt
  cache holding (118k of 123k prompt tokens cached on the last call of the medium run).
- AgenC's own numbers moved today: 27% fewer input tokens and 33% fewer tool calls on the session than this
  morning's baseline, the re-read ratio from 22% to 6%, and the prompt cache holding across turns.
- What the runner cannot see for Hermes: tokens, tool calls, tool errors, re-reads, compactions. Hermes prints
  no usage in headless mode and the runner does not read its transcript.

## Fixes that came out of running this

- #2142: a provider error ended the whole session; now the turn fails and the session lives.
- #2147: attachments moved every request; the prompt cache never held. A per-session ledger keeps them in place.
- #2150: the daemon inherited the working directory of the CLI that spawned it; a deleted eval workspace made
  every later child spawn fail with ENOENT, surfaced as a Keychain error.
- #2148: the runner runs session tasks through any agent's CLI, one step per command; the trust record is locked
  against concurrent runners; the report directory is created.
- #2154: the instruction head (AGENC.md tiers, MEMORY.md indexes) stays byte-stable for the session; changes ride
  as one update reminder.
- #2156: microcompaction clears tool results in pressure batches with position-based labels, so a projection is a
  function of the history and the cached prefix breaks once per batch instead of once per call.
