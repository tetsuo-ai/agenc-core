#!/usr/bin/env python3
"""Render sanitized native Kimi results without reading credentials or prompts."""
import argparse
import collections
import datetime
import json
import pathlib

from fixtures import TASKS
from suite import ORDER


def stats(rows):
    return {'solves': sum(bool(r['solve']) for r in rows), 'runs': len(rows),
            **{key: sum(r.get(key, 0) for r in rows)
               for key in ('calls', 'input', 'output', 'cached', 'cost', 'seconds')}}


def cell(rows):
    if not rows:
        return 'Not run'
    s = stats(rows)
    return (f"{s['solves']}/{s['runs']}; {s['calls']}; {s['input']:,}/{s['output']:,}; "
            f"${s['cost']:.6f}; {s['seconds']:.1f}s")


def reconcile_legacy_price(entry):
    """Price the initial successful probe, whose old recorder had no rate card."""
    # Official native input/output/cache rates, USD per million tokens:
    # https://platform.kimi.ai/docs/pricing/chat
    rates = {'kimi-k3.1-pro': (2, 10, .2), 'kimi-k3.1-pro-highspeed': (4, 20, .2),
             'kimi-k3': (3, 15, .3), 'kimi-k2.7-code': (.95, 4, .19),
             'kimi-k2.7-code-highspeed': (1.9, 8, .38), 'kimi-k2.6': (.95, 4, .16)}
    usage = entry.get('usage', {})
    if entry.get('status') != 200 or entry.get('cost') != 0 or not usage.get('total_tokens'):
        return entry
    incoming, outgoing, hit = rates[entry['model']]
    cached = usage.get('prompt_tokens_details', {}).get('cached_tokens', usage.get('cached_tokens', 0))
    cost = ((usage['prompt_tokens'] - cached + entry.get('cacheWrite1h', 0)) * incoming
            + usage['completion_tokens'] * outgoing + cached * hit) / 1e6
    return {**entry, 'recordedCost': 0, 'cost': cost,
            'costNote': 'Initial recorder had no rate card; reconstructed from preserved usage and published prices.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--evidence', type=pathlib.Path, required=True)
    p.add_argument('--handoff', type=pathlib.Path, required=True)
    p.add_argument('--baseline', type=pathlib.Path, required=True)
    args = p.parse_args()
    root = pathlib.Path(__file__).resolve().parent
    baseline = json.loads(args.baseline.read_text())
    previous = baseline.get('quotaBaseline', baseline.get('runs', []))
    previous = [r for r in previous if r.get('status') == 'blocked-funds']
    runs = sorted([json.loads(f.read_text()) for f in args.evidence.glob('*/result.json')], key=lambda r: r['run'])
    ledger = json.loads((args.evidence/'ledger.json').read_text())
    wire = [reconcile_legacy_price(json.loads(line)) for line in (args.evidence/'wire.jsonl').read_text().splitlines()]
    current = [r for r in runs if r['repeat'] in (20, 21)]
    earlier = [r for r in runs if r['repeat'] < 20]
    stress = [r for r in runs if r['repeat'] >= 100]
    long_stress = [r for r in stress if r['task'] == 'long-context']
    other = [r for r in runs if 21 < r['repeat'] < 100]
    checks = json.loads((args.evidence/'checks.json').read_text()) if (args.evidence/'checks.json').exists() else {}
    safe = {'updated': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'branch': 'feat/kimi-k3-1-followup', 'quotaBaseline': previous,
            'runs': runs, 'ledger': ledger, 'checks': checks,
            'models': [{k: m[k] for k in ('id','supports_image_in','supports_video_in','supports_reasoning','context_length','modalities','tools','limit') if k in m}
                       for m in json.loads((args.evidence/'models-current.json').read_text())],
            'requests': [{k: e[k] for k in ('run','model','status','usage','cost','recordedCost','costNote','secs','cacheWrite5m','cacheWrite1h',
                'stage','error','inputTokenBound','reusedCalibration','cacheOptions','cacheKeyHash','systemPrefixHash','toolsHash','spent','balanceBefore','balanceAfter') if k in e}
                for e in wire]}
    contracts = {}
    for name in ('schema-tools-contract', 'split-schema-tools-contract'):
        source = args.evidence / (name+'.json')
        contracts[name] = json.loads(source.read_text()) if source.exists() else []
    safe['contractProbes'] = contracts
    requests = safe.pop('requests')
    safe['requestLedger'] = 'request-ledger.jsonl'
    (root/'request-ledger.jsonl').write_text(''.join(json.dumps(e, separators=(',', ':'))+'\n' for e in requests))
    (root/'evidence.json').write_text(json.dumps(safe, indent=2)+'\n')
    s = stats(current)
    text = f'''# Kimi native follow-up report

Updated {safe['updated']}. Worktree: `wt-kimi-followup`. Branch:
`feat/kimi-k3-1-followup`. PR #3264 and `feat/kimi-k3-1` were not modified.
The interrupted WIP was reviewed and retained, with cache TTL accounting,
published prices, tests and the funded suite on this branch.
Execution status: {"matrix complete" if len(current) == 72 else "matrix running"}.
Native $20 usage target: {"met" if ledger.get("usageSpend",0) >= 20 else "in progress"}.

## Current results

Current matrix: **{s['solves']}/{s['runs']} solved**, {s['calls']} native calls,
{s['input']:,} input and {s['output']:,} output tokens, ${s['cost']:.6f} priced usage,
{s['seconds']:.1f} seconds summed CLI time. Two independent runs per task and
model use the built CLI in the six owner-designated trusted slots, with both
HOME and AGENC_HOME set to the isolated `home-zdr`. No trust records were written
by the suite. The refreshed key was sourced without printing and kept in process environments,
never copied to evidence. Balance and model discovery use the same native credential
in the runner. The previous scheduler was stopped before this suite ran.

Every currently listed native model is included. Older `kimi-k2-thinking`,
K2 previews, K2.5 and `moonshot-v1` variants are retired and absent from
[/v1/models](https://platform.kimi.ai/docs/api/list-models). They were not sent
billable requests under invented model IDs. All six offered models support
vision. K3 models have 1M contexts; K2 models have 256k contexts.
[Official model list](https://platform.kimi.ai/docs/models).

Each result cell is **solves/runs; calls; input/output tokens; USD; seconds**.
The before column preserves actual insufficient-funds failures. Zero usage in
that column means the API refused the call, not that a task passed for free.

| Model | Task | Before: empty account | After: funded current branch |
| --- | --- | --- | --- |
'''
    for model in ORDER:
        for task in TASKS:
            select = lambda rr: [r for r in rr if r['model']==model and r['task']==task]
            text += f'| {model} | {task} | {cell(select(previous))} | {cell(select(current))} |\n'
    text += '\n## Earlier funded evidence and stress runs\n\n'
    text += 'Earlier funded runs are preserved separately from the current matrix. They include the interrupted WIP and its initial completion-gate failure.\n\n'
    text += '| Group | Solves/runs; calls; input/output; USD; seconds |\n| --- | --- |\n'
    for name, rr in [('Earlier funded runs', earlier), ('Additional confirmation / TTL', other), ('Seeded long-context stress', long_stress), ('Additional reasoning stress', [r for r in stress if r['task'] == 'replay'])]:
        text += f'| {name} | {cell(rr)} |\n'
    if long_stress:
        text += '\n| Model | Stress result | Target token range |\n| --- | --- | --- |\n'
        for model in ORDER:
            rr=[r for r in long_stress if r['model']==model]
            if rr:text += f"| {model} | {cell(rr)} | {min(r['targetTokens'] for r in rr):,} to {max(r['targetTokens'] for r in rr):,} |\n"
    text += '''
The standard long-context task is tokenizer-calibrated near 98k tokens and
requires ordered retrieval plus file write/read-back. Seeded stress variants
shuffle records and retrieve 24 fresh values. The grader protects fixture tests
and checks actual tool behavior, not only final text. Debugging must show a
failed first test followed by a passing test. Replay must show all six stages
and matching reasoning hashes across requests. Vision requires image payloads
and an independently checked answer.

## Caching before and after

The before-cache baseline consists of the earlier funded K3.1 replay runs,
which already received automatic caching. The after runs add the stable routing
key and actual write-tier accounting. This is an observational comparison with
stochastic outputs and warm-cache effects, not a controlled speed benchmark.

| K3.1 replay group | Solves/runs | Calls | Input | Cached | Token hit rate | Cost | Time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
'''
    for label, rr in [('Before cache follow-up', earlier), ('After cache follow-up', current), ('Additional TTL confirmation', other)]:
        rr=[r for r in rr if r['model']=='kimi-k3.1-pro' and r['task']=='replay']
        if not rr:continue
        v=stats(rr)
        text += f"| {label} | {v['solves']}/{v['runs']} | {v['calls']} | {v['input']:,} | {v['cached']:,} | {100*v['cached']/v['input']:.2f}% | ${v['cost']:.6f} | {v['seconds']:.1f}s |\n"
    replay_names={r['run'] for r in current + other if r['model']=='kimi-k3.1-pro' and r['task']=='replay'}
    text += '\n| Current replay run | Distinct system prefix hashes | Tool hashes | Routing key hashes | Requested TTL | 5m writes | 1h writes |\n| --- | ---: | ---: | ---: | --- | ---: | ---: |\n'
    for name in sorted(replay_names):
        ww=[e for e in wire if e.get('run')==name and e.get('status')==200]
        counts=[len({e.get(k) for e in ww}) for k in ('systemPrefixHash','toolsHash','cacheKeyHash')]
        ttls=', '.join(sorted({e.get('cacheOptions',{}).get('ttl','default 5m') for e in ww}))
        text += f"| {name} | {' | '.join(map(str,counts))} | {ttls} | {sum(e.get('cacheWrite5m',0) for e in ww)} | {sum(e.get('cacheWrite1h',0) for e in ww)} |\n"
    text += '''
The [complete caching guide](https://platform.kimi.ai/docs/guide/context-caching)
and its linked Chat, Responses, Messages and pricing pages were reviewed.
Caching is implicit and organization-isolated. The default is five minutes;
K3 accepts `prompt_cache_options={mode:implicit,ttl:5m|1h}`. There are no explicit
cache objects, cache IDs, special cache roles, manual refresh calls or deletion
calls. Explicit breakpoints are rejected. Writes require complete cache blocks,
but no numeric minimum block size is published. AgenC keeps the stable prefix
unchanged and appends task state and tool results.

The first write locks the TTL. Hits renew that original TTL for free, including
when a later request asks for a different TTL. The response billing headers
identify actual five-minute and one-hour writes. Both are subsets of total
input, alongside cache hits and uncached input. One-hour writes cost twice the
ordinary input rate; five-minute writes cost the ordinary input rate. Reasoning
is already included in output. See [pricing](https://platform.kimi.ai/docs/pricing/chat)
and the full [feature checklist](DOCS-REVIEW.md).

## Failures, causes, fixes and confirmation

- HTTP 429 `exceeded_current_quota_error`: the old account had no funds. The new key and funded balance resolved the account issue. The existing terminal-funds handling is retained and unit-tested; the table records reruns of every previously blocked task.
- Initial funded file task: correct file, but the prose completion gate conflicted with the requested exact `hi` reply. The WIP changed the harness to the CLI's existing JSON output contract, leaving independent task grading intact. Current file runs confirm exact bytes, read-back and final content.
- Cache billing gap: only default write pricing existed; one-hour writes were unaccounted for. Added actual response TTL parsing for JSON/SSE, published one-hour rates and sweep pricing, with tests for TTL locking, missing/malformed counts and no double counting.
- Missing cache routing hint and TTL selection: added stable session `prompt_cache_key`, request-scoped TTL and isolated client `AGENC_KIMI_CACHE_TTL`. Mocked requests cover all six models and environment precedence. Stable prefix and tool hashes are measured above.
- K3 500k-token stress timeout: the first two inference responses succeeded and the written artifact matched all 24 expected values. A later read-only preflight timed out before admission, leaving no pending inference reservation. The guard now retries transient diagnostic failures once and reuses a calibrated token bound only for byte-identical, append-only conversation history. Each appended UTF-8 byte reserves one token; changed history, model or image tails require recalibration. Regression tests cover retry limits, exhausted quota and changed prefixes. Failed run 102 remains preserved; confirmation used the identical seed 102 and 500k target under repeat 1020 and passed in 106.05 seconds across three calls. Both later calls reused the calibrated bound.
- Stop limits: added local validation for the documented five-string, 32-byte limit, including multibyte regression tests.
- Local validation found an outdated Kimi prefix expectation and a new environment entry out of sort order. Both were corrected. The first PR's latest test commit was merged into this follow-up only; its obsolete unpriced K3.1 exceptions were removed here.
'''
    text += '\n## Additional API contract probes\n\n'
    text += 'These small native API probes are separate from the built-CLI task matrix. They use the same guarded spend ledger.\n\n'
    text += '| Model | Combined schema and tools | Separate tool and schema phases |\n| --- | --- | --- |\n'
    for model in ORDER:
        cells=[]
        for name in ('schema-tools-contract','split-schema-tools-contract'):
            rr=[r for r in contracts[name] if r['model']==model]
            cells.append('Passed' if rr and rr[0]['solve'] else ('Not run' if not rr else str(rr[0].get('error',{}).get('type','Failed'))))
        text += f'| {model} | {cells[0]} | {cells[1]} |\n'
    text += '\nThe combined probes returned HTTP 200 even when the requested workflow failed. K3/K3.1 and K2.7 Highspeed skipped the tool; K2.6 called it but fenced its final JSON. The provider retains its capability gate for these combinations and now explains the general workaround: run tool steps first, then request the final schema with an empty tool catalog. Mocked tests cover this sequence for all six models and reject unsafe combinations before HTTP. K2.7 Code alone completed the combined loop. This limitation is kept visible rather than counted as a successful task.\n'
    failed=[r for r in runs if not r['solve']]
    text += '\n| Preserved funded failure | Cause/evidence |\n| --- | --- |\n'
    for r in failed:text += f"| {r['run']} | status={r['status']}; completion warning={r.get('completionWarning')}; behavior verified={r.get('behaviorVerified')}; grader={str(r.get('grader','')).strip().replace('|','/')} |\n"
    text += '\n## Spend ledger\n\n'
    text += 'All amounts are USD. Prior owner spend remains included. Account deductions can lag streamed usage, so the guard uses the larger of observed spend and prior spend plus priced usage with a 10% margin. Every call reserves input and maximum output before transmission. The $24 owner cap and $1 balance floor remain active.\n\n'
    text += '| Checkpoint | Available balance | Owner observed spend | Native priced usage |\n| --- | ---: | ---: | ---: |\n'
    text += '| Funded account start | 24.999100 | 0.191417 prior OpenRouter | 0 |\n'
    start=json.loads((args.evidence/'suite-balance-start.json').read_text())
    text += f"| Current suite start | {start['available_balance']:.6f} | Preserved in request ledger | Earlier usage retained |\n"
    for model in ORDER:
        names={r['run'] for r in current if r['model']==model}
        ww=[e for e in wire if e.get('run') in names and 'balanceAfter' in e]
        if ww:
            last=ww[-1]
            text += f"| After latest {model} matrix request | {last['balanceAfter']['available_balance']:.6f} | {last['spent']:.6f} | {sum(e.get('cost',0) for e in wire[:wire.index(last)+1]):.6f} |\n"
    text += f"| Latest reconciled total | {ledger['lastBalance']['available_balance']:.6f} | {ledger['spent']:.6f} | {ledger.get('usageSpend',0):.6f} |\n"
    text += '\nThe first funded probe originally recorded zero cost because its rate card was missing. Its preserved usage prices to $0.08720760, already included in the running ledger. The sanitized request ledger includes both the original recorded cost and the reconstructed cost for those eight calls.\n'
    text += f"\nCash balance: ${ledger['lastBalance']['cash_balance']:.6f}; vouchers: ${ledger['lastBalance']['voucher_balance']:.6f}. Outstanding reservation: `{json.dumps(ledger.get('pending'))}`.\n"
    native_observed=ledger['spent']-ledger.get('priorSpend',0)
    text += f"\nObserved native account deductions total ${native_observed:.6f}, compared with ${ledger.get('usageSpend',0):.6f} reconstructed from response usage. The ${native_observed-ledger.get('usageSpend',0):.6f} difference remains unreconciled against an itemized Moonshot invoice; balance timing and token-price reconstruction are separate evidence. The spend guard uses the larger account-based total and its usage margin. No further paid requests remain active.\n"

    text += '''
The sanitized run results are in [evidence.json](evidence.json); per-request
usage and balance checkpoints are in [request-ledger.jsonl](request-ledger.jsonl).
Raw fixture evidence remains in the owner's `glm-fit/kimi-evidence/funded-2026-10-23`
directory. Keys, request authorization headers and account identifiers are not
included in the report or committed evidence.

## ZDR and documentation coverage

Native `kimi` shows retained/red for every model. The
[privacy policy](https://platform.kimi.ai/docs/agreement/userprivacy) retains input
while the account is active. [Enterprise ZDR](https://platform.kimi.ai/docs/guide/zero-data-retention)
requires approval by Moonshot; no request parameter enables it. With ZDR,
prompts and outputs are deleted after responding except where law requires
otherwise. Enterprise data is not used for training. Batch, direct file uploads
of images/videos, operational records and third-party services are excluded.
The WIP badge classification was correct and remains, with citations and tests.

OpenRouter Moonshot routes instead use live endpoint eligibility and
`provider.zdr=true`. The checked public list includes K3.1 Pro, K3, K2.7 Code,
K2.6, K2.5, K2 Thinking, K2 0905 and K2. Disabling ZDR shows retained; an
unrecognized proxy shows unknown. Native account policy is not inferred from
OpenRouter's list. No OpenRouter inference was purchased during this follow-up.

The [documentation checklist and complete source manifest](DOCS-REVIEW.md)
covers the platform bundle and OpenAPI schema, including every feature requested
by the owner. Optional service APIs not exposed by the AgenC chat provider are
listed explicitly: native video, remote file management, partial prefill, batch,
Formula execution, standalone Moonshot search/fetch, Responses/Messages wires,
log probabilities, prediction and safety identifiers.

## Validation and open issues

'''
    text += '\n'.join('- '+str(v) for v in checks.values())+'\n'
    text += f'\nCurrent matrix missing runs: {72-len(current)}. Current matrix failed runs: {sum(not r["solve"] for r in current)}.\n'
    text += '''
The base matrix ran before merging release 0.19.17. The merged build was
typechecked and passed 304 targeted tests; subsequent stress runs exercise that
rebuilt CLI across all six models. Passing these fixtures does not establish
perfection on arbitrary tasks. The
4,096-token evaluation output cap is lower than production defaults and the
docs' recommendation for deep reasoning. TTL renewal/expiry timing is governed
by Moonshot; local tests verify serialization and accounting, while live counts
verify cache hits and write tiers. Unsupported optional API surfaces are not
advertised as completed features.

## Prepared PR description

Title: Kimi: live results across all models, ZDR status and fixes

Follow-up to #3264, leaving its branch unchanged. Complete the interrupted native
Kimi evaluation and add the now-published pricing, cache TTL usage accounting and
stable session cache routing. Preserve Moonshot's native retained badge with
policy citations and distinguish OpenRouter's request-level ZDR eligibility.

Include independently graded CLI results for every currently offered native
model across file read-back, multi-file editing/tests, failed-test debugging,
reasoning replay, vision and near-100k-token retrieval, plus seeded long-context
stress and a cumulative spend ledger. Document official API coverage and remaining
optional surfaces. Add regression tests for cache writes/hits, TTL locking,
streaming, stop limits, isolation, pricing and retention. Avoid repeated giant
tokenizer requests with conservative append-only bounds and retry transient
read-only diagnostic failures without retrying paid inference.
'''
    text += f"\nValidation: {s['solves']}/{s['runs']} current matrix solves; {stats(stress)['solves']}/{len(stress)} stress solves. Native priced spend ${ledger.get('usageSpend',0):.6f}; latest account balance ${ledger['lastBalance']['available_balance']:.6f}. See the report for local checks, TTL verification, failed combined-schema probes and remaining API surfaces.\n"
    (root/'K-REPORT.md').write_text(text)
    handoff_text = text
    for name in ('DOCS-REVIEW.md', 'evidence.json', 'request-ledger.jsonl'):
        handoff_text = handoff_text.replace(']('+name+')', ']('+str(root/name)+')')
    args.handoff.write_text(handoff_text)
    print(json.dumps({'matrix':s,'ledger':ledger,'stress':stats(stress)}))


if __name__ == '__main__':
    main()
