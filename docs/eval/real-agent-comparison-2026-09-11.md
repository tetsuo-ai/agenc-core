# Real-agent comparison: AgenC, Hermes 0.21.2 and OpenCode 1.18.30, 2026-09-11

Same 13 tasks as the September 4 report (`runtime/eval/tasks`: 12 single-prompt command tasks and the 15-step
`asteroid-drift-15` session), same deterministic verifiers, same Mac, run back to back the same evening. Every agent
runs headless from an isolated home: AgenC through `agenc -p` in an isolated `AGENC_HOME` (session task over the
AgenC SDK), Hermes 0.21.2 (tag v2026.9.11, run from a git checkout in its own venv and `HERMES_HOME`) through
`hermes chat -Q --yolo --provider <p> -m <model> --reasoning medium -q <prompt>` (`-c` on later steps), OpenCode 1.18.30
(npm package, `XDG_*_HOME` isolated) through `opencode run --auto -m <provider>/<model> <prompt>` (`--continue` on later
steps). `runtime/scripts/compare-agents.sh` runs all of it; `runtime/scripts/eval-compare-table.mjs` prints the tables.
Keys never touch an argv: each agent gets one provider key through `env -i`.

## Command tasks (12 single prompts)

| model, effort medium | AgenC 0.17.0 (main 0245ef4fe) | Hermes 0.21.2 | OpenCode 1.18.30 |
| --- | --- | --- | --- |
| grok-4.6, xAI sign-in (OAuth) | 12 of 12, 233 s (11 to 27 s per task) | no xAI OAuth support | no xAI OAuth support |
| grok-4.6, xAI API key | 11 of 12, 486 s (see below) | key out of credit before its run | key out of credit before its run |
| Claude Sonnet 5 | 12 of 12, 125 s (7 to 17 s) | 12 of 12, 129 s (7 to 14 s) | 5 of 5 completed, 141 s (21 to 34 s); the key ran out of credit on task 6 |
| DeepSeek V4 Pro | 12 of 12, 192 s (11 to 24 s) | 12 of 12, 173 s (9 to 19 s) | 12 of 12, 587 s (24 to 86 s) with the operator's real HOME; isolated HOME: see below |

The grok API key run lost one task to a transient xAI 403: the turn failed after 1.5 s and `agenc -p` then sat until the
runner killed it at 120 s (issue filed). Minutes later the same key answered 403 "team has used all available credits" to
every call, which is why Hermes and OpenCode have no grok row; the xAI sign-in is only available to AgenC.

## 15-step session (asteroid-drift-15)

| agent, model | steps passed | wall | tool calls | tool errors | file reads (re-reads) | compactions | input tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AgenC, grok-4.6 (xAI sign-in) | 15 of 15 (verifier 1 of 1) | 1174 s | 188 (Edit 74, FileRead 71, Write 15, exec 12, Grep 10, Glob 5) | 0 | 71 (24) | 0 | 28.9M |
| Hermes 0.21.2, DeepSeek V4 Pro | 15 of 15 (verifier 1 of 1) | 1772 s | 94 (write_file 32, patch 25, terminal 21, read_file 10, search_files 6) | not reported | 10 (not reported) | not reported | 5.25M (70,872 uncached, 5.18M cache reads); 169k output, 132k reasoning |
| OpenCode 1.18.30, DeepSeek V4 Pro (isolated HOME) | PENDING | | | | | | |

Per-step wall time for AgenC on grok-4.6 (seconds): 34, 28, 39, 37, 48, 51, 49, 74, 41, 46, 128, 50, 270, 239, 39.
Per-step wall time for Hermes 0.21.2 on DeepSeek V4 Pro (seconds): 36, 33, 46, 34, 84, 64, 76, 141, 84, 92, 177, 78, 388, 265, 173.
For reference, the September 5 like-for-like run at medium effort took 1275 s for AgenC and 2203 s for Hermes 0.14.

AgenC's session task over the AgenC SDK needs the provider credential in the home's secure storage (the xAI sign-in
works); an environment-provided key is not visible to SDK-created sessions, and `agenc -c -p` is refused ("--continue
requires an interactive" session), so no same-model DeepSeek session could be run for AgenC tonight. Both are filed.

## What the prompt costs per call

Read from AgenC rollouts (`token_count` events) and from Hermes's `sessions` table and OpenCode's `message` table.

| Claude Sonnet 5, 12 command tasks | AgenC | Hermes 0.21.2 | OpenCode (operator's HOME) |
| --- | --- | --- | --- |
| model calls | 47 (3.9 per task) | 52 (4.3 per task) | 26 for 5 tasks |
| tool calls | 38 | 44 | 21 for 5 tasks |
| uncached prompt tokens per call | 919 | 2 | about 2 |
| cached prompt tokens per call | 23,954 | 18,831 | about 264,000 |
| cache-write tokens per call | 3,048 | 1,053 | about 66,000 |
| output tokens | 4,651 | 5,305 | 3,194 for 5 tasks |
| cost per task (provider price) | about $0.08 | about $0.05 | $1.03 to $1.23 |

OpenCode's figure is not the tool's fault: with the operator's real HOME it loads `~/.claude/skills` (1,823 entries),
`~/AGENTS.md` and `~/CLAUDE.md` into every request, about 204,000 input tokens for a one-word reply. With an isolated
HOME the same reply costs 5,516 tokens. The rerun with an isolated HOME is the row that counts.

| DeepSeek V4 Pro, 12 command tasks | AgenC | Hermes 0.21.2 |
| --- | --- | --- |
| model calls | 53 | 57 |
| tool calls | 46 | 54 |
| cache-miss prompt tokens per call | 25,623 | 2,896 |
| cache-hit prompt tokens per call | 14,628 | 11,758 |

AgenC's 25,600 miss tokens per call were a bug, found by capturing two consecutive requests through a logging proxy:
the retained "Auto Mode" note moved from the second message of the first request to the end of the second request in
`acceptEdits` and `bypassPermissions`, so DeepSeek and grok saw a new prefix on every call and Anthropic re-created about
4,000 cache tokens per call. Fixed in #2407: on the fixed build the second request reports 24,960 cache-hit tokens and
193 miss. The skills listing that sat behind the moved note is 40,584 chars (about 10,000 tokens) on 1M-context models;
#2408 caps it at 12,000 chars.

## Reading

- Pass rates are equal wherever all three agents ran: 12 of 12 for AgenC and Hermes on both Sonnet 5 and DeepSeek V4
  Pro, and 12 of 12 for OpenCode on DeepSeek V4 Pro.
- Wall time on the command tasks is within 5 percent between AgenC and Hermes on Sonnet 5 (125 s against 129 s) and 10
  percent on DeepSeek V4 Pro (192 s against 173 s); the DeepSeek gap is the cache bug above, which the fix removes.
- AgenC makes fewer model calls and fewer tool calls per task than Hermes on both models.
- AgenC's prompt is larger than Hermes's: about 24,000 cached tokens per call against 19,000, the difference being the
  skills listing and the 46 KB tool catalog (spawn_agent alone is 10 KB).
- On the session task AgenC finished the 15 steps on grok-4.6 in 1174 s with no tool errors and no compaction.
