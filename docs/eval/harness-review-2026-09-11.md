# Harness review after the 2026-09-11 benchmark: speed, tokens, tool use, safety

Companion to `real-agent-comparison-2026-09-11.md`. Everything here is measured on that run or read from the code at
main 0245ef4fe; each item says what was done or what remains.

## Where AgenC already leads

- Fewer model calls per task than Hermes 0.21.2 (3.9 against 4.3 on Sonnet 5) and fewer tool calls (38 against 44
  over the 12 command tasks); zero tool errors and zero compactions across the 15-step session.
- Session pace: 1174 s for the 15 steps on grok-4.6, against 1275 s for the same build on September 5 and 2203 s for
  Hermes 0.14 then. Hermes 0.21.2 finished the same 15 steps on DeepSeek V4 Pro in 1772 s with 62 model calls and 94
  tool calls (different model, so a pace reference rather than a like-for-like number).
- Sign-in without keys (xAI, ChatGPT, managed route) is something neither Hermes nor OpenCode offers for grok.

## Fixed during the review

1. **Prompt cache broken in acceptEdits and bypassPermissions** (core #2407). The retained "Auto Mode" note was kept
   only for mode `auto`, so in the other two autonomous modes it was dropped from its place and re-emitted after the
   newest history item on every request. DeepSeek and grok saw a new prefix each call (25,600 cache-miss tokens per
   call); Anthropic re-created about 4,000 cache tokens per call. After the fix the second request in a turn reports
   24,960 hit and 193 miss on DeepSeek. The grok session spent 28.9M input tokens with the bug; expect most of it to
   move to the cached price and to shorter prefill.
2. **Skills listing sized at one percent of the context window** (core #2408). 40,584 chars on every request of every
   session on 1M-context models; capped at 12,000 chars, env override kept.
3. **Internal-build gates removed** (core #2405): no `USER_TYPE` switch can flip internal code paths any more.
4. **Plugin catalog no longer invented** (desktop #265).

## Token budget per call, and what is left to cut

Measured on Sonnet 5: about 24,000 cached prompt tokens per call against Hermes's 19,000. The pieces:

| piece | size | status |
| --- | --- | --- |
| system prompt | 21,215 chars (about 5,300 tokens) | fine |
| tool catalog, 38 tools | 46,470 bytes (about 11,500 tokens) | next: see below |
| skills listing | 40,584 chars (about 10,000 tokens) | capped to 12,000 chars by #2408 |
| agent list, auto-mode note | about 3,200 chars | fine, now cached |

Next cuts, in order of return:
- `spawn_agent` is 10,154 bytes of the catalog on its own, `Grep` 4,105, `exec_command` 3,064. Moving the usage
  guidance out of the tool description into the system prompt and keeping the schema minimal saves about 2,500 tokens
  per call.
- Defer the tools a coding turn rarely touches (`spawn_agents_on_csv`, `show_csv_job_review`, `Orient`, `write_stdin`,
  `list_agents`, `close_agent`) behind `system.searchTools`, which already exists for MCP and plugin tools: about
  1,000 to 1,500 tokens per call.
- Add a regression test that projects two consecutive requests of one turn and asserts a byte-identical prefix, so the
  class of bug in #2407 cannot come back silently.

## Tool use

- Re-reads: 24 of 71 file reads in the grok session were repeats (34 percent; the September 5 SDK run had 6 percent).
  A "you read this file N tool calls ago, unchanged" hint on FileRead, or serving the cached content, would remove most
  of them.
- `Edit` failed three times in one Sonnet task before succeeding (string not found). Returning the nearest matching
  lines in the error would make the retry cheaper.
- Headless continuation: `hermes chat -c` and `opencode run --continue` resume a session from a shell; `agenc -c -p`
  is refused because `--continue` is TUI-only, and SDK-created sessions do not see an environment-provided provider
  key (only secure-storage credentials work). Both block scripted use and the benchmark's session lane on any provider
  without a sign-in.
- `agenc -p` did not exit after its only turn failed on a transient provider 403 (issue filed): print mode must fail
  fast.

## Safety posture

- Every tool result is framed as untrusted workspace data; the shell tools carry a deny list for dangerous patterns and
  the auto-mode classifier; bypass mode needs recorded per-workspace consent; keys never travel on an argv; client
  environments are forwarded through an allowlist (and `USER_TYPE` left it in #2405).
- The OS sandbox (Seatbelt, Landlock, bubblewrap) is opt-in through `sandbox_mode`, and the only headless bypass flag is
  `--dangerously-bypass-approvals-and-sandbox`, which drops both. Recommendation: a mode that bypasses approvals but
  keeps the sandbox, and make it the default for autonomous runs on macOS and Linux.
- Hermes 0.21 ships a command scanner (tirith), security scanning on skill installs and consent-gated real-profile
  browsing. AgenC has publisher trust for plugins and Keychain storage; scanning skills and plugins at install time is
  the gap worth closing first.

## Benchmark hygiene

- Provider keys run dry mid-benchmark (xAI, then Anthropic) and the affected rows say so; the DeepSeek key is the
  reliable one for full runs.
- OpenCode must run with an isolated HOME: with the operator's real HOME it ingests 1,823 Claude skills and two global
  instruction files, about 204,000 input tokens per call.
