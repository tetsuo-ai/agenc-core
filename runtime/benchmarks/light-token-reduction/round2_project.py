#!/usr/bin/env python3
"""Project source-exported schema changes onto frozen 9e61 dev requests.

No history/payload/arguments/reasoning rewriting or candidate provider usage.
Exact source-output changes use tr's exporter and tk's audited token partition.
"""
import argparse
import collections
import copy
import difflib
import hashlib
import json
from pathlib import Path
import random
import re
import statistics

from project import load_auditor


def stdin_exposed(body, audit):
    calls = audit.call_records(body)
    for call in calls.values():
        if call['name'] != 'tool2__system_x2esearchTools':
            continue
        try:
            args = json.loads(call['arguments'])
        except (ValueError, TypeError):
            continue
        selected = args.get('select', [])
        if isinstance(selected, str):
            selected = [selected]
        if 'write_stdin' in selected or re.search(r'\bselect:write_stdin\b', str(args.get('query',''))):
            # Conservative if discovery failed: retain rather than overclaim.
            return True
    for item in audit.items(body):
        cid = item.get('tool_call_id', item.get('call_id'))
        if calls.get(cid, {}).get('name') != 'exec_command':
            continue
        text = item.get('content', item.get('output'))
        if not isinstance(text, str):
            continue
        # Last actual exec footer, not an earlier lookalike in stdout. This
        # is a projection over runtime captures, not a product trust parser.
        footers = re.findall(r'(?m)^\[exec ([^\n]*)\]$', text)
        if footers and re.search(r'\bsession_id=\d+\b', footers[-1]) and 'detached=true' not in footers[-1]:
            return True
    return False


def project_body(body, presentation, model, audit, mechanism='combined', exposed=False):
    out = copy.deepcopy(body)
    if mechanism in ('descriptions','combined'):
        schemas = {t.get('function',t)['name']:t for t in presentation['fixtures'][model]['tools']}
        out['tools'] = [copy.deepcopy(schemas.get(t.get('function',t)['name'],t)) for t in out['tools']]
    if mechanism in ('stdin','combined') and not exposed:
        # All other recorded tools, including discovered/external tools, stay.
        out['tools'] = [t for t in out['tools'] if t.get('function',t)['name'] != 'write_stdin']
    return out


def interval(values):
    rng = random.Random(20261002)
    draws = sorted(statistics.mean(rng.choices(values,k=len(values))) for _ in range(10000))
    return [draws[249],draws[9749]]


def summarize_runs(runs):
    """Keep original/restarted panels separate; resample task clusters within each.

    These describe the frozen available traces, not complete live experiments.
    Complete only means the audit found a result record, not outcome validity.
    """
    groups = collections.defaultdict(list)
    for run in runs:
        groups[(run['model'], run['panel'], run['complete'])].append(run)
    summaries = []
    for (model, panel, complete), group in sorted(groups.items()):
        summary = {'model': model, 'panel': panel, 'complete': complete,
                   'trajectories': len(group), 'unique_tasks': len({r['task'] for r in group}),
                   'requests': sum(len(r['requests']) for r in group), 'mechanisms': {}}
        for mechanism in ('stdin', 'descriptions', 'combined'):
            by_task = collections.defaultdict(list)
            for run in group:
                by_task[run['task']].append(run['totals'][mechanism] - run['totals']['baseline'])
            cluster_means = [statistics.mean(values) for values in by_task.values()]
            baseline = sum(r['totals']['baseline'] for r in group)
            candidate = sum(r['totals'][mechanism] for r in group)
            summary['mechanisms'][mechanism] = {
                'baseline': baseline, 'candidate': candidate, 'delta': candidate - baseline,
                'mean_delta_per_task_cluster': statistics.mean(cluster_means),
                'descriptive_fixed_trace_task_cluster_ci95': interval(cluster_means) if len(cluster_means) > 1 else None,
            }
        summaries.append(summary)
    return summaries


def prose(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'description' and isinstance(child,str):
                yield child
            elif isinstance(child,(list,dict)):
                yield from prose(child)
    elif isinstance(value,list):
        for child in value:
            yield from prose(child)


def words(text):
    return re.findall(r'\w+', text.lower())


def similarity(ours, reference):
    a,b = words(ours),words(reference)
    grams = lambda seq:{tuple(seq[i:i+8]) for i in range(max(0,len(seq)-7))}
    ag,bg=grams(a),grams(b)
    return {'words':len(a),'reference_words':len(b),
            'common_unique_8grams':len(ag&bg),'unique_8grams':len(ag),
            'common_fraction':len(ag&bg)/len(ag) if ag else 0,
            'longest_common_word_run':difflib.SequenceMatcher(None,a,b,autojunk=False).find_longest_match().size}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--audit',type=Path,required=True)
    ap.add_argument('--snapshot',type=Path,required=True)
    ap.add_argument('--source-root',type=Path,required=True)
    ap.add_argument('--auditor',type=Path,required=True)
    ap.add_argument('--presentation',type=Path,required=True)
    ap.add_argument('--deepseek-tokenizer',type=Path,required=True)
    ap.add_argument('--candidate-sha',required=True)
    ap.add_argument('--out',type=Path,required=True)
    args=ap.parse_args()
    audit=load_auditor(args.auditor)
    dataset=json.loads(args.audit.read_text())
    presentation=json.loads(args.presentation.read_text())
    assert 'write_stdin' not in presentation['initial_tool_names']
    assert len(presentation['initial_tool_names'])==7
    counters={model:audit.TokenCounter('deepseek-flash' if model=='deepseek' else 'gpt-6-'+model,args.deepseek_tokenizer) for model in ('deepseek','luna')}
    result={'basis':'fixed dev trajectories; candidate provider usage/cache/output unknown; no success or timing claim',
            'baseline_sha':'9e61fa5dd4093dab255e48c201e75754ae849c3e','candidate_sha':args.candidate_sha,
            'auditor_sha256':hashlib.sha256(args.auditor.read_bytes()).hexdigest(),
            'presentation_sha256':hashlib.sha256(args.presentation.read_bytes()).hexdigest(),
            'source_sha256':presentation['source_sha256'],'tokenizers':{m:c.identity for m,c in counters.items()},
            'candidate_provider_usage':None,'runs':[],'summary':[],'similarity':[]}
    initial={}
    for run in dataset['runs']:
        model=run['model']
        if model not in counters:continue
        previous={kind:None for kind in ('baseline','stdin','descriptions','combined')}
        rows=[];exposed=False
        for recorded in run['requests']:
            path=args.snapshot/Path(recorded['wire']).relative_to(args.source_root)
            raw=path.read_bytes()
            assert hashlib.sha256(raw).hexdigest()==recorded['sha256']
            wire=json.loads(raw);body=wire.get('forwarded_body',wire['body'])
            initial.setdefault((model,run['arm']),body)
            if run['arm']!='tr9e61':break
            assert run['build']==result['baseline_sha']
            exposed = exposed or stdin_exposed(body,audit)
            row={'index':recorded['index'],'wire_sha256':recorded['sha256'],'stdin_exposed':exposed}
            for kind in previous:
                projected=body if kind=='baseline' else project_body(body,presentation,model,audit,kind,exposed)
                counts=audit.request_components(projected,previous[kind],counters[model])
                row[kind]={'total':counts['local_input_estimate'],'components':counts['components']}
                if kind=='baseline':
                    assert row[kind]['total']==recorded['local_total']
                else:
                    assert {k:v for k,v in projected.items() if k!='tools'}=={k:v for k,v in body.items() if k!='tools'}
                previous[kind]=projected
            rows.append(row)
        if rows:
            result['runs'].append({k:run[k] for k in ('model','task','cell','panel','complete')}|{'requests':rows,'totals':{k:sum(r[k]['total'] for r in rows) for k in previous}})
    result['summary'] = summarize_runs(result['runs'])
    for model in counters:
        if (model,'pi') not in initial or (model,'tr9e61') not in initial:continue
        pi=initial[(model,'pi')];base=initial[(model,'tr9e61')]
        candidate=project_body(base,presentation,model,audit,exposed=False)
        system=lambda b:(b.get('instructions','')+'\n'+'\n'.join(t for m in audit.items(b) if m.get('role') in ('system','developer') for t in audit.text_parts(m.get('content'))))
        for label,body in [('9e61',base),('candidate',candidate)]:
            result['similarity'].append({'model':model,'version':label,'system':similarity(system(body),system(pi)),
                'tool_prose':similarity('\n'.join(prose(body.get('tools',[]))),'\n'.join(prose(pi.get('tools',[]))))})
    args.out.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'summary':result['summary'],'similarity':result['similarity']},indent=2))


if __name__=='__main__':main()
