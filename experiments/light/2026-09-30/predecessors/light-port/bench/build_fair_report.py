"""Publish both confirmations from computed evidence, without selecting outcomes."""
import json,statistics
from pathlib import Path
r=Path(__file__).resolve().parent.parent
def read(name):return json.loads((r/'evidence'/name).read_text())
def f(x,d=0):return 'NA' if x is None else f'{x:,.{d}f}'
new=read('fair-comparison.json');old=read('final-comparison.json');latest=read('final-comparison-main-latest.json')
dec=read('decomposition-fair.json');proof=read('fair-provenance.json');tests=read('fair-full-comparison.json')
overlap=read('fair-overlap-summary.json')
matched={m['model']:m for m in old['models']};mainlatest={m['model']:m for m in latest['models']}
allpass=all(m['meets_all'] for m in new['models'])
target='meets every requested aggregate gate on both DeepSeek models' if allpass else 'does not meet every requested aggregate gate on both DeepSeek models'
lines=['# Independent Light: fair timing confirmation','',f'Frozen Core `3c954ea5591c683aa9b14a0219345e11051b06dd` **{target}**. The new `candidate-eq` matrix contains all 48 declared cells, twelve frozen tasks repeated twice per model. Its raw wall times govern timing acceptance. The earlier confirmation remains retained and is reported separately; Pi was not rerun.','',
'## Equal guard and retained evidence','',
'The new harness uses **one live balance check per task before process launch**, matching the retained Pi method. It keeps the same lifetime $15 spend ledger, $10 account floor, 45-call task cap, high reasoning effort, 8,192-token output ceiling, task deadlines, prompts and graders. Before every provider call, local reservations check the lifetime cap and account headroom from the latest live balance minus subsequent local spend and all in-flight maximum charges. An unavailable or sub-floor balance blocks launches. Other jobs can spend between live checks, as in the Pi baseline method. No balance time was subtracted from a completed result. The longest socket path is 93 bytes.','',
'The earlier confirmation used per-call live balance checks inside task time. Those checks averaged 6.21 seconds/task on Flash and 8.45 on Pro. Its original 46/48 launch, two zero-call socket failures, and 48/48 completed model-bearing repair matrix remain intact. The old report is [REPORT.before-fair.md](REPORT.before-fair.md). No failed or completed model-bearing cell was selectively retried in the fair matrix.','',
'## Full comparison','',
'| Model | Agent / confirmation | Completed | Median / p90 s | Tokens/task | Calls/task |','| --- | --- | ---: | ---: | ---: | ---: |']
for m in new['models']:
    name=m['model'];prior=matched[name];ml=mainlatest[name]
    for label,v in [('Retained Pi',m['pi']),('Independent Light, earlier guard',prior['candidate']),('Independent Light, equal guard',m['candidate']),('Main Light 9e7',m['main_best_full']),('Main Light 11e, latest full',ml['main_best_full'])]:
        lines.append(f"| {name} | {label} | {v['passed']}/{v['runs']} | {f(v['median'],2)} / {f(v['p90'],2)} | {f(v['tokens'])} | {f(v['N'],2)} |")
lines+=['','Main 9e7 has the stronger Pro completion result; main 11e improves Flash time and tokens. Neither dominates the other across both models, so both retained full candidates are shown. Their own failed cells, including startup failures and timeouts, stay included. Main-job newer subset experiments are not substituted for full confirmation.','',
'| Model | Completion / no lost Pi task | Faster median | Faster p90 | Fewer tokens |','| --- | --- | --- | --- | --- |']
for m in new['models']:
    lines.append('| '+m['model']+' | '+' | '.join('pass' if m['gates'][k] else 'fail' for k in ['completion','median','p90','tokens'])+' |')
    if m['lost_pi_cells']:lines.append('')
lines+=['','These are observed comparisons with two repeats per task, not a general performance guarantee. Stochastic call counts and reasoning can differ between the two confirmations even though source is unchanged.','',
'## Analytic decomposition','',
'All retained and new per-task tables are in [STATUS.md](STATUS.md); numeric records are in `evidence/decomposition-fair.json`. They report N, raw system-plus-schema P, N×P, prefix changes after discovery, history residual, the largest tool results and message positions, visible/tool-argument output, reasoning output, TTFT, generation, tool durations, guard and residual overhead. N×P + prefix change + history + output equals provider-recorded total tokens. Historical Pi did not record exact TTFT/generation or separate tool durations, so those splits and their deltas remain NA. Sum of tool spans can overlap; residual overhead is an estimate. Mean components do not decompose a median. Recorded request spans include local reservation and serialization before upstream forwarding. Full proxy admission overlaps that request span; the smaller pre-reservation guard interval does not. Neither interval includes the fair pre-launch live balance request.','',
'| Model | ΔN×P | Δprefix change | Δhistory | Δvisible output | Δreasoning | Δprovider requests s | Δtools + overhead s |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
for m in new['models']:
    lines.append('| '+m['model']+' | '+' | '.join(f(m['delta_pi'][k],1) for k in ['NP','schema_delta','H','visible','reasoning','request_seconds','tools_overhead'])+' |')
lines+=['','| Model | Light / Pi reasoning tokens | Light TTFT / generation s | Light tool / runtime overhead s | Pre-reservation interval / full admission s |','| --- | ---: | ---: | ---: | ---: |']
for m in new['models']:
    c,p=m['candidate'],m['pi']
    lines.append(f"| {m['model']} | {f(c['reasoning'],1)} / {f(p['reasoning'],1)} | {f(c['ttft'],2)} / {f(c['generation'],2)} | {f(c['tools'],2)} / {f(c['runtime_overhead'],2)} | {f(c['guard'],4)} / {f(c['proxy_arrival_to_upstream'],2)} |")
lines+=['','The only change for this rerun addresses the largest measured Flash timing penalty: unequal live balance requests in the harness. The prior measured token term was history replay; it motivated canonical read/batch-edit guidance, capability lookup, bounded new output and focused inspection. Those independent designs remain frozen. The stable full-catalog experiment was already measured and rejected: 657,011/727,337 tokens per task on Flash/Pro and failure of the frozen task12 discovery condition. Existing exit-event waits and retrievable output references remain; neither universal event-only continuation nor removed reasoning history is claimed.','',
'For each fair task, STATUS.md retains term-by-term deltas and the largest measured term. Reasoning output and its replay are separate measured quantities. These observational prompt comparisons cannot establish that AgenC wording causes a reasoning difference. No new runtime or prompt tuning was made to chase this confirmation.','',
'## Path-guidance finding','',
'**The frozen candidate has the guidance gap.** `light-presentation.ts` replaces FileRead/MultiEdit descriptions and strips property descriptions, removing the canonical workspace-relative path advice. `light-workflow.ts` does not restore it. All four earlier task07 first requests confirm the omission. This candidate uses MultiEdit initially; a subsequently discovered Write retains its canonical description, unlike the main job’s compact Write. The earlier four DeepSeek task07 cells passed; that does not disprove the risk or predict Luna behavior. No Luna calls were made here. In the fair Flash task05 repeat2, a mistyped absolute edit path is rejected at call4 and corrected at call5. This directly records a recovered path error without proving the omitted wording caused it.','',
'The candidate also disables automatic headless completion rounds for Light unless explicitly configured `always`; this is another relevant behavior shared with the diagnosis. The reported main Luna failure involved a wrong absolute output path and abandoned recovery. No path or completion-policy change was made to this frozen candidate. Evidence: `evidence/path-guidance-audit.json`; diagnosis: `/private/tmp/light-diag/REPORT.md`.','',
'## Tests and integrity','',
'Linux build, source/test-support typechecks and the retained 85 focused checks pass. The fair guard has 45 passing offline harness checks. The new full-suite pair uses the official Linux runner, sequentially after all paid cells, on pinned main `3caa13df9` and the unchanged candidate `3c954ea55`.','',
'| Full suite | Result |','| --- | --- |',
'| Pinned main | '+next(line for line in tests['baseline']['summary'] if line.startswith('Tests ')).replace(' | ', ' / ')+' |',
'| Frozen candidate | '+next(line for line in tests['candidate']['summary'] if line.startswith('Tests ')).replace(' | ', ' / ')+' |','',
f"New full-suite failure identities versus this paired main: **{len(tests['new_failures'])}**. Earlier full-suite failures and isolated passes remain in the old report and evidence; a later result does not erase them."]
if tests['new_failures']:lines+=['',*['- '+name for name in tests['new_failures']]]
lines+=['',f"Fair cohort overlap: {overlap['with_other_job']}/48 cells overlap main-job provider intervals; {overlap['with_other_suites']}/48 overlap its Core suites; {overlap['with_own_suites']}/48 overlap owned Core suites. Exact intervals are in `evidence/overlap-fair.json`. No overlap-based timing correction is applied.",'',
'The frozen benchmark is process-based, not an adversarial filesystem boundary. Existing baseline/main fixture-name exposure and container scratch-space caveats remain. Task12 requires Light to discover and call the initially deferred planning tool; Pi is exempt from that discovery receipt. The grader was not weakened. The fair trace audit covers 1,135 distinct calls. Pro task03 repeat2 executes two root searches that expose source-cache and sibling-run filenames; later observed reads and edits stay in its repository, with no observed foreign source-content read. This is a real workspace-scope violation qualifying the 48/48 functional grader result. Flash task05 repeat2 recovers from a rejected mistyped absolute edit path. Temporary container fixtures/cleanup and false-positive syntax fragments remain documented. The authoritative audit uses the original Linux path mapping; an invalid Mac-path audit is retained separately. Final clean-room/credential scans are recorded in STATUS.md and their evidence files.','',
f"Lifetime ledger: {proof['lifetime_ledger_entries']:,} entries; observed list-rate estimate ${proof['lifetime_observed_cost']:.6f}, conservatively charged/reserved ${proof['lifetime_reserved_charge']:.6f}, below the $15 cap. Launch shared balance was $29.26. Credentials entered Linux only through SSH stdin and process memory. Scans emit counts and paths, never matching contents.",'',
'No merge, release or deployment is included.']
(r/'REPORT.md').write_text('\n'.join(lines)+'\n')
print('Fair report rendered; final scan and PR references are appended after verification.')
