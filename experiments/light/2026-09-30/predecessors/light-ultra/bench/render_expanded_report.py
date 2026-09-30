from pathlib import Path
import json
r=Path('/private/tmp/light-ultra');d=json.loads((r/'evidence/expanded-comparison.json').read_text())
def f(x,n=0):return 'unknown' if x is None else f'{x:,.{n}f}'
def table(rows,task=False):
 rows_text=['| '+('Task | ' if task else '')+'Model / agent | Effective | Tokens/task | Median / p90 s | Calls/task | USD |','| '+('--- | ' if task else '')+'--- | ---: | ---: | ---: | ---: | ---: |']
 for x in rows:
  money='unpriced' if x['model']=='gpt-6-luna' else (f(x['cost'],6) if x['cost'] is not None else '>='+f(x['observed_cost'],6))
  rows_text.append('| '+(x['task']+' | ' if task else '')+f"{x['model']} / {x['agent']} | {x['pass']}/{x['n']} | {f(x['tokens'])} | {f(x['median'],1)} / {f(x['p90'],1)} | {f(x['calls'],2)} | {money} |")
 return '\n'.join(rows_text)
heads=json.loads((r/'evidence/expanded-first-heads.json').read_text())['runs']
head_lines=['| Model / agent | System bytes | Schema JSON bytes | System / schema raw tokens |','| --- | ---: | ---: | ---: |']
def span(xs,k):
 vals=sorted({x[k] for x in xs if x.get(k) is not None})
 return str(vals[0]) if len(vals)==1 else str(vals[0])+'–'+str(vals[-1]) if vals else 'unknown'
for model in ('deepseek-flash','deepseek-v4-pro','gpt-6-luna'):
 for agent in ('pi','normal','light'):
  xs=[x for x in heads if x['model']==model and x['agent']==agent]
  if xs:head_lines.append(f"| {model} / {agent} | {span(xs,'system_bytes')} | {span(xs,'schema_bytes')} | {span(xs,'system_raw_tokens')} / {span(xs,'schema_raw_tokens')} |")
iterations=json.loads((r/'evidence/iterations.json').read_text())['rows']
screen=['| Candidate / model | Effective | Tokens/task | Median / p90 s | Calls/task | Cost USD |','| --- | ---: | ---: | ---: | ---: | ---: |']
for x in iterations:
 if x['phase'] in ('candidate-brief-subset','candidate-rel-subset','candidate-act-subset'):
  screen.append(f"| {x['phase']} / {x['model']} | {x['effective']}/{x['runs']} | {f(x['mean_tokens'])} | {f(x['median'],2)} / {f(x['p90'],2)} | {f(x['mean_calls'],2)} | {f(x['cost_usd'],6)} |")
lines=['# AgenC Light comparison','',
'**Light does not meet the owner’s acceptance target. Keep it default-off and experimental.**','',
f"Snapshot: {d['snapshot']}. Effective completion requires both agent completion and a passing grader. All failures remain in the results. A full model comparison requires 24 cells per agent: 12 frozen tasks, two repeats.",'',
'## Main comparison','',table(d['aggregates']),'',
'The DeepSeek comparison is complete. Light uses production revision `11e51dcc1`; Pi and normal mode reuse the original baseline. Test-only tip `6c4c68431` does not change that benchmark source. Two Light task 06 cells failed before a model call because a long benchmark directory produced an invalid UNIX socket path. Three other Pro cells timed out despite passing artifacts. None was rerun or removed. Excluding task 06 from both agents still leaves a slower Flash median and worse Pro completion, tokens and time.','',
'Luna uses low reasoning and the same tasks and graders. The study stopped at **269 of 600 allowed attempts**, with **29 of 48 main cells available** and 19 unstarted. This includes two earlier successful Pi cells. Repeated upstream HTTP 503 responses affected both agents after three cooldown resumes. The local health endpoint remained healthy, but model serving was unreliable. The owner’s proxy was left running unchanged. Only the job’s idle relay and queued control were stopped.','',
'Luna rows with missing usage show unknown tokens. Among six matched task/repeat pairs with complete usage, Pi completed 6/6 at 43,350 tokens and a 41.23 s median; Light completed 5/6 at 24,446 tokens and a 55.60 s median. This sensitivity analysis also fails the target and cannot replace the incomplete main comparison. Luna normal mode was outside the owner’s expanded Pi-versus-Light request.','',
'## Per-task results','',table(d['tasks'],True),'',
'## Fixed prefix and measured costs','', '\n'.join(head_lines),'',
'Bytes are exact UTF-8 system text and compact schema JSON. DeepSeek raw tokens use its official tokenizer. Luna raw tokens use a labeled o200k_base reference estimate; its exact tokenizer is unavailable. On completed Light Luna first calls, provider attribution reports 140 instruction tokens plus 294 tool tokens. Raw estimates are not billed component counts. Per-run hashes, names and first-input totals are in [expanded-first-heads.json](evidence/expanded-first-heads.json).','',
'The final DeepSeek Light prefix is 611 raw tokens versus roughly 1,210 for Pi. Across Flash tasks, Light saves about 10,481 repeated-prefix tokens, 14,884 history tokens and 429 reasoning tokens per task, but adds 9.5 seconds of tool-plus-runtime time. On Pro it saves 10,388 prefix tokens while adding 109,149 history tokens and 2,566 reasoning tokens. The remaining gap is therefore driven by calls, growing history and reasoning, not initial prefix size alone.','',
'Every completed run has a decomposition in [STATUS.md](STATUS.md) and [decomposition.json](evidence/decomposition.json): N, P, summed history residual, largest results with positions, visible and reasoning output, observed first-token/generation timing, tool duration estimates, runtime residual and deltas against Pi. H* = provider input − N×P includes provider framing and schema growth. The accounting identity is exact where usage is complete; component attribution remains diagnostic. Historical Pi lacks separate tool timing and stream timestamps, so those values are unavailable rather than zero.','',
'## Changes and later screens','',
'- Four independently written core tools and a short fixed prompt. Optional capabilities load on demand; explicitly requested capabilities receive one notice after the core result batch. No mandatory plan, reminder turn or extra verification round trip.',
'- Bounded reads and command output, with retrievable references for oversized new captures. Compact workspace result frames reduce repeated metadata. Existing messages retain their bytes.',
'- Coalesced derived-index work and faster command completion settling. Canonical durability, permissions, sandbox checks, freshness and effect receipts remain enforced in the runtime.',
'- Stable schema order and a full cached catalog were measured separately. The full catalog used 13,723 raw prefix tokens and lost the combined screen. Deferred schemas remain selected. Polling was uncommon, so a broad wakeup rewrite was not supported by the measured gap.','',
'Later screens retain the same tasks and graders; they are not pooled into the main comparison. Brief and required-actions use tasks 03/07/09/12; relative paths uses 07/09/12. Each has one repeat per model.','', '\n'.join(screen),'',
'The brief prompt reduced Pro reasoning to 5,595 tokens per task but lost the requested planning action on Flash task 12. Relative paths addressed a measured path error, but Pro still timed out. The required-actions screen recovers 8/8 completion, but both models exceed Pi mean tokens and Flash has a slower p90. It remains unselected. [FINAL-LEVER-EVIDENCE.md](FINAL-LEVER-EVIDENCE.md) records the rationale and tradeoffs for each lever. These experiments do not prove that every future design is exhausted.','',
'## Reasoning replay','',
'DeepSeek requires prior reasoning content in requests containing tools. Removing it would break the provider contract, so it remains included. The brief-prompt experiments instead measure reductions in generated reasoning. [DeepSeek documentation](https://api-docs.deepseek.com/guides/thinking_mode/).','',
'AgenC’s optional OpenAI replay was already disabled. Luna main runs explicitly keep it off. Later responses contain opaque reasoning state; encrypted bytes are counted separately and are never tokenized as plaintext reasoning. The planned replay-on control could not start because model serving remained unstable. Its token, time and completion effect is **unmeasured**, and no causal replay-off benefit is claimed. [OpenAI reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning).','',
'## Validation and pull requests','',
'Core main: 31,236 passed, 27 failed, 11 skipped. Corrected candidate: 31,316 passed, 27 failed, 11 skipped, with exactly the same failure identities and zero new failures. Source and test-support typechecks pass. Earlier failed runs and their fixes remain recorded. Desktop main: 5,237/1/32; candidate: 5,238/1/32, with the same existing failure and zero new failures. Desktop typecheck passes. Linux harness checks: 42 passed, plus transport self-test and task oracle controls. No test suite or benchmark ran on the Mac.','',
'| PR | Scope |','| --- | --- |',
'| [Core #2796](https://github.com/tetsuo-ai/agenc-core/pull/2796) | Lean head and tool loading |',
'| [Core #2809](https://github.com/tetsuo-ai/agenc-core/pull/2809) | Result bounds |',
'| [Core #2812](https://github.com/tetsuo-ai/agenc-core/pull/2812) | Four-tool Light profile |',
'| [Core #2813](https://github.com/tetsuo-ai/agenc-core/pull/2813) | Runtime overhead |',
'| [Core #2814](https://github.com/tetsuo-ai/agenc-core/pull/2814) | Retrievable output references |',
'| [Core #2815](https://github.com/tetsuo-ai/agenc-core/pull/2815) | Requested-capability notices |',
'| [Core #2816](https://github.com/tetsuo-ai/agenc-core/pull/2816) | Compact result frames |',
'| [Core #2817](https://github.com/tetsuo-ai/agenc-core/pull/2817) | Stable schema ordering experiment |',
'| [Proof #2797](https://github.com/tetsuo-ai/agenc-core/pull/2797) | Portable harness and evidence |',
'| [Desktop #481](https://github.com/tetsuo-ai/agenc-desktop/pull/481) | Session mode indicator and new-session switch |','',
'All remain draft. No merge, release or deployment. Brief, relative-path and required-actions branches are separate experiments. Desktop remains default-off with its experimental label. No protocol bump is required.','',
'## Spend, integrity and missing proof','',
f"Whole-study DeepSeek spend: **${d['deepseek_observed_usd']:.6f} observed**, **${d['deepseek_charge_usd']:.6f} conservatively charged** including missing-usage reserves, within the $35 cap. The $10 balance floor and maximum two concurrent job runs were enforced. Luna: **{d['luna_calls']}/600 attempts**, at most one run; subscription cost is unpriced.",'',
'Ten legacy DeepSeek calls lack usage. Shared host and provider load, sequential candidate cohorts and only two repeats limit causal conclusions. The process-based harness is not an adversarial filesystem sandbox. The trace audit records fixture-path exposure, shared scratch space and Luna’s misplaced task 07 output; these limitations are retained in [TRACE-AUDIT.md](TRACE-AUDIT.md). Luna’s old relay was replaced after an endless response with a bounded job relay; affected failures and unknown usage remain. The owner proxy strips the requested output cap, which applies equally to both agents and was not reconfigured.','',
'Clean-room checking covers every changed Git source and authored local helper. The final source inventory against 701 Pi package files has zero added 8/12/20-token matches. Unchanged third-party task inputs are separately verified clean. The scan emits hashes and overlap counts, not Pi prose. A lexical scan cannot prove semantic originality; AgenC implementation and prompts were written independently.','',
'What remains missing: a candidate that passes completion, median and p90 time, and total-token gates together on both DeepSeek models; a complete Luna matrix; a Luna replay control; and evidence supporting removal of the experimental label.','',
'<!-- scan-result-start -->','Final credential scan is pending completion of artifact writes.','<!-- scan-result-end -->','']
(r/'REPORT.md').write_text('\n'.join(lines))
