"""Render the final measured result; does not regrade, impute usage or rerun agents."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
e = root / 'evidence'
r = json.loads((e / 'selected-comparison.json').read_text())
progress = json.loads((e / 'progress.json').read_text())
head = json.loads((e / 'selected-first-requests.json').read_text())
assert all(m['totals']['light']['runs'] == 24 for m in r['models'])
assert not r['owner_target_accepted'], 'A passing result requires the authorized Desktop promotion workflow.'

def number(v, digits=0):
    return 'unknown' if v is None else f'{v:,.{digits}f}'

lines = [
    '# Light mode final report', '',
    '**The owner target was not met. Light should remain opt-in and experimental.** The selected candidate completes the full 12-task, two-repeat matrix on both DeepSeek models, reusing its eight completed screening cells and running only 40 missing cells. Every selected failure remains included. The implementation improves Light substantially, but the table below decides readiness against Pi.', '',
    '| Model | Agent | Effective | Tokens/run | Median / p90 seconds | Model calls/run | Cost USD |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
]
for m in r['models']:
    for agent in ('pi', 'normal', 'light'):
        g = m['totals'][agent]
        cost = number(g['sums']['cost_usd'], 6) if g['sums']['cost_usd'] is not None else '>=' + number(g['observed_sums']['cost_usd'], 6)
        lines.append(f"| {m['model']} | {agent} | {g['passed']}/{g['runs']} | {number(g['means']['total_tokens'])} | {number(g['wall_seconds']['median'],1)} / {number(g['wall_seconds']['p90'],1)} | {number(g['means']['model_calls'],2)} | {cost} |")
lines += ['', 'Tokens and calls are per-run means, including failures. Cost is the cohort total at request-time list rates. Unknown legacy usage remains unknown; >= is an observed cost lower bound. Cached input counts toward total tokens. A passing artifact after timeout is an effective failure.', '',
          '## Decision and limits', '',
          'All five requested levers were implemented or measured, with seven diagnostic variants after the early full candidate. The batch-editor candidate was selected because it completed 8/8 screening cells; the later focused-work variant completed 7/8 and was rejected despite lower tokens. This does not prove that every conceivable future agent design is exhausted. It establishes that the evaluated prompt, loading, reminder and result-bound changes do not meet the requested bar.', '',
          'The source is frozen at 9e7edc3975cee8ca2225657193da4fa0c41b5e9d. Final stacked PR tip 0d5ad1bedd757bcf5e762004f2d7fac2300d7318 differs only in a test assertion for the intended four-tool set. Runtime source equality was checked. No benchmark build, completed cell, prompt or checker was replaced.', '',
          'The complete comparison is exploratory evidence on 12 tasks over pinned more-itertools and ItsDangerous repositories. Two repeats are not a universal performance guarantee. Screening reuse is explicit and is not an independent fresh confirmation sample. Shared Linux host load and serial cohorts limit causal timing claims. Pi 0.73.1 and AgenC use the same model IDs, enabled/high reasoning and 8,192 output-token limit.', '',
          'Ten legacy DeepSeek calls have no recoverable usage event in their saved responses. They prevent complete numeric totals for affected normal/original-Light cohorts. All baseline cells are retained. Pi and selected Light remain independently evaluable with complete usage; the separate owner gate fails. Cost differences also reflect DeepSeek peak/off-peak pricing, so cheap requests are not proof of fewer tokens. [Official pricing](https://api-docs.deepseek.com/quick_start/pricing/).', '',
          '## Requested levers and remaining costs', '']
lever = (root / 'FINAL-LEVER-EVIDENCE.md').read_text()
lines.append(lever[lever.index('| Lever |'):])
lines += ['## Exact first requests', '', '| Model | Agent | Mean first input tokens | Mean system text + schema JSON characters |', '| --- | --- | ---: | ---: |']
for g in head['groups']:
    lines.append(f"| {g['model']} | {g['agent']} | {number(g['means']['provider_first_input_tokens'],2)} | {number(g['means']['head_chars'],2)} |")
lines += ['', f"Selected first-input wins: {sum(x['first_input_tokens_lower'] for x in head['comparisons'])}/{len(head['comparisons'])} matched repeats. Character counts diagnose structure; billed first-input tokens come directly from provider usage. Exact per-run values and tool sets are in [first-request evidence](evidence/selected-first-requests.json).", '',
          '## Per-task comparison and token totals', '', (e / 'selected-compact-tables.md').read_text(),
          '## Regression validation', '',
          '- Core main: 31,236 passed, 27 failed, 11 skipped. Selected full source: 31,296 passed, 30 failed, 11 skipped; all 27 main failures recur, with the same two recorded public-network-attempt call sites. The three additions remain recorded.',
          '- Two added daemon PID-readiness timeouts pass the exact-file comparison: 162/162 on main, and 162/162 on the candidate. The third addition was a stale five-tool assertion; the corrected test names the exact four tools and retains next-request polling/receipt checks. Candidate final focus passes 163/163. No production code, daemon assertion or timeout changed for this correction.',
          '- Selected full source passes all 15 durability-matrix tests. Earlier failures at other revisions remain in the history. SDK/installer/compaction focus passes 97/97 on both main and selected source. Other completed Light/schema/prompt/child/safety coverage and typechecks are retained in [Core evidence](CORE-TESTS.md).',
          '- Desktop main: 5,237 passed, 1 failed, 32 skipped. Candidate: 5,238 passed, the same 1 failure, 32 skipped. Zero new failures; the mode fixture covers four themes. Desktop typecheck passed. All suites/apps ran on Linux; no Desktop suite or app ran on the Mac.',
          '- Proof tooling: 17 runner checks and 13 packaging checks pass, plus strict-summary/transport self-tests, 8 reserve-reconciliation checks and 36 task controls. The task controls reject every unsolved fixture and every original-test modification, and accept each reference solution.',
          '- An earlier task-wrapper edit caused post-suite shell errors in two old runs. Their complete Vitest outcomes and wrapper errors are separately retained. The final selected full/focused runs used the stable wrapper. Full log hashes and exact failure-name comparisons are in [test results](evidence/test-results.json). These are not green full suites.', '',
          '## Trace integrity', '',
          'One selected Flash task 03 run executed a filesystem-root search that returned paths to task-validation fixtures. Its subsequent captured calls show no read of those files. That is a real workspace-scope deviation and an integrity limitation, retained alongside the grader result. Earlier original-Light runs also listed their own run-directory names. Container/tmp fixtures and shared scratch space are additional limitations. The harness does not provide an adversarial filesystem boundary. [Trace review](TRACE-AUDIT.md) records final audit counts and every material caveat.', '',
          '## Pull requests', '',
          '| PR | Scope | Status and evidence |', '| --- | --- | --- |',
          '| [Core 2796](https://github.com/tetsuo-ai/agenc-core/pull/2796) | Fixed head, four tools, deferred loading, Light reminder removal | Draft; combined candidate measured here; focused/full tests recorded |',
          '| [Core 2809](https://github.com/tetsuo-ai/agenc-core/pull/2809) |200-line and1,000-token defaults, stacked on 2796 | Draft; selected production source plus test-only correction |',
          '| [Desktop 481](https://github.com/tetsuo-ai/agenc-desktop/pull/481) | Session mode indicator and fresh-session switch | Draft; zero new Linux failures; default-off/experimental retained |',
          '| [Benchmark 2797](https://github.com/tetsuo-ai/agenc-core/pull/2797) | Portable harness and sanitized complete-study evidence | Draft; all attempts, usage accounting and raw-artifact hashes retained |',
          '| [Core 2810](https://github.com/tetsuo-ai/agenc-core/pull/2810) | Focused-work prompt experiment | Closed, unselected: 7/8 effective screening completions versus selected 8/8 |', '',
          'Nothing is merged, released or deployed. No protocol field/version changed. Desktop retains its existing baseline Core packaging pin; integrating the runtime optimization requires a pin including the selected changes. Existing sessions keep their mode/history. Goal and cross-provider routing/state machines were not changed; shared-file edits are identified in the PRs.', '',
          '## Whole-study spend and secondary provider', '']
spend = progress['spend']
lines += [f"DeepSeek: **${spend['provider_list_rate_usd']:.6f} observed list-rate cost; ${spend['conservative_charge_usd']:.6f} conservative complete-study charge**, including all pilots, failed/unselected cohorts and missing-usage reserves. Authorized cap: $25; launch balance floor: $10; at most two job-owned provider runs. The immutable original ledger and reconciliation audit are retained. Shared-account balance changes are not attributed as this job's cost.", '',
          'Luna is inconclusive and subscription cost is unpriced. Its ledger contains 42 request attempts: 40 with completed generation usage, one 429 rejection with zero reported tokens, and one unfinished response without completed usage. Two Pi tasks passed; earlier Light produced a passing artifact but timed out, and the later Light retry did not finish. The next queued task was cancelled before launch. Both job-owned relays stopped; the owner proxy was neither started nor reconfigured.', '',
          '## Remaining gaps and credential scan', '',
          'Light still needs to beat Pi on quality, median/p90 time and total tokens together before promotion. Missing legacy baseline usage, inconclusive Luna evidence and the process-based isolation limitation remain. Every iteration, including negative results, is in [STATUS.md](STATUS.md).', '',
          '<!-- scan-result-start -->', 'Final credential scans are pending.', '<!-- scan-result-end -->', '']
(root / 'REPORT.md').write_text('\n'.join(lines))
