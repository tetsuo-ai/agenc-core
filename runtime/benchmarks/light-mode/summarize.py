#!/usr/bin/env python3
"""Offline Light benchmark accounting. Failed runs are never filtered out.

Run analysis and self-tests on Linux. No network or credential access.
"""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import datetime
import hashlib
import json
import math
import re
from pathlib import Path
import statistics
import sys
import tempfile

AGENTS = ('pi', 'normal', 'light')
METRICS = ('input_tokens', 'cached_tokens', 'uncached_tokens', 'output_tokens',
           'total_tokens', 'cost_usd', 'budget_charge_usd', 'wall_seconds',
           'model_calls', 'tool_calls', 'first_system_chars', 'first_schema_chars')
ANATOMY = ('request_chars_sum', 'system_chars_sum', 'schema_chars_sum',
           'user_chars_sum', 'assistant_chars_sum', 'tool_result_chars_sum',
           'other_chars_sum', 'system_change_events', 'schema_change_events',
           'history_rewrite_events', 'wire_calls')


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def serialized(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def sampling(body):
    reasoning = body.get('reasoning') or {}
    return {'model': body.get('model'),
            'reasoning_effort': reasoning.get('effort') if isinstance(reasoning, dict) and reasoning.get('effort') is not None else body.get('reasoning_effort'),
            'thinking': body.get('thinking'),
            'output_cap': next((body[k] for k in ('max_tokens', 'max_completion_tokens', 'max_output_tokens') if body.get(k) is not None), None),
            'temperature': body.get('temperature'), 'top_p': body.get('top_p')}


def anatomy(directory):
    result = dict.fromkeys(ANATOMY, 0)
    errors = []
    previous_head = previous_schema = previous_history = None
    first_sampling = None
    sampling_signatures = set()
    wire_models = set()
    system_hashes = []
    schema_hashes = []
    for path in sorted(directory.glob('wire-*.json')):
        try:
            body = json.loads(path.read_text())['body']
            if not isinstance(body, dict): raise ValueError('body is not an object')
            messages = body.get('messages', body.get('input', []))
            if not isinstance(messages, list): raise ValueError('messages/input must be an array')
        except (ValueError, OSError, KeyError, TypeError):
            errors.append(path.name)
            continue
        sampling_signatures.add(serialized(sampling(body)))
        wire_models.add(str(body.get('model')))
        if first_sampling is None:
            first_sampling = sampling(body)
        head = []
        history = []
        if body.get('instructions') is not None:
            head.append(body['instructions'])
            result['system_chars_sum'] += len(serialized(body['instructions']))
        for message in messages:
            if not isinstance(message, dict):
                result['other_chars_sum'] += len(serialized(message)); history.append(message); continue
            role, kind = message.get('role'), message.get('type')
            chars = len(serialized(message))
            if role in ('system', 'developer'):
                head.append(message); result['system_chars_sum'] += chars
            else:
                history.append(message)
                if role == 'tool' or kind == 'function_call_output': result['tool_result_chars_sum'] += chars
                elif role == 'assistant' or kind in ('function_call', 'reasoning'): result['assistant_chars_sum'] += chars
                elif role == 'user': result['user_chars_sum'] += chars
                else: result['other_chars_sum'] += chars
        system_hashes.append(hashlib.sha256(serialized(head).encode()).hexdigest())
        schema = body.get('tools', [])
        schema_hashes.append(hashlib.sha256(serialized(schema).encode()).hexdigest())
        result['schema_chars_sum'] += len(serialized(schema))
        result['request_chars_sum'] += len(serialized(body))
        result['wire_calls'] += 1
        if previous_head is not None:
            result['system_change_events'] += head != previous_head
            result['schema_change_events'] += schema != previous_schema
            result['history_rewrite_events'] += history[:len(previous_history)] != previous_history
        previous_head, previous_schema, previous_history = head, schema, history
    result['capture_errors'] = errors
    result['sampling'] = first_sampling
    result['sampling_signatures'] = sorted(sampling_signatures)
    result['wire_models'] = sorted(wire_models)
    result['system_prefix_hashes_by_call'] = system_hashes
    result['system_prefix_distinct_hashes'] = sorted(set(system_hashes))
    result['system_prefix_versions'] = len(set(system_hashes))
    result['schema_hashes_by_call'] = schema_hashes
    result['schema_versions'] = len(set(schema_hashes))
    return result


def read_runs(root):
    runs, malformed, orphans = [], [], []
    for directory in sorted(p for p in root.iterdir() if p.is_dir()):
        path = directory/'result.json'
        if not path.exists():
            if re.search(r'-(?:pi|normal|light)-r[0-9]+$', directory.name) or any(directory.glob('wire-*.json')) or (directory/'agent.log').exists() or (directory/'setup.log').exists():
                orphans.append(directory.name)
            continue
        try:
            run = json.loads(path.read_text())
            if not isinstance(run, dict) or not all(isinstance(run.get(k), str) for k in ('phase', 'task', 'agent', 'model')):
                raise ValueError('missing identity')
            if run['agent'] not in AGENTS: raise ValueError('unknown agent')
        except (ValueError, OSError, TypeError):
            malformed.append(str(path)); continue
        run = dict(run)
        run['_path'] = str(path)
        run['_dir_name'] = directory.name
        run['_anatomy'] = anatomy(directory)
        run['_sampling'] = run['_anatomy']['sampling'] or sampling(run.get('sampling', {}))
        if number(run.get('input_tokens')) and number(run.get('output_tokens')):
            run['total_tokens'] = run['input_tokens'] + run['output_tokens']
        else:
            run['total_tokens'] = None
        runs.append(run)
    return runs, malformed, orphans


def effective_pass(run):
    """Keep legacy runner pass=true/timeouts from becoming successful tasks."""
    if run.get('_unfinished') or not isinstance(run.get('pass'),bool): return None
    if run.get('timeout') or run.get('budget_stop') or run.get('provider_unavailable'): return False
    if not isinstance(run.get('check_pass'),bool) or run.get('exit_code') is None: return None
    return run['pass'] and run['check_pass'] and run['exit_code']==0


def flags(run):
    result = []
    if run.get('_unfinished'): result.append('unfinished_attempt')
    if run.get('_malformed'): result.append('malformed_result')
    if run.get('usage_complete') is not True: result.append('usage_incomplete')
    if run.get('timeout'): result.append('timeout')
    if run.get('budget_stop'): result.append('budget_stop')
    if run.get('provider_unavailable'): result.append('provider_unavailable')
    if run.get('pass') is True and effective_pass(run) is False: result.append('reported_pass_contradiction')
    if run.get('exit_code') != 0: result.append('process_failure')
    if not number(run.get('model_calls')) or run.get('model_calls') == 0: result.append('no_model_calls')
    if run.get('provider_errors', 0): result.append('provider_errors')
    if run.get('infrastructure_error') or run.get('infrastructure_failure'): result.append('explicit_infrastructure_failure')
    if not isinstance(run.get('pass'), bool): result.append('missing_pass_status')
    if not isinstance(run.get('check_pass'),bool): result.append('missing_check_status')
    if not all(number(run.get(k)) for k in ('input_tokens','cached_tokens','uncached_tokens','output_tokens','wall_seconds','model_calls','tool_calls')):
        result.append('missing_metrics')
    if all(number(run.get(k)) for k in ('input_tokens','cached_tokens','uncached_tokens')) and run['input_tokens'] != run['cached_tokens'] + run['uncached_tokens']:
        result.append('input_accounting_mismatch')
    if run.get('cost_basis') != 'subscription-unpriced' and not all(number(run.get(k)) for k in ('cost_usd','budget_charge_usd')):
        result.append('missing_priced_cost')
    if run['_anatomy']['capture_errors']: result.append('malformed_wire_capture')
    if len(run['_anatomy']['sampling_signatures']) > 1: result.append('sampling_changed_within_run')
    if any(m != run['model'] for m in run['_anatomy']['wire_models']): result.append('wire_model_mismatch')
    if run['_anatomy']['wire_calls'] != run.get('model_calls'): result.append('wire_count_mismatch')
    return result


def wall_distribution(runs):
    values = sorted(r['wall_seconds'] for r in runs if number(r.get('wall_seconds')))
    complete = bool(runs) and len(values) == len(runs)
    return {'median': statistics.median(values) if complete else None,
            'p90': values[math.ceil(len(values) * .9) - 1] if complete else None,
            'method': 'median; p90 nearest rank; all attempts including failures'}


def aggregate(runs):
    count = len(runs)
    passed = sum(effective_pass(r) is True for r in runs)
    outcome_runs = sum(effective_pass(r) is not None for r in runs)
    failed = sum(effective_pass(r) is False for r in runs)
    completed = sum(r.get('exit_code') == 0 and not r.get('timeout') and not r.get('budget_stop') and not r.get('provider_unavailable') for r in runs)
    sums, means, observed, counts, observed_counts = {}, {}, {}, {}, {}
    usage_metrics = {'input_tokens','cached_tokens','uncached_tokens','output_tokens','total_tokens','cost_usd','tool_calls'}
    for metric in METRICS:
        values = [r[metric] for r in runs if number(r.get(metric))]
        known = [r[metric] for r in runs if number(r.get(metric)) and (metric not in usage_metrics or r.get('usage_complete') is True)]
        counts[metric] = len(known)
        observed_counts[metric] = len(values)
        observed[metric] = sum(values)
        sums[metric] = sum(values) if count and len(known) == count else None
        means[metric] = sums[metric] / count if sums[metric] is not None else None
    flag_counts = Counter(flag for run in runs for flag in flags(run))
    repeats = [r.get('repeat') for r in runs]
    repeat_counts = Counter(str(r) for r in repeats)
    total_cost = sums['cost_usd']
    cached_fraction = sums['cached_tokens']/sums['input_tokens'] if sums['input_tokens'] and sums['cached_tokens'] is not None else None
    return {'runs': count, 'result_files': sum(not r.get('_unfinished') for r in runs),
            'unfinished_attempts': sum(bool(r.get('_unfinished')) for r in runs), 'distinct_repeats': sorted({r for r in repeats if isinstance(r,int) and not isinstance(r,bool)}),
            'duplicate_repeats': sorted(k for k,v in repeat_counts.items() if v>1),
            'passed': passed, 'failed': failed, 'outcome_runs':outcome_runs,'unknown_outcomes':count-outcome_runs,
            'pass_rate': passed/count if count and outcome_runs==count else None,
            'observed_pass_rate':passed/outcome_runs if outcome_runs else None,
            'reported_passed':sum(r.get('pass') is True for r in runs),
            'check_passed': sum(r.get('check_pass') is True for r in runs),
            'coding_passed': sum(r.get('check_pass') is True for r in runs),
            'timeout_runs':sum(bool(r.get('timeout')) for r in runs),
            'provider_affected_runs':sum(bool(r.get('provider_errors') or r.get('provider_unavailable')) for r in runs),
            'completed_runs': completed, 'incomplete_runs': count-completed,
            'wall_seconds': wall_distribution(runs),
            'sums': sums, 'means': means, 'observed_sums': observed, 'metric_counts': counts, 'observed_metric_counts':observed_counts,
            'cost_per_completed_run_usd': total_cost/completed if total_cost is not None and completed else None,
            'cost_per_passed_task_usd': total_cost/passed if total_cost is not None and passed else None,
            'cached_input_fraction': cached_fraction,
            'usage_complete_runs': sum(r.get('usage_complete') is True for r in runs),
            'flags': dict(sorted(flag_counts.items())),
            'anatomy_sums': {k:sum(r['_anatomy'][k] for r in runs) for k in ANATOMY},
            'prefix_stability':{'captured_runs':sum(r['_anatomy']['wire_calls']>0 for r in runs),
                                'stable_runs':sum(r['_anatomy']['system_prefix_versions']==1 for r in runs),
                                'changed_runs':sum(r['_anatomy']['system_prefix_versions']>1 for r in runs),
                                'missing_capture_runs':sum(r['_anatomy']['wire_calls']==0 for r in runs)},
            'cost_bases':sorted({r.get('cost_basis','reported') for r in runs if not r.get('_unfinished')}),
            'prompt_sha256': sorted({r['prompt_sha256'] for r in runs if r.get('prompt_sha256')}),
            'harness_sha256': sorted({r['harness_sha256'] for r in runs if r.get('harness_sha256')}),
            'agent_revisions': sorted({r['agent_revision'] for r in runs if r.get('agent_revision')}),
            'sampling_signatures': sorted({signature for r in runs for signature in (r['_anatomy']['sampling_signatures'] or [serialized(r['_sampling'])])}),
            'load_1m_start_mean': statistics.mean(r['load_start'][0] for r in runs if isinstance(r.get('load_start'),list) and r['load_start']) if any(isinstance(r.get('load_start'),list) and r['load_start'] for r in runs) else None,
            'run_ids': [r.get('id',r['_dir_name']) for r in runs]}


def comparison(pi, light):
    complete_usage = all(g['usage_complete_runs']==g['runs'] and g['runs']>0 for g in (pi,light))
    tokens = (light['means']['total_tokens'] <= pi['means']['total_tokens']) if complete_usage and light['means']['total_tokens'] is not None and pi['means']['total_tokens'] is not None else None
    quality = light['pass_rate'] >= pi['pass_rate'] if light['pass_rate'] is not None and pi['pass_rate'] is not None else None
    ratio = light['means']['total_tokens']/pi['means']['total_tokens'] if complete_usage and light['means']['total_tokens'] is not None and pi['means']['total_tokens'] else None
    median = light['wall_seconds']['median'] < pi['wall_seconds']['median'] if all(g['wall_seconds']['median'] is not None for g in (pi,light)) else None
    p90 = light['wall_seconds']['p90'] < pi['wall_seconds']['p90'] if all(g['wall_seconds']['p90'] is not None for g in (pi,light)) else None
    return {'tokens_at_most_pi': tokens, 'pass_rate_at_least_pi': quality,
            'wall_median_lower_than_pi': median, 'wall_p90_lower_than_pi': p90,
            'light_to_pi_token_ratio': ratio, 'raw_metrics_meet_target': tokens is True and quality is True,
            'all_owner_metrics_met': tokens is True and quality is True and median is True and p90 is True}


def summarize(root, manifest_tasks, candidate_phase, baseline_phase, models, required_runs, confirmatory=False):
    if confirmatory and (candidate_phase != baseline_phase or not candidate_phase.startswith('candidate')):
        raise ValueError('Confirmatory cohort must use one explicitly named candidate phase')
    if not confirmatory and candidate_phase == baseline_phase: raise ValueError('Candidate phase must differ from baseline phase')
    if len(manifest_tasks) != len(set(manifest_tasks)): raise ValueError('Duplicate task selectors')
    if len(models) != len(set(models)): raise ValueError('Duplicate model selectors')
    runs, malformed, orphans = read_runs(root)
    result_file_count = len(runs)
    result_counts_by_phase = dict(Counter(r['phase'] for r in runs))
    completed_counts_by_phase = dict(Counter(r['phase'] for r in runs if r.get('exit_code')==0 and not r.get('timeout')))
    available_models = sorted({r['model'] for r in runs})
    models = models or available_models
    # Preserve selected attempts that failed before the runner could write result.json.
    # All unavailable metrics remain unknown, so their means cannot look artificially cheap.
    malformed_dirs = {Path(path).parent.name for path in malformed}
    for name in sorted(set(orphans) | malformed_dirs):
        for model in models:
            for task in manifest_tasks:
                for agent in AGENTS:
                    phase = candidate_phase if agent == 'light' else baseline_phase
                    prefix = f'{phase}-{model}-{task}-{agent}-r'
                    if not name.startswith(prefix) or not name[len(prefix):].isdigit(): continue
                    runs.append({'id':name,'phase':phase,'model':model,'task':task,'agent':agent,
                                 'repeat':int(name[len(prefix):]),'pass':False,'usage_complete':False,
                                 '_unfinished':True,'_malformed':name in malformed_dirs,
                                 '_path':str(root/name/'result.json'),'_dir_name':name,
                                 '_anatomy':anatomy(root/name),'_sampling':sampling({})})
    groups = defaultdict(list)
    for run in runs:
        groups[(run['model'],run['task'],run['phase'],run['agent'])].append(run)
    all_groups = [{'model':m,'task':t,'phase':p,'agent':a,**aggregate(rs)} for (m,t,p,a),rs in sorted(groups.items())]
    reports = []
    for model in models:
        task_reports = []
        model_selected = {a:[] for a in AGENTS}
        diagnostic_light = []
        for task in manifest_tasks:
            selected = {a:groups[(model,task,candidate_phase if a=='light' else baseline_phase,a)] for a in AGENTS}
            summaries = {a:aggregate(selected[a]) for a in AGENTS}
            diag_runs = [] if confirmatory else groups[(model,task,baseline_phase,'light')]
            diag = aggregate(diag_runs)
            diagnostic_light.extend(diag_runs)
            blockers, warnings = [], []
            for agent in AGENTS:
                model_selected[agent].extend(selected[agent])
                group = summaries[agent]
                if len(group['distinct_repeats']) < required_runs: blockers.append(f'{agent}:fewer_than_{required_runs}_distinct_repeats')
                if group['duplicate_repeats']: blockers.append(f'{agent}:duplicate_repeats')
                for flag in group['flags']:
                    blockers.append(f'{agent}:{flag}')
                if any(not r.get('prompt_sha256') for r in selected[agent]): blockers.append(f'{agent}:missing_prompt_digest')
                if len(group['agent_revisions']) > 1: blockers.append(f'{agent}:mixed_agent_revisions')
                if any(not r.get('agent_revision') for r in selected[agent]): warnings.append(f'{agent}:missing_agent_revision')
                if any(not r.get('harness_sha256') for r in selected[agent]): warnings.append(f'{agent}:missing_harness_digest')
                prefix=f'{candidate_phase if agent=="light" else baseline_phase}-{model}-{task}-{agent}-r'
                if any(name.startswith(prefix) for name in orphans): blockers.append(f'{agent}:unfinished_run_directory')
            combined = sum(selected.values(), [])
            prompt_hashes = {r.get('prompt_sha256') for r in combined if r.get('prompt_sha256')}
            if len(prompt_hashes) > 1: blockers.append('prompt_mismatch')
            signatures = {signature for r in combined for signature in (r['_anatomy']['sampling_signatures'] or [serialized(r['_sampling'])])}
            if len(signatures) > 1: blockers.append('sampling_mismatch')
            if any(not r['_sampling'].get('model') for r in combined): blockers.append('missing_sampling_evidence')
            if len({r.get('harness_sha256') for r in combined if r.get('harness_sha256')}) > 1: warnings.append('harness_digest_changed_review_needed')
            if len({s['runs'] for s in summaries.values()}) > 1: warnings.append('unequal_run_counts_all_runs_retained')
            if confirmatory: warnings.append('original_light_baseline_not_in_confirmatory_cohort')
            elif diag['runs'] < required_runs: warnings.append('baseline_light_diagnostic_incomplete')
            check = comparison(summaries['pi'], summaries['light'])
            check['no_pi_completed_task_lost'] = summaries['pi']['passed'] == 0 or (summaries['light']['runs'] > 0 and summaries['light']['passed'] == summaries['light']['runs'])
            check['accepted'] = not blockers and check['raw_metrics_meet_target'] and check['no_pi_completed_task_lost']
            check['status'] = 'insufficient_evidence' if blockers else 'pass' if check['accepted'] else 'fail'
            # The owner comparison is Pi versus Light. Missing normal-mode usage
            # still blocks the complete three-way study, but cannot change a
            # fully observed Pi/Light result. Observed failures count in quality
            # and time; they are not themselves missing performance evidence.
            outcome_flags = {'timeout', 'budget_stop', 'process_failure',
                             'reported_pass_contradiction', 'provider_errors', 'provider_unavailable'}
            owner_blockers = [b for b in blockers if not b.startswith('normal:')
                              and not (b.startswith(('pi:', 'light:')) and b.split(':',1)[1] in outcome_flags)]
            check['owner_target_accepted'] = not owner_blockers and check['raw_metrics_meet_target'] and check['no_pi_completed_task_lost']
            task_reports.append({'task':task,'agents':summaries,'baseline_light':diag,
                                 'acceptance':check,'blockers':sorted(set(blockers)),
                                 'owner_blockers':sorted(set(owner_blockers)),'warnings':sorted(set(warnings))})
        totals = {a:aggregate(model_selected[a]) for a in AGENTS}
        total_check = comparison(totals['pi'], totals['light'])
        model_blockers = [f'{agent}:mixed_agent_revisions_across_tasks' for agent in AGENTS if len(totals[agent]['agent_revisions']) > 1]
        balanced = {}
        for agent in AGENTS:
            values = [t['agents'][agent]['means']['total_tokens'] for t in task_reports]
            quality = [t['agents'][agent]['pass_rate'] for t in task_reports]
            balanced[agent] = {'mean_total_tokens':statistics.mean(values) if values and all(v is not None for v in values) else None,
                               'mean_pass_rate':statistics.mean(quality) if quality and all(v is not None for v in quality) else None}
        balanced_target = (all(balanced[a][k] is not None for a in ('pi','light') for k in ('mean_total_tokens','mean_pass_rate'))
                           and balanced['light']['mean_total_tokens'] <= balanced['pi']['mean_total_tokens']
                           and balanced['light']['mean_pass_rate'] >= balanced['pi']['mean_pass_rate'])
        total_check['task_balanced_target_met'] = balanced_target
        total_check['accepted'] = not model_blockers and bool(task_reports) and all(t['acceptance']['accepted'] for t in task_reports) and total_check['all_owner_metrics_met'] and balanced_target
        owner_model_blockers = [b for b in model_blockers if not b.startswith('normal:')]
        total_check['owner_target_accepted'] = not owner_model_blockers and bool(task_reports) and all(t['acceptance']['owner_target_accepted'] for t in task_reports) and total_check['all_owner_metrics_met'] and balanced_target
        reports.append({'model':model,'tasks':task_reports,'totals':totals,
                        'task_balanced_means':balanced,'baseline_light_totals':aggregate(diagnostic_light),
                        'acceptance':total_check,'blockers':model_blockers})
    selected_paths = {r['_path'] for r in runs if r['task'] in manifest_tasks and r['model'] in models and ((r['phase']==baseline_phase and r['agent'] in ('pi','normal')) or (r['phase']==candidate_phase and r['agent']=='light'))}
    selected_result_count = sum(r['_path'] in selected_paths and not r.get('_unfinished') for r in runs)
    excluded = Counter(r['phase'] for r in runs if r['_path'] not in selected_paths)
    return {'schema_version':1, 'generated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'runs_root':str(root), 'selection':{'baseline_phase':baseline_phase,'candidate_phase':candidate_phase,
            'cohort_type':'confirmatory' if confirmatory else 'primary','original_light_baseline_available':not confirmatory,
            'tasks':manifest_tasks,'models':models,'required_distinct_repeats':required_runs,
            'policy':'All result files in exactly selected phase/agent groups, including failures. No best-run selection.'},
            'inventory':{'result_files':result_file_count,'selected_result_files':selected_result_count,'selected_attempts':len(selected_paths),'result_files_by_phase':result_counts_by_phase,
                         'normal_exit_results_by_phase':completed_counts_by_phase,'available_models':available_models,
                         'available_phases':sorted({r['phase'] for r in runs}), 'unselected_counts_by_phase':dict(excluded),
                         'malformed_result_files':malformed,'unfinished_run_directories':orphans},
            'models':reports,'all_phase_groups':all_groups,
            'run_diagnostics':[{'id':r.get('id',r['_dir_name']),'path':r['_path'],'phase':r['phase'],
                                'model':r['model'],'task':r['task'],'agent':r['agent'],
                                'selected':r['_path'] in selected_paths,'flags':flags(r),
                                'usage_complete':r.get('usage_complete') is True,
                                'reported_pass':r.get('pass'),'effective_pass':effective_pass(r),
                                'artifact_check_pass':r.get('check_pass'),'stop_reason':r.get('stop_reason'),
                                'anatomy':r['_anatomy']} for r in runs],
            'accepted':bool(reports) and all(m['acceptance']['accepted'] for m in reports),
            'owner_target_accepted':bool(reports) and all(m['acceptance']['owner_target_accepted'] for m in reports),
            'limitations':['Wall p90 uses nearest rank across all selected attempts. Median and p90 must both be strictly lower in each model; no Pi-completed task may have a failed Light repeat.',
                           'The separate owner_target_accepted gate compares fully observed Pi and Light attempts. Missing normal-mode usage still blocks complete three-way study acceptance. Observed Pi/Light failures remain in quality, token, cost and wall-time denominators.',
                           'At least two runs per cell is an exploratory sample, not statistical proof for all coding tasks.',
                           'Failed coding, timeout, process, and provider-error runs remain in every selected denominator and token/cost total.',
                           'Unknown numeric metrics are not replaced by zero. Observed sums are partial when coverage is incomplete.',
                           'Selected unfinished or malformed attempts remain in attempt counts with unknown outcome; they are not fabricated coding failures. Unknown metrics block complete means and acceptance.',
                           'Task pass is conservatively recomputed: a timeout, budget stop, unavailable provider, failed check, or abnormal exit cannot be a passing agent task even if legacy result.pass is true.',
                           'Character anatomy describes serialized request structure, not tokenizer counts or a provider cache implementation.',
                           'Raw cumulative totals depend on run count; pooled and equal-task-weight means are both checked.',
                           'Wall time may be confounded by shared-host load; inspect recorded load metadata.',
                           'Different harness digests are reported for review, never silently treated as identical.']}


def format_number(value, digits=0):
    return 'unknown' if value is None else f'{value:,.{digits}f}'


def markdown(report):
    lines=['# Light benchmark comparison','',f"Selected baseline `{report['selection']['baseline_phase']}` and Light `{report['selection']['candidate_phase']}`. Required distinct repeats per task/agent: {report['selection']['required_distinct_repeats']}.",
           '',f"Complete three-way evidence: **{'PASS' if report['accepted'] else 'NOT PROVEN'}**. Owner Pi/Light target: **{'PASS' if report['owner_target_accepted'] else 'NOT MET OR INSUFFICIENT EVIDENCE'}**. All selected failed runs remain included. Token columns are per-run means; total tokens means input plus output, including cached input.",'']
    for model in report['models']:
        lines += [f"## {model['model']}",'','| Task | Agent | N | Pass | Input | Cached | Uncached | Output | Total | Cost/run | Time s | Model/tool calls |','| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for task in model['tasks']:
            for agent in AGENTS:
                data=task['agents'][agent]; mean=data['means']
                lines.append(f"| {task['task']} | {agent} | {data['runs']} | {data['passed']}/{data['outcome_runs']}{' + '+str(data['unknown_outcomes'])+' pending' if data['unknown_outcomes'] else ''} | {format_number(mean['input_tokens'])} | {format_number(mean['cached_tokens'])} | {format_number(mean['uncached_tokens'])} | {format_number(mean['output_tokens'])} | {format_number(mean['total_tokens'])} | {format_number(mean['cost_usd'],6)} | {format_number(mean['wall_seconds'],1)} | {format_number(mean['model_calls'],1)}/{format_number(mean['tool_calls'],1)} |")
        lines += ['','Totals below sum all selected runs, including failures. Cost/completed divides total spend by runs with normal process exit. Cost/pass divides total spend by benchmark passes.','','| Agent | N / pass | Input | Cached | Uncached | Output | Total | Cost total | Cost/completed | Cost/pass | Time total s | Model/tool calls |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for agent in AGENTS:
            data=model['totals'][agent]; sums=data['sums']
            lines.append(f"| {agent} | {data['runs']} / {data['passed']} | {format_number(sums['input_tokens'])} | {format_number(sums['cached_tokens'])} | {format_number(sums['uncached_tokens'])} | {format_number(sums['output_tokens'])} | {format_number(sums['total_tokens'])} | {format_number(sums['cost_usd'],6)} | {format_number(data['cost_per_completed_run_usd'],6)} | {format_number(data['cost_per_passed_task_usd'],6)} | {format_number(sums['wall_seconds'],1)} | {format_number(sums['model_calls'])}/{format_number(sums['tool_calls'])} |")
        lines += ['', '| Agent | Wall median seconds | Wall p90 seconds |', '| --- | ---: | ---: |']
        for agent in AGENTS:
            distribution = model['totals'][agent]['wall_seconds']
            lines.append(f"| {agent} | {format_number(distribution['median'],1)} | {format_number(distribution['p90'],1)} |")
        lines += ['','Per-task strict target: Light mean total tokens <= Pi; Light pass rate >= Pi.','','| Task | Light/Pi tokens | Quality >= Pi | Evidence | Flags |','| --- | ---: | --- | --- | --- |']
        for task in model['tasks']:
            check=task['acceptance']; issues=task['blockers']+task['warnings']
            lines.append(f"| {task['task']} | {format_number(check['light_to_pi_token_ratio'],3)} | {check['pass_rate_at_least_pi']} | {check['status']} | {'; '.join(issues) or 'none'} |")
        if report['selection']['original_light_baseline_available']:
            lines += ['','Baseline Light is diagnostic and is not substituted for missing candidate runs.','','| Task | Baseline Light N / pass | Mean total tokens | Mean cost | Mean seconds |','| --- | ---: | ---: | ---: | ---: |']
            for task in model['tasks']:
                data=task['baseline_light']
                lines.append(f"| {task['task']} | {data['runs']} / {data['passed']} | {format_number(data['means']['total_tokens'])} | {format_number(data['means']['cost_usd'],6)} | {format_number(data['means']['wall_seconds'],1)} |")
        else:
            lines += ['','This confirmatory cohort has no separate original-Light baseline. Pi and normal mode share the explicitly named candidate phase with candidate Light.']
        lines += ['','Request anatomy sums across selected calls. Characters are not token estimates. Prefix changes compare consecutive captured requests.','','| Agent | System chars | Schema chars | Tool-result chars | User chars | Assistant chars | Request chars | System/schema/history changes |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
        for agent in AGENTS:
            data=model['totals'][agent]['anatomy_sums']
            lines.append(f"| {agent} | {data['system_chars_sum']:,} | {data['schema_chars_sum']:,} | {data['tool_result_chars_sum']:,} | {data['user_chars_sum']:,} | {data['assistant_chars_sum']:,} | {data['request_chars_sum']:,} | {data['system_change_events']}/{data['schema_change_events']}/{data['history_rewrite_events']} |")
        changed = [r for r in report['run_diagnostics'] if r['selected'] and r['model']==model['model'] and r['anatomy']['system_prefix_versions']>1]
        lines += ['','Per-run prefix hashes are retained in JSON `run_diagnostics`. Changed system/developer text and Responses instructions are not normalized away.']
        if changed:
            lines += ['','| Run with changed system prefix | Calls | Distinct versions |','| --- | ---: | ---: |']
            lines += [f"| {r['id']} | {r['anatomy']['wire_calls']} | {r['anatomy']['system_prefix_versions']} |" for r in changed]
        else:
            lines += ['No system-prefix changes were observed in the captured selected calls. Missing captures are flagged separately.']
        lines += ['',f"Aggregate target met: {model['acceptance']['raw_metrics_meet_target']}. Equal-task-weight target met: {model['acceptance']['task_balanced_target_met']}. All required per-task evidence accepted: {model['acceptance']['accepted']}. Model-level blockers: {', '.join(model['blockers']) or 'none'}.",'']
    lines += ['## Evidence completeness','',f"Found {report['inventory']['result_files']} result files; selected {report['inventory']['selected_result_files']} completed result records across {report['inventory']['selected_attempts']} attempts. Unselected phases/counts: `{json.dumps(report['inventory']['unselected_counts_by_phase'],sort_keys=True)}`.",'']
    lines += [f"Result records by phase: `{json.dumps(report['inventory']['result_files_by_phase'],sort_keys=True)}`. Normal-exit records by phase: `{json.dumps(report['inventory']['normal_exit_results_by_phase'],sort_keys=True)}`.",'']
    for kind in ('malformed_result_files','unfinished_run_directories'):
        lines.append(f"{kind}: {json.dumps(report['inventory'][kind])}")
    lines += ['','## Limits','']+[f'- {note}' for note in report['limitations']]
    return '\n'.join(lines)+'\n'


def self_test():
    if sys.platform != 'linux': raise RuntimeError('Verification runs only on Linux')
    with tempfile.TemporaryDirectory(prefix='summary-check-', dir=Path(__file__).parent) as tmp:
        root=Path(tmp)
        def fixture(phase, agent, repeat, tokens, passed=True, complete=True):
            rid=f'{phase}-fixture-model-task-{agent}-r{repeat}'; directory=root/rid; directory.mkdir()
            body={'model':'fixture-model','messages':[{'role':'system','content':'fixed'},{'role':'user','content':'task'}],'tools':[],'max_tokens':100}
            (directory/'wire-001.json').write_text(json.dumps({'body':body}))
            run={'id':rid,'phase':phase,'agent':agent,'repeat':repeat,'model':'fixture-model','task':'task','pass':passed,'check_pass':passed,'exit_code':0,'timeout':False,'usage_complete':complete,'input_tokens':tokens,'cached_tokens':tokens//2,'uncached_tokens':tokens-tokens//2,'output_tokens':10,'cost_usd':tokens/1000,'budget_charge_usd':tokens/1000,'wall_seconds':1 if phase.startswith('candidate') and agent=='light' else 2,'model_calls':1,'tool_calls':1,'provider_errors':0,'prompt_sha256':'same','harness_sha256':'same','agent_revision':agent+'-revision','first_system_chars':7,'first_schema_chars':2}
            (directory/'result.json').write_text(json.dumps(run)); return directory
        for repeat in (1,2):
            fixture('baseline','pi',repeat,100,repeat==1)
            fixture('baseline','normal',repeat,150)
            fixture('baseline','light',repeat,130)
            fixture('candidate-final','light',repeat,80)
        fixture('pilot','pi',1,1)
        result=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        assert result['accepted'] and result['inventory']['selected_result_files']==6
        assert result['owner_target_accepted']
        normal_record=root/'baseline-fixture-model-task-normal-r1/result.json'
        normal_original=normal_record.read_text()
        normal_partial=json.loads(normal_original); normal_partial['usage_complete']=False
        normal_record.write_text(json.dumps(normal_partial))
        partial_normal=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        assert not partial_normal['accepted'] and partial_normal['owner_target_accepted']
        normal_record.write_text(normal_original)
        pi_record=root/'baseline-fixture-model-task-pi-r2/result.json'
        pi_original=pi_record.read_text(); pi_failed=json.loads(pi_original)
        pi_failed.update(timeout=True,exit_code=5)
        pi_record.write_text(json.dumps(pi_failed))
        pi_timeout=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        assert not pi_timeout['accepted'] and pi_timeout['owner_target_accepted']
        assert pi_timeout['models'][0]['totals']['pi']['failed']==1
        pi_record.write_text(pi_original)
        assert result['models'][0]['totals']['pi']['sums']['total_tokens']==220
        assert result['models'][0]['totals']['pi']['failed']==1
        assert result['models'][0]['totals']['light']['wall_seconds']['p90'] == 1
        assert wall_distribution([{'wall_seconds':n} for n in range(1,11)])['p90'] == 9
        assert wall_distribution([{}])['median'] is None
        assert result['models'][0]['totals']['pi']['cost_per_passed_task_usd']==.2
        assert result['models'][0]['baseline_light_totals']['runs']==2
        for bad_tasks,bad_models,bad_phase in [(['task','task'],['fixture-model'],'candidate-final'), (['task'],['fixture-model','fixture-model'],'candidate-final'), (['task'],['fixture-model'],'baseline')]:
            try: summarize(root,bad_tasks,bad_phase,'baseline',bad_models,2)
            except ValueError: pass
            else: raise AssertionError('Invalid selection accepted')
        orphan=root/'candidate-final-fixture-model-task-light-r3'; orphan.mkdir()
        orphan_result=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        orphan_group=orphan_result['models'][0]['totals']['light']
        assert not orphan_result['accepted'] and orphan_group['runs']==3 and orphan_group['unfinished_attempts']==1
        assert orphan_group['means']['total_tokens'] is None and orphan_group['observed_sums']['total_tokens']==180
        assert orphan_group['pass_rate'] is None and orphan_group['failed']==0 and orphan_group['unknown_outcomes']==1
        orphan.rmdir()
        record=root/'candidate-final-fixture-model-task-light-r1/result.json'; original=record.read_text()
        altered=json.loads(original); altered['cost_usd']=None; record.write_text(json.dumps(altered))
        assert not summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)['accepted']
        altered['cost_basis']='subscription-unpriced'; record.write_text(json.dumps(altered))
        unpriced=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        assert unpriced['accepted'] and unpriced['models'][0]['totals']['light']['sums']['cost_usd'] is None
        record.write_text(original)
        timed=json.loads(original); timed['timeout']=True; record.write_text(json.dumps(timed))
        timed_report=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        timed_group=timed_report['models'][0]['totals']['light']
        assert timed_group['passed']==1 and timed_group['reported_passed']==2 and timed_group['check_passed']==2
        assert 'reported_pass_contradiction' in timed_group['flags'] and not timed_report['accepted']
        assert not timed_report['owner_target_accepted']
        record.write_text(original)
        wire=record.parent/'wire-001.json'; changed=json.loads(wire.read_text())
        changed['body']['messages'][0]['content']='changed prior system text'
        changed['body']['reasoning_effort']='high'
        extra=record.parent/'wire-002.json'; extra.write_text(json.dumps(changed))
        prefix=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        diagnostic=next(r for r in prefix['run_diagnostics'] if r['id']==record.parent.name)
        assert diagnostic['anatomy']['system_prefix_versions']==2
        assert 'sampling_changed_within_run' in diagnostic['flags'] and not prefix['accepted']
        # A later child/fallback call must not hide behind the first call's model.
        changed['body']['model']='different-child-model'
        extra.write_text(json.dumps(changed))
        fallback=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        diagnostic=next(r for r in fallback['run_diagnostics'] if r['id']==record.parent.name)
        assert 'wire_model_mismatch' in diagnostic['flags'] and not fallback['accepted']
        assert diagnostic['anatomy']['wire_models']==['different-child-model','fixture-model']
        extra.unlink()
        incomplete=summarize(root,['task','missing'],'candidate-final','baseline',['fixture-model'],2)
        assert not incomplete['accepted'] and incomplete['models'][0]['tasks'][1]['agents']['pi']['means']['total_tokens'] is None
        path=root/'candidate-final-fixture-model-task-light-r2/result.json'
        value=json.loads(path.read_text()); value['usage_complete']=False; path.write_text(json.dumps(value))
        usage_partial=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        assert not usage_partial['accepted']
        assert usage_partial['models'][0]['totals']['light']['means']['total_tokens'] is None
        assert usage_partial['models'][0]['totals']['light']['observed_sums']['total_tokens']==180
        value['usage_complete']=True; value['input_tokens']=None; path.write_text(json.dumps(value))
        missing=summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)
        assert missing['models'][0]['totals']['light']['sums']['total_tokens'] is None
        assert missing['models'][0]['totals']['light']['observed_sums']['total_tokens']==90
        assert '| task | pi | 2 | 1/2 |' in markdown(result)
        value['input_tokens']=80; path.write_text(json.dumps(value))
        for repeat in (1,2):
            fixture('candidate-final','pi',repeat,100,repeat==1)
            fixture('candidate-final','normal',repeat,150)
        confirm=summarize(root,['task'],'candidate-final','candidate-final',['fixture-model'],2,confirmatory=True)
        assert confirm['accepted'] and not confirm['selection']['original_light_baseline_available']
        assert confirm['models'][0]['baseline_light_totals']['runs']==0
        assert 'no separate original-Light baseline' in markdown(confirm)
        value.pop('pass'); path.write_text(json.dumps(value))
        assert not summarize(root,['task'],'candidate-final','baseline',['fixture-model'],2)['accepted']
    print(json.dumps({'self_test':'pass','provider_calls':0,'failed_runs_retained':True}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs',type=Path)
    parser.add_argument('--manifest',type=Path,default=Path(__file__).parent/'tasks/manifest.json')
    parser.add_argument('--candidate-phase')
    parser.add_argument('--confirmatory-phase')
    parser.add_argument('--baseline-phase',default='baseline')
    parser.add_argument('--models',default='')
    parser.add_argument('--tasks',default='')
    parser.add_argument('--required-runs',type=int,default=2)
    parser.add_argument('--json-out',type=Path)
    parser.add_argument('--markdown-out',type=Path)
    parser.add_argument('--fail-unproven',action='store_true')
    parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    if sys.platform != 'linux': parser.error('Run benchmark analysis/verification on Linux; generated results can be read anywhere')
    if args.self_test: self_test(); return
    if not args.runs or not (args.candidate_phase or args.confirmatory_phase): parser.error('--runs and explicit --candidate-phase or --confirmatory-phase are required')
    if args.candidate_phase and args.confirmatory_phase: parser.error('Choose primary --candidate-phase or --confirmatory-phase, not both')
    if args.confirmatory_phase:
        if not args.confirmatory_phase.startswith('candidate'): parser.error('Confirmatory phase must name a candidate build cohort')
        args.candidate_phase = args.baseline_phase = args.confirmatory_phase
    if args.required_runs<2: parser.error('At least two distinct repeats are required')
    if not args.confirmatory_phase and args.candidate_phase == args.baseline_phase: parser.error('Candidate phase must differ from baseline phase')
    manifest=json.loads(args.manifest.read_text()); manifest=manifest['tasks'] if isinstance(manifest,dict) else manifest
    tasks=args.tasks.split(',') if args.tasks else [task['id'] for task in manifest]
    known={t['id'] for t in manifest}
    if len(known) != len(manifest): parser.error('Manifest has duplicate task IDs')
    if len(tasks) != len(set(tasks)): parser.error('Duplicate task selector')
    model_selectors = args.models.split(',') if args.models else []
    if len(model_selectors) != len(set(model_selectors)): parser.error('Duplicate model selector')
    for output in (args.json_out, args.markdown_out):
        if output and (output.resolve() == args.runs.resolve() or args.runs.resolve() in output.resolve().parents): parser.error('Outputs must be outside the raw runs tree')
    if args.json_out and args.markdown_out and args.json_out.resolve() == args.markdown_out.resolve(): parser.error('Output paths must differ')
    if set(tasks)-known: parser.error('Unknown task in --tasks')
    report=summarize(args.runs.resolve(),tasks,args.candidate_phase,args.baseline_phase,args.models.split(',') if args.models else [],args.required_runs,confirmatory=bool(args.confirmatory_phase))
    if args.json_out:
        args.json_out.parent.mkdir(parents=True,exist_ok=True); args.json_out.write_text(json.dumps(report,indent=2)+'\n')
    if args.markdown_out:
        args.markdown_out.parent.mkdir(parents=True,exist_ok=True); args.markdown_out.write_text(markdown(report))
    print(json.dumps({'accepted':report['accepted'],'models':[m['model'] for m in report['models']],
                      'selected_runs':report['inventory']['selected_result_files'],
                      'json_out':str(args.json_out) if args.json_out else None,'markdown_out':str(args.markdown_out) if args.markdown_out else None}))
    if args.fail_unproven and not report['accepted']: raise SystemExit(2)

if __name__=='__main__': main()
