"""Render the predeclared confirmation results without dropping failed cells."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--main-label', default='Main Light 9e7')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
metrics = json.loads((root/'evidence/final-comparison.json').read_text())
latest_path = root/'evidence/final-comparison-main-latest.json'
latest_metrics = json.loads(latest_path.read_text()) if latest_path.exists() else None
data = json.loads((root/'evidence/decomposition.json').read_text())
if not metrics['full_matrix'] or any(row['candidate']['runs'] != 24 for row in metrics['models']):
    raise SystemExit('The complete confirmation matrix is required')
selected = [row for row in data['runs'] if row['origin']=='light-port' and row['id'] in metrics['selected_ids']]
def num(value, decimals=0):
    return 'unavailable' if value is None else f'{value:,.{decimals}f}'
met = all(row['meets_all'] for row in metrics['models'])
startup_count=len(metrics.get('infrastructure_attempts',[]))
lines = [
    '# Independent AgenC Light experiment', '',
    '**'+('The confirmation meets all requested benchmark gates.' if met else 'The confirmation does not meet all requested benchmark gates.')+'**', '',
    'The selected independent profile is Core `3c954ea5591c683aa9b14a0219345e11051b06dd` on `light/pi-port`, based on main `3caa13df9d56d1623766096f013e8ffc7e54c043`. It uses five initial AgenC tools, bounded new output with retrievable references, exit-event waits, stable schema ordering, and independently written workflow and discovery guidance. Canonical permission admission, sandbox execution, freshness checks and effect receipts remain in place.', '',
    f'The final comparison covers 48 confirmation runs with model calls: 12 frozen tasks, two repeats per model. Screening cells were not reused. {startup_count} zero-call daemon-start failures within a predeclared risk set required shorter cohort labels because their Unix socket paths were too long. Those startup failures remain in the attempt totals below. Only validated zero-call infrastructure cells were replaced; no run that reached the model was retried. Pi cells are the retained baseline and were not rerun.', '',
    '| Model | Agent | Completed | Median / p90 seconds | Tokens/task | Calls/task |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
]
for row in metrics['models']:
    for key, label in [('pi', 'Pi'), ('main_best_full', args.main_label), ('candidate', 'Independent Light')]:
        value = row[key]
        lines.append(f"| {row['model']} | {label} | {value['passed']}/{value['runs']} | {num(value['median'],2)} / {num(value['p90'],2)} | {num(value['tokens'])} | {num(value['N'],2)} |")
    if latest_metrics:
        value=next(item for item in latest_metrics['models'] if item['model']==row['model'])['main_best_full']
        lines.append(f"| {row['model']} | Main Light 11e (latest full) | {value['passed']}/{value['runs']} | {num(value['median'],2)} / {num(value['p90'],2)} | {num(value['tokens'])} | {num(value['N'],2)} |")
lines += ['', 'Main 9e7 is the earlier selected full candidate with the higher Pro completion count. Main 11e is the latest full candidate and improves Flash time and tokens. Both are shown because neither dominates the other across both models. Main 11e retains its own two zero-call startup failures and three Pro timeouts; its averages therefore have a different infrastructure basis. No failed main cell is removed or repaired by this job.']
lines += ['', '| Model | Original launch completions | All attempts, including startup failures | Runs with model calls |',
          '| --- | ---: | ---: | ---: |']
for row in metrics['models']:
    lines.append('| '+row['model']+' | '+' | '.join(str(row[key]['passed'])+'/'+str(row[key]['runs']) for key in ['original_launch','startup_inclusive_attempts','candidate'])+' |')
lines += ['', 'The performance table uses runs with model calls so zero-call failures do not artificially improve time or token averages. The totals including startup attempts expose the operational limitation. `socket-repair-plan.json` and its validation record preserve eligibility: zero calls, exit 1, path length at least 108 bytes and the daemon connect-EINVAL error. Source, paid harness, task prompts, graders, effort and caps stayed unchanged.', '', '## Acceptance gates', '',
          '| Model | No lost Pi task / completion | Faster median | Faster p90 | Fewer tokens |',
          '| --- | --- | --- | --- | --- |']
for row in metrics['models']:
    gates = row['gates']
    lines.append('| '+row['model']+' | '+' | '.join('pass' if gates[key] else 'fail' for key in ['completion','median','p90','tokens'])+' |')
failures = [row for row in selected if not row['pass_']]
if failures:
    lines += ['', 'Observed confirmation failures:', '']
    for row in failures:
        reasons=[]
        if row.get('timeout'):reasons.append('deadline exceeded')
        if row.get('check_pass') is False:reasons.append('code/artifact check failed')
        if row.get('deferred_evidence') and not row['deferred_evidence'].get('pass'):reasons.append('required discovery/planning receipt missing')
        if row.get('stop_reason'):reasons.append(row['stop_reason'])
        lines.append(f"- {row['model']}, {row['task']}, repeat {row['repeat']}: "+('; '.join(reasons) or 'effective completion failed; see retained result')+'.')
else:
    lines += ['', 'All 48 confirmation cells completed successfully.']
lines += ['', '## Analytic decomposition', '',
          'All per-task and per-run quantities are in [STATUS.md](STATUS.md) and [decomposition.json](evidence/decomposition.json). P is raw system-plus-schema tokens under the retained official tokenizer; provider framing belongs to the history residual. Prefix changes after discovery are separate. The identity is N×P + prefix change + history + visible output + reasoning = billed total. Output includes tool arguments. Failed and missing-usage cells are not silently replaced.', '',
          '| Model | ΔN×P | Δprefix change | Δhistory | Δvisible output | Δreasoning output | Δtools + overhead seconds |',
          '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
for row in metrics['models']:
    delta = row['delta_pi']
    lines.append('| '+row['model']+' | '+' | '.join(num(delta[key],1) for key in ['NP','schema_delta','H','visible','reasoning','tools_overhead'])+' |')
lines += ['', '| Model | Own / Pi reasoning tokens | Own TTFT / generation seconds | Own summed tools / residual overhead seconds | Pre-request guard / estimated runtime overhead seconds |',
          '| --- | ---: | ---: | ---: | ---: |']
for row in metrics['models']:
    own, pi = row['candidate'], row['pi']
    lines.append(f"| {row['model']} | {num(own['reasoning'],1)} / {num(pi['reasoning'],1)} | {num(own['ttft'],2)} / {num(own['generation'],2)} | {num(own['tools'],2)} / {num(own['overhead'],2)} | {num(own['guard'],2)} / {num(own['runtime_overhead'],2)} |")
lines += ['',
          'These timing components are per-task means, not an additive decomposition of medians. Retained Pi traces do not contain exact TTFT/generation or separate tool-duration/overhead clocks; those deltas are unavailable. Tool durations are summed completed spans and can overlap. Residual runtime overhead is therefore an estimate. The new proxy checks the shared account before each call; historical Pi checked before each run. The measured guard remains in primary raw wall time, and no counterfactual timing correction is used.', '',
          'The prompt experiments do not show that shorter instructions reliably reduce DeepSeek reasoning. The focused prompt moved Pro task 04’s first edit from request 24 to 9 and cut calls 41→19, but reasoning rose 6,708→7,128. Flash task 04 regressed under the same prompt. The selected local-scope screening lowered replay by 24,726 / 41,015 tokens per task versus Pi on Flash/Pro while reasoning rose 843 / 1,671. Those are observed associations from small stochastic samples, not isolated causal estimates.', '',
          'In the fresh full confirmation, average reasoning is slightly below Pi on both models. Large individual messages still matter: Flash task 03, repeat 1 introduces an assistant payload of 6,837 raw tokens at request 6/message 15, including 5,948 reasoning tokens, with 12 remaining exposures. Pro task 07, repeat 2 introduces 7,149 tokens at request 7/message 16, including 6,545 reasoning tokens, with 10 exposures. The per-task tables preserve both message and tool-result ranks. No required reasoning history was removed.', '',
          'The largest remaining measured Flash time penalty is outside provider requests: mean request time improves by 4.24 seconds, while tools plus overhead increase by 10.27 seconds. The measured account guard alone contributes 6.21 seconds. Pro request time improves by 21.09 seconds with 13.92 seconds more tools plus overhead, including 8.45 seconds of guard. These figures explain why a smaller token total need not win raw wall time; they do not justify assigning all inter-call delay to AgenC or asserting a counterfactual victory.', '',
          '## Decisions supported by measurements', '',
          '- Canonical FileRead and MultiEdit were preloaded after terminal-only writing encountered runtime write-policy and freshness recovery. Explicit capability loading was retained and strengthened after an observed false claim that a planning tool was unavailable.',
          '- New terminal output uses a 700 estimated-token default budget; omitted collected output has a private file reference. A zero-provider CLI probe successfully retrieved an omitted middle line. Earlier upstream omissions stay disclosed. Existing history is not rewritten.',
          '- Terminal waits use the existing process-exit event for up to 30 seconds. Exit and cancellation tests pass. This is bounded event waiting, not a claim of universal durable suspension or elimination of every polling call.',
          '- The 80-tool eager catalog was tested against the five-tool deferred profile with stable ordering. It used 657,011 / 727,337 tokens per task on Flash/Pro and failed the frozen task 12 discovery condition. Deferred exposure was retained. The earlier invalid catalog launch and its interrupted call remain recorded separately.',
          '- The localized workflow targets the measured long inspection sequences. Screening completed 8/8 with 236,964 / 291,630 tokens per task, below matched Pi 260,379 / 330,880, but did not win raw wall time. This justified confirmation, not a performance victory claim.', '',
          '## Validation and evidence limits', '',
          'Linux source/test-support typechecks, the build, and 85 focused checks pass. Pinned main records 32,500 passes / 28 failures / 11 skips. The first selected-source full suite records 32,508 / 28 / 11 with a new 30-second SDK parity timeout. The final rerun records 32,506 / 30 / 11, with three failure identities absent from that main run: SDK parity timeout, partial Bedrock credential classification, and queued scheduled-turn cancellation. The unchanged SDK file previously passed 10/10 in isolation on both revisions. Earlier credential-test isolation passed 76/76 on both. The two other assertion files then passed 157/157 in isolation on both pinned main and the selected revision. This supports an environment-sensitive explanation but does not convert the full run into a pass. All full-run discrepancies remain in the comparison artifacts; the required no-new-failure gate is not met.', '',
          'Clean-room scans compare all changed Core source, prompt and tool-description files with the 701-file Pi package using normalized 8/12/20-word overlap and subtract inherited main text. Source implementation and wording were written independently; no Pi source, prompts, schemas, errors or documentation were used as implementation input. The final scan artifacts, integrity review, overlap ledger, spend ledger summary and credential-scan results accompany this report in `evidence/`.', '',
          'The final lexical screen covers 90 files, including all 27 changed Core files and the benchmark/proof source and documents. New Core overlap is zero at 8, 12 and 20 words. Across all 90 files, new text overlap is also zero. The raw 8- and 12-gram counts each contain one numeric-only pattern from repeated zero-valued table cells; the raw 20-gram count is zero. Those matches remain recorded with candidate line numbers. This is a textual similarity check, not a proof of semantic independence.', '',
          'Timings can overlap the main Light job. Exact observed overlaps are retained in `evidence/overlap.json`; no timing adjustment is applied. The confirmation intentionally overlaps no owned build or test suite. The harness is process-based, not an adversarial filesystem boundary. Existing baseline/main fixture-name exposure and shared-scratch caveats remain. Review flags are retained rather than treated automatically as cheating.', '',
          'All 48 confirmation model runs overlap the other study’s retained provider intervals; 36 also overlap its Core suites. The final audit covers 108 owned attempt directories and 2,698 distinct proposed tool calls, with 48 path flags and no malformed or changing capture. Review of 29 new flags finds 16 syntax/relative-path cases, 12 container `/tmp` cases and one nonexistent-path probe. Temporary test files and cleanup outside repository scope remain explicit limitations. The benchmark container does not bind host `/tmp`. No direct hidden-checker, sibling-solution or root-search flag was observed; this is not proof against indirect access. Only two repeats per task and shared-host contention limit any general performance claim.', '',
          'Task 12 has an asymmetric frozen check: Light must discover an initially deferred planning tool and call it; the Pi baseline is exempt from that discovery receipt. The eager-catalog failures keep the original score even when code and planning calls succeed. No grader was weakened.', '',
          'The shared-account floor is $10 and this job’s cap is $15. Costs are provider-list-rate estimates, including reasoning and cached input; one interrupted invalid-catalog call carries a conservative $0.019818 reservation. [Official pricing](https://api-docs.deepseek.com/quick_start/pricing/) supplies the frozen rate basis. Job credentials enter Linux only through SSH stdin and process environments. Final scans report counts without printing matches; pre-existing certificate/header fixtures are compared with baseline bytes.', '',
          'Final ledger: 1,922 request/reservation entries, observed estimate $2.048522158 and reserved total $2.068340158. The shared balance was $29.49 at 2026-09-29 17:43:11 UTC. This job made no non-DeepSeek provider calls and did not rerun Pi.', '',
          'Final credential scans cover 7,069 Mac files (118,565,533 bytes) and 69,220 PC files (3,243,280,537 bytes), including copied owned Core test logs. Both scans find zero exact credential matches, zero generic provider-key matches and zero read errors. The only header flags are three existing source-test fixtures on the Mac and the same fixtures across five Linux checkouts; every flagged file matches pinned main byte for byte. Git object databases, dependency trees and symlinks are excluded. No credential match contents were printed.', '',
          'No PR was opened because the required full-suite gate remains unmet. The source is committed and pushed on `light/pi-port`; `evidence/pr-body.md` is an unpublished review draft. No merge, release or deployment was performed. Source and all observed failures remain available for review.',
]
(root/'REPORT.md').write_text('\n'.join(lines)+'\n')
print('REPORT.md rendered from the complete declared matrix')
