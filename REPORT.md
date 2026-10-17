# Reasoning-only caps on native DeepSeek (AgenC Light) — 2026-10-10

Research branch `research/reasoning-caps-2026-10-10`, off main `fdd18bfc`
(0.19.0 prep). No PR. Two default-off settings, unit tests, docs. Nothing in
the default path changes bytes on the wire.

Question: on the 30 hardest Terminal-Bench 2.0 tasks with DeepSeek V4.1 Flash
(thinking on, `reasoning_effort: high`, `max_tokens: 8192`, streaming), Light
ends 12.9% of calls (264/2045) with all 8,192 output tokens spent on
`reasoning_content` and no text or tool call; Pi ends 2.5% (34/1339). Each costs
37–43 s and Light's median agent time is 341 s against Pi's 137 s. Variants B
(replay the capped reasoning tail on the recovery turn) and C (retry at low
effort with thinking on) did not help.

## 1. Diagnosis

Read from main: `runtime/src/recovery/max-output-tokens.ts`,
`phases/stream-model.ts`, `phases/post-sample-recovery.ts`,
`llm/wire/chat-completions.ts`, `llm/wire/capability-gating.ts`,
`llm/messages.ts`, `session/run-turn-query-messages.ts`,
`session/runtime-message-conversion.ts`, `phases/completion-gate.ts`,
`phases/continuation-nudge.ts`, `prompts/light-budget-prompt.ts`,
`tools/light-profile.ts`, `tools/light-presentation.ts`, plus DeepSeek's
thinking-mode guide (fetched 2026-10-10).

### 1.1 What the model is working with

DeepSeek's thinking mode with `tools` is one reasoning process across the
whole tool loop. The guide: with tools present, "the `reasoning_content` of
all previous turns should be passed back to the API and will be concatenated
into the context"; "the `reasoning_content` must be fully passed back to the
API in all subsequent requests"; the tool-call sample is described as
"allowing the model to continue its previous reasoning". The replayed chain
is the model's working memory. A turn without `reasoning_content` is a hole
in that memory; the next thinking call has to rebuild state from the visible
transcript.

Pi sends reasoning on 96–98% of prior assistant turns and reasons ~279 tokens
per useful call. Light sends it on 70–80% and reasons ~100 tokens on the
median call, then 13% of calls run away. Light's chain has holes; Pi's does
not.

### 1.2 Where Light's holes come from (all self-inflicted)

1. **Every cap recovery creates a hole and a user turn.** On a reasoning-only
   cap with an explicit `max_output_tokens` (the benchmark's 8192),
   `runMaxOutputTokensRecovery` cannot escalate (`escalateAllowed` requires a
   capped default and no explicit budget), so it always takes the
   continuation path: it appends `RETRY_REASONING_ONLY_CONTENT` as a plain
   `role: "user"` message and sets `reasoningOnlyRecoveryPending`, which the
   next sample turns into `thinking: {type: "disabled"}`. That sample returns
   no `reasoning_content`; `isKnownEmptyProviderReasoning` stores and replays
   `""` so the API accepts the history. The result in the model's context is
   an assistant turn with an empty think block, preceded by a new "user"
   request. With 264 caps over ~1,780 productive calls, thinking-off turns
   alone are ~15% of the assistant turns Light replays, which with the
   model's own empty-reasoning turns matches the measured 20–30% gap.

2. **The capped reasoning is thrown away.** The capped sample is pushed to
   history as `{role: "assistant", content: "", providerReasoningContent}`
   with no tool calls (`stream-model.ts`), and `normalizeMessagesForAPI` drops
   every empty assistant message that is not last, so those 8,192 tokens
   never reach the wire again; the escalate path drops them explicitly
   (`removeTruncatedAssistantForRetry`). The model then re-derives the same
   step on its next thinking call, against a transcript that now also has a
   hole and a user interjection. That is the cascade: 52% of post-recovery
   calls cap again against a 12.9% base rate. At 52% the expected number of
   caps per initial cap event is 1/(1−0.52) ≈ 2.1, so roughly half of all
   caps (~135 of 264) are cascade caps, worth ~90 min of model time across
   the 30 tasks.

3. **Variant B and C results fit this.** B attached the *tail* of the capped
   reasoning (the runaway part, mid-analysis) to a turn whose action was
   chosen without it; the hole and the user turn stayed, and the model either
   continued the runaway or ignored the tail. C replayed the same context at
   low effort with thinking on and still capped 67% of the time: the step
   needed more than 8k tokens at any effort, so the cap at that step is a
   budget problem, not an effort problem. Both say the fix is on the first
   retry: keep thinking on, give that one step the room it needs, keep the
   chain intact, and add no user turn.

4. **Runtime context reaches native DeepSeek as new user requests.** Native
   DeepSeek's wire hints replay reasoning fully but do not set
   `runtimeContextInToolResults`; only the managed (OpenRouter) DeepSeek route
   has it, after observing that "a standalone user-role reminder started a new
   turn on the hosted route and the model repeatedly abandoned the actual
   task" (`docs/providers/deepseek-direct.md`). On the native route every
   per-turn reminder (`edited_text_file` after a build or formatter touches a
   read file, skill and memory reminders, repeat-tool advisories, hook
   context), the retry instruction, the continuation nudge, the empty-response
   retry and the completion gate's checklist request arrive as user turns in
   the middle of the tool loop. Side finding: the query projection
   (`projectRuntimeOnly` in `session/runtime-message-conversion.ts`) keeps
   only `toolResultIntegrity` and `agentInvocation`, so even on the managed
   route the in-history `user_context` messages (advisories, hook context)
   lose their boundary and are sent as plain user turns; only
   attachment-rendered reminders fold today.

5. **The completion gate is a reasoning burst by design.** Light's
   non-interactive runs inject `<completion_gate>` when the model first
   answers: write an acceptance checklist for every requirement of the quoted
   task, run every check, answer again. Up to three rounds. That is a
   re-verify-everything step on the hardest tasks, exactly where runaway
   reasoning shows up. Pi has no such step. Expect a visible share of Light's
   caps on the call right after a gate message; it is also plausibly part of
   why Light solves 12 to Pi's 7.

6. **Not the cause, checked:** context size (Light 33k/call, Pi 47k: smaller
   and still worse), the prompt (the Light head is ~2.6k chars with no
   planning or step-by-step instruction; nothing in it asks for long
   deliberation), tool count and descriptions (five lean tools; `exec_command`
   shows three fields), tool-result framing (compact `AGENC_DATA` boundaries,
   output first, one-line exit footer), request parameters (`thinking`
   enabled, `reasoning_effort: high`, no `tool_choice`, no temperature, no
   `parallel_tool_calls`, same `max_tokens`). Microcompaction clears tool
   results only past 120k characters of live output, above Light's per-call
   context, so it is not shortening what the model sees. One nit: the head
   says "Batch independent calls" while native DeepSeek omits
   `parallel_tool_calls`; harmless.

### 1.3 The causal chain in one line

Explicit 8192 → no escalation → cap recovery disables thinking and adds a
user turn → hole + discarded analysis → next thinking call re-derives the
step from a fragmented transcript → caps again (52%) → more holes and quick
empty-reasoning turns → the next hard step has no incremental chain to
continue and does all its thinking at once → another cap.

## 2. Ranked fixes

| # | Fix | Mechanism | Expected effect | Risk | Cheap test |
| --- | --- | --- | --- | --- | --- |
| 1 | `reasoning_cap_recovery = "escalate_thinking"` (implemented) | On a reasoning-only cap, resend the capped request unchanged with thinking on at 3× the limit (24,576), no instruction appended, not a counted retry. The step gets the room C showed it needs; its reasoning is stored and replayed; no hole, no user turn, no cascade. A second cap in that retry falls back to today's thinking-off sample at 8192. | Post-recovery re-cap 52% → ≤15–20% if most runaways finish under 24k; total caps −40…−55%; median agent time −20…−35%; solves flat to up (the model thinks on the hard step instead of acting blind). Tokens +5–10%. | True loops cost up to 24k tokens (~2 min) once per cap event; bounded by the fallback and the task budget. Overrides an explicit per-call budget, hence opt-in. | Offline replay R2 below, then panel arm B. |
| 2 | `runtime_context_in_tool_results = true` (implemented) | Native DeepSeek gets the managed route's layout: runtime context after a tool result (reminders, advisories, hook context, the retry instruction) rides inside that tool result as `<runtime-context>`, so the template sees a tool continuation, not a new request. The retry instruction is marked runtime context and the projection keeps that marker. | Fewer re-plan bursts after reminders and after a recovery; the thinking-off turn reads as part of the same request. Smaller than #1; mostly reduces initial caps that follow a reminder. | Consecutive runtime context messages all fold into one tool result; human messages never fold. Durable history unchanged. | Log analysis L1 (cap rate on the call after a user-role runtime message vs after a tool result), then panel arm C. |
| 3 | Completion gate arm: `completion_gate.mode = "never"` or `max_rounds = 1` for the benchmark | Removes the end-of-task re-verification burst. | Fewer caps in the last calls of a task; may cost solves (the gate is a verification driver). | Pi-parity measurement only, not a product change. | Count caps on gate-following calls in the raw runs; if ≥10% of caps, run panel arm D. |
| 4 | Variant D (abort the stream past ~5k reasoning tokens) | Cost cutter per cap; does not remove holes. | −35% per-cap cost. Combine with #1 only if replay shows most runaways exceed 24k. | Aborting at 5k wastes 5k and forces the retry; the escalate retry then starts from zero. | Already running. |
| 5 | Quick-turn check | If the model's empty-reasoning turns cluster right after thinking-off turns, they are an in-context imitation of the recovery and #1 removes the cause. | Explains the 17–23% vs 5.9% quick-turn gap. | None; measurement. | Log analysis L2. |
| 6 | Longer term: raise the per-call limit for thinking models | DeepSeek's thinking default is far above 8k; `docs/providers/deepseek-direct.md` already warns the 8,192 pilot setting truncates reasoning. The benchmark pins it for fairness; the product should not. | Removes most initial caps outside the benchmark. | Fairness vs Pi in the comparison; cost per runaway. | Panel arm with 16,384 for both harnesses if Pi can be configured the same. |

Not recommended: prompt edits (no evidence of a prompt cause), further
low-effort or thinking-off variants (C showed the step needs the budget),
fabricating reasoning for the recovery turn (the template treats it as the
model's own chain; B already showed replayed partial reasoning does not help).

## 3. What was implemented

Both settings are top-level `config.toml` keys, strict-validated, mapped into
the session `Config` by `bootstrap.ts`, and documented in
`docs/reference/config.md`, `daemon.md`, `ARCHITECTURE.md`, `providers.md`.
Unset means today's behaviour; the default wire bytes are unchanged (the
existing recovery and policy suites pass unmodified).

### `reasoning_cap_recovery` (`thinking_off` | `escalate_thinking`) and `reasoning_cap_escalate_max_output_tokens`

`runtime/src/recovery/max-output-tokens.ts`: `resolveReasoningCapEscalation`
computes the retry ceiling (configured value, else 3× the per-call limit,
bounded by the model upper limit and the 64k escalate ceiling; a ceiling at or
below the limit disables the retry). `runMaxOutputTokensRecovery` gained a
step before the existing escalate step: on a reasoning-only cap on native
DeepSeek, with no override active and no counted thinking-off retry pending,
it sets `maxOutputTokensOverride`, cuts history back to
`messagesAtSampleStart` (the same cut the existing escalate path uses), keeps
thinking on, appends nothing, emits warning `reasoning_cap_escalation`
(`fromMaxOutputTokens`, `toMaxOutputTokens`, `reasoningOutputTokens`), and
returns `escalate`. The override is cleared by commit after the iteration, so
a later cap after a productive sample escalates again. A second cap in the
retry sees the override and takes the thinking-off continuation at the
configured limit. Exhaustion still happens through the three counted
thinking-off retries. `post-sample-recovery.ts` passes the resolved
escalation into the recovery.

### `runtime_context_in_tool_results` (boolean)

`llm/types.ts` adds `LLMChatOptions.runtimeContextInToolResults`;
`phases/stream-model.ts` sets it for native DeepSeek when the key is on;
`llm/wire/chat-completions.ts` applies the existing
`projectRuntimeContextIntoToolResults` projection when either the provider
hint (managed route) or the option asks for it. The retry instruction is
created as runtime context (`reasoningOnlyRetryMessage`) under the switch, and
`session/run-turn-query-messages.ts` restores the `user_context` boundary on
the query projection for in-history runtime context (the projection is one
message to one message; a projection of a different shape is left alone).
Human messages, agent-invocation channels and canonical history are untouched.

Telemetry to count in rollouts: `reasoning_cap_escalation` (new),
`thinking_disabled_recovery` (existing), `token_count.reasoningOutputTokens`.

### Harness switches

```
agenc config set reasoning_cap_recovery escalate_thinking
agenc config set reasoning_cap_escalate_max_output_tokens 24576   # optional
agenc config set runtime_context_in_tool_results true
```

## 4. Validation

Node 26.11.1 with npm 11.17.0 (the container ships Node 22; the repo pins
`devEngines`), dependencies installed with `npm ci`.

- `npm --workspace=@tetsuo-ai/runtime run typecheck` (sources and
  test-support projects): passed.
- New tests, 2 files, 21 tests, all passing:
  `runtime/tests/session/reasoning-cap-escalate-thinking.test.ts` (config
  validation, ceiling resolution, escalate-then-productive, second cap falls
  back to thinking-off at the configured limit, repeated events re-arm,
  exhaustion still bounded, default and explicit `thinking_off` unchanged,
  explicit ceiling and model upper limit, visible-output caps unaffected) and
  `runtime/tests/session/runtime-context-in-tool-results.test.ts` (route
  predicate, wire projection on and off, human messages never fold, option
  gated to native DeepSeek, retry instruction folded into the last tool
  result end to end, separate user message with the switch off, first-call
  cap keeps its own user message).
- Affected existing suites, 17 files, 489 tests, all passing:
  reasoning-output-recovery, reasoning-cap-policy(-wire), recovery-thinking-off,
  productive-recovery-state, recovery/max-output-tokens(+docs contract),
  config-reference-coverage, strict-schema-validation, config,
  wire/chat-completions, deepseek provider empty-reasoning, agenc deepseek
  promotion, post-sample-recovery token-budget cap, durable-checkpoint-reader
  upgrade, env-documentation-coverage, config-authority-residue.
- Wider safety batch through the hermetic runner, 64 files, 1,281 tests,
  all passing: `tests/recovery`, `tests/phases`, `tests/llm/wire`,
  `tests/session/run-turn.test.ts`, `run-turn-query-messages`,
  `attachment-retention`, `tests/bin/bootstrap.test.ts`.
- `git diff --check` clean. No full-suite result is claimed.

No live model call was made; the effect sizes above are estimates from the
measured rates, not results.

## 5. Experiment plan

Offline first (no containers, one request per sample, from the raw runs):

- **R1 baseline.** Resend the 264 capped requests unchanged (thinking on,
  high, 8192). Expect a re-cap rate near C's 67%.
- **R2 escalation (decides fix #1).** Same requests at `max_tokens` 16,384,
  24,576 and 32,768. Record finish reason, total reasoning tokens and wall
  time. If ≥70% complete by 24,576 with a tool call or answer, the
  `escalate_thinking` retry pays for itself; if most run past 32k, prefer D
  plus a smaller escalation.
- **R3 layout (decides fix #2).** For capped requests whose last messages
  include a user-role runtime message after a tool result, resend with that
  message folded into the tool result as `<runtime-context>` at 8192. Compare
  cap rate with R1.
- **R4 classify the capped reasoning** (text only): drafting code or file
  contents, enumerating or verifying, repetition loops (n-gram repeats),
  re-deriving earlier tool results. The drafting share says how much #6 would
  give; the re-deriving share is the cascade.
- **L1/L2 log analysis** (no model calls): per call, whether the previous
  message was a user-role runtime message, turns since the last thinking-off
  turn, count of empty-reasoning turns in the last five, whether a completion
  gate message precedes it, size of the last tool result. Contingency tables
  against cap and against empty reasoning.

Then the 28-task panel, one run per task per arm: A main, B
`escalate_thinking`, C B + `runtime_context_in_tool_results`, D C + completion
gate limited. Report cap rate, post-recovery re-cap rate, reasoning pass-back
rate (target ≥95%), quick-turn rate, median agent time, tokens, solves.

## 6. Not done

No live calls, no benchmark runs, no change to defaults, no PR. The
projection side finding in 1.2(4) (in-history `user_context` boundaries lost
for every route) is left as is outside the switch; it deserves its own fix
once the managed-route tests cover in-history advisories.
