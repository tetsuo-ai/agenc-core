#!/usr/bin/env python3
"""Fixed-history head projection. Discovery-call effects require live measurement.

Replace exact known Light text, preserving provider prefixes and every history
item. Full exposure charges every originally advertised schema; demand exposure
is a clearly labelled oracle scenario, never a claim about native call counts.
"""
import copy
import json
import argparse
import collections
import hashlib
from pathlib import Path
import statistics

from project import load_auditor
from round2_project import project_body, stdin_exposed, interval, similarity, prose


def head(sections, model):
    return '\n\n'.join(sections[k] for k in (
        'workflow', 'system', 'actions_openai' if model == 'luna' else 'actions_deepseek'))


def replace_head(body, presentation, model):
    out = copy.deepcopy(body)
    if isinstance(out.get('instructions'), str):
        owner, key = out, 'instructions'
    else:
        candidates = [m for m in out.get('messages', []) if m.get('role') == 'system']
        if not candidates or not isinstance(candidates[0].get('content'), str):
            raise ValueError('Missing known Light system head')
        owner, key = candidates[0], 'content'
    old = head(presentation['legacy_sections'], model)
    new = head(presentation['sections'], model)
    if owner[key].count(old) != 1:
        raise ValueError('Unknown or ambiguous Light head; refusing broad replacement')
    deadline = '\n\n' + presentation['legacy_sections']['deadline']
    if old + deadline in owner[key]:
        old += deadline
        new += '\n\n' + presentation['sections']['deadline']
    owner[key] = owner[key].replace(old, new, 1)
    return out


def canonical_name(name):
    return 'system.searchTools' if name == 'tool2__system_x2esearchTools' else name


def selected_names(body, audit):
    """Conservative exposure: even a failed explicit selection keeps its schema."""
    selected = set()
    for call in audit.call_records(body).values():
        if canonical_name(call['name']) != 'system.searchTools':
            continue
        try:
            args = json.loads(call['arguments'])
        except (ValueError, TypeError):
            continue
        names = args.get('select', [])
        if isinstance(names, str):
            names = [names]
        if isinstance(names, list):
            selected.update(canonical_name(n) for n in names if isinstance(n, str))
        # Avoid interpreting arbitrary query prose as an instruction.
        for term in str(args.get('query', '')).split():
            if term.startswith('select:'):
                selected.add(canonical_name(term[7:]))
    return selected


def project_budget(body, presentation, model, audit, *, exposed=False,
                   demand_names=None):
    out = project_body(body, presentation, model, audit, exposed=exposed)
    out = replace_head(out, presentation, model)
    if demand_names is not None:
        # Only the four deliberately deferred builtins may be removed.
        # Unknown/external/structured schemas and real discoveries survive.
        deferred = {'Edit', 'Write', 'Grep', 'Glob'} - set(presentation['initial_tool_names'])
        allowed = set(demand_names) | selected_names(body, audit)
        out['tools'] = [t for t in out['tools'] if
                        canonical_name(t.get('function', t)['name']) not in deferred - allowed]
    return out


def summarize(runs):
    groups = collections.defaultdict(list)
    for run in runs:
        groups[(run['model'], run['panel'], run['complete'])].append(run)
    result = []
    for (model, panel, complete), group in sorted(groups.items()):
        comparisons = {}
        for baseline in ('baseline_9e61', 'baseline_97b'):
            for candidate in ('full_exposure', 'first_use_oracle'):
                clusters = collections.defaultdict(list)
                for run in group:
                    clusters[run['task']].append(run['totals'][candidate] - run['totals'][baseline])
                values = [statistics.mean(c) for c in clusters.values()]
                comparisons[baseline + '_to_' + candidate] = {
                    'baseline': sum(r['totals'][baseline] for r in group),
                    'candidate': sum(r['totals'][candidate] for r in group),
                    'mean_delta_per_task_cluster': statistics.mean(values),
                    'descriptive_fixed_trace_task_cluster_ci95': interval(values) if len(values) > 1 else None,
                }
        result.append(dict(model=model, panel=panel, complete=complete,
                           trajectories=len(group), unique_tasks=len({r['task'] for r in group}),
                           requests=sum(len(r['requests']) for r in group), comparisons=comparisons))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('audit', 'snapshot', 'response-snapshot', 'source-root', 'auditor', 'presentation', 'baseline-presentation',
                 'deepseek-tokenizer', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--candidate-sha', required=True)
    args = parser.parse_args()
    audit = load_auditor(args.auditor)
    dataset = json.loads(args.audit.read_text())
    presentation = json.loads(args.presentation.read_text())
    baseline = json.loads(args.baseline_presentation.read_text())
    response_manifest = json.loads((args.response_snapshot / 'manifest.json').read_text())
    assert set(presentation['initial_tool_names']) == {'FileRead', 'exec_command', 'system.searchTools'}
    counters = {model: audit.TokenCounter('deepseek-flash' if model == 'deepseek' else 'gpt-6-luna',
                                         args.deepseek_tokenizer) for model in ('deepseek', 'luna')}
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    result = dict(
        basis='Fixed dev history. Full exposure charges all recorded schemas; first-use oracle assumes cost-free timely discovery. Neither predicts native calls or task success.',
        candidate_sha=args.candidate_sha,
        baselines={'9e61': '9e61fa5dd4093dab255e48c201e75754ae849c3e',
                   '97b': '97b0b2d2a32dd761a1d3ddd3e1197a3814fffcde'},
        presentation_sha256=sha(args.presentation), baseline_presentation_sha256=sha(args.baseline_presentation),
        auditor_sha256=sha(args.auditor), script_sha256=sha(Path(__file__)),
        source_sha256=presentation['source_sha256'], tokenizers={m: c.identity for m, c in counters.items()},
        audit_sha256=sha(args.audit), reference_wire_sha256={},
        response_manifest_sha256=sha(args.response_snapshot / 'manifest.json'),
        response_coverage={'known': 0, 'conservative_full_exposure_fallback': 0},
        candidate_provider_usage=None, extra_discovery_calls=None, runs=[], first_heads=[], similarity=[])
    initial = {}
    for run in dataset['runs']:
        model = run['model']
        if model not in counters or run['arm'] not in ('pi', 'tr9e61'):
            continue
        previous = {k: None for k in ('baseline_9e61', 'baseline_97b', 'full_exposure', 'first_use_oracle')}
        rows = []; exposed = False; demanded = set(); discoveries = []
        for recorded in run['requests']:
            path = args.snapshot / Path(recorded['wire']).relative_to(args.source_root)
            assert sha(path) == recorded['sha256']
            wire = json.loads(path.read_text()); body = wire.get('forwarded_body', wire['body'])
            initial.setdefault((model, run['arm']), body)
            result['reference_wire_sha256'].setdefault(model + '/' + run['arm'], recorded['sha256'])
            if run['arm'] != 'tr9e61':
                break
            assert run['build'] == result['baselines']['9e61']
            exposed = exposed or stdin_exposed(body, audit)
            # Oracle means these schemas exist before the fixed response that
            # needs them. Actual models must discover first; that cost is unknown.
            response_path = (args.response_snapshot / Path(recorded['wire']).relative_to(args.source_root)
                             ).with_name(f"response-{recorded['index']:03d}.txt")
            response_entry = response_manifest['responses'].get(recorded['wire'])
            if response_entry is None:
                needed = {'Edit', 'Write', 'Grep', 'Glob'}
                response_hash = None
                result['response_coverage']['conservative_full_exposure_fallback'] += 1
            else:
                assert response_entry['wire_sha256'] == recorded['sha256']
                assert sha(response_path) == response_entry['response_sha256']
                needed = {canonical_name(call['name']) for call in audit.parse_response(response_path)['calls']}
                response_hash = sha(response_path)
                result['response_coverage']['known'] += 1
            needed &= {'Edit', 'Write', 'Grep', 'Glob'}
            # Registry discovery survives history compaction. Keep selections
            # from earlier requests even if their calls later leave the body.
            demanded.update(selected_names(body, audit) & {'Edit', 'Write', 'Grep', 'Glob'})
            additions = needed - demanded
            if additions:
                discoveries.append(dict(before_request=recorded['index'], names=sorted(additions),
                                        response_sha256=response_hash, native_discovery_cost=None,
                                        conservative_missing_response=response_entry is None))
            demanded.update(needed)
            bodies = dict(
                baseline_9e61=body,
                baseline_97b=project_body(body, baseline, model, audit, exposed=exposed),
                full_exposure=project_budget(body, presentation, model, audit, exposed=exposed),
                first_use_oracle=project_budget(body, presentation, model, audit,
                                               exposed=exposed, demand_names=demanded))
            row = dict(index=recorded['index'], wire_sha256=recorded['sha256'], response_sha256=response_hash,
                       demanded=sorted(demanded), stdin_exposed=exposed)
            for kind, projected in bodies.items():
                if kind in ('full_exposure', 'first_use_oracle'):
                    # Reverse only the exact head edit. Every original field
                    # other than tools must then compare equal, including reasoning.
                    reverse = dict(presentation, sections=presentation['legacy_sections'],
                                   legacy_sections=presentation['sections'])
                    reverted = replace_head(projected, reverse, model)
                    assert {k: v for k, v in reverted.items() if k != 'tools'} == {
                        k: v for k, v in body.items() if k != 'tools'}
                counts = audit.request_components(projected, previous[kind], counters[model])
                row[kind] = dict(total=counts['local_input_estimate'], components=counts['components'])
                if kind == 'baseline_9e61':
                    assert row[kind]['total'] == recorded['local_total']
                previous[kind] = projected
            rows.append(row)
        if rows:
            result['runs'].append({k: run[k] for k in ('model', 'panel', 'task', 'cell', 'complete')} | dict(
                requests=rows, required_oracle_selections=discoveries,
                totals={k: sum(r[k]['total'] for r in rows) for k in previous}))
    result['summary'] = summarize(result['runs'])
    canonical = lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    system = lambda b: b.get('instructions', '') + '\n' + '\n'.join(
        text for m in audit.items(b) if m.get('role') in ('system', 'developer')
        for text in audit.text_parts(m.get('content')))
    for model, count in counters.items():
        base = initial[(model, 'tr9e61')]
        first = project_budget(base, presentation, model, audit, demand_names=set())
        tool_tokens = count(audit.compact(first['tools']))
        system_tokens = count(system(first).strip())
        result['first_heads'].append(dict(model=model, system=system_tokens, tools=tool_tokens,
                                          total=system_tokens + tool_tokens,
                                          deadline_increment=count(presentation['sections']['deadline'])))
        pi = initial[(model, 'pi')]
        for label, candidate in [('initial', first), ('all_recorded_tools',
                project_budget(base, presentation, model, audit, exposed=True))]:
            ours = [t.get('function', t) for t in candidate['tools']]
            theirs = [t.get('function', t) for t in pi['tools']]
            result['similarity'].append(dict(model=model, exposure=label,
                system=similarity(system(candidate), system(pi)),
                tool_prose=similarity('\n'.join(prose(ours)), '\n'.join(prose(theirs))),
                full_definitions=similarity(canonical(ours), canonical(theirs)),
                identical_definitions=len({canonical(t) for t in ours} & {canonical(t) for t in theirs})))
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: result[k] for k in ('first_heads', 'summary', 'similarity')}, indent=2))


if __name__ == '__main__':
    main()
