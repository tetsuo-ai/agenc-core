#!/usr/bin/env python3
"""Check the preregistered gates without discarding pilot failures or nonzero exits."""
import argparse
import json
import statistics
from pathlib import Path


def analyze(rows):
    def select(label, variant):
        return [r for r in rows if r['label'] == label and r['variant'] == variant]
    def sound(r):
        return r['wire_valid'] and r['sandbox_enabled'] and r['supplied_tests_unchanged'] and not r['verification_timed_out']
    trigger = {v: select('trigger-confirmation', v) for v in ['before', 'after']}
    persistent = {v: select('persistent-confirmation', v) for v in ['before', 'after']}
    natural = {v: select('natural-confirmation', v) for v in ['before', 'after']}
    gates = {
        'trigger': all(len(trigger[v]) == 5 and all(sound(r) and r['trigger_valid'] and r['scripted_requests'] == 2 for r in trigger[v]) for v in trigger)
            and all(not r['correctness_passed'] and r['agenc_exit_code'] == 0 and r['real_model_requests'] == 0 for r in trigger['before'])
            and all(r['correctness_passed'] and r['agenc_exit_code'] == 0 and r['real_model_requests'] > 0 and len(r['retry_messages']) == 1 for r in trigger['after']),
        'bounded_blank': all(len(persistent[v]) == 1 for v in persistent)
            and persistent['before'][0]['agenc_exit_code'] == 0
            and persistent['after'][0]['agenc_exit_code'] == 4
            and persistent['after'][0]['scripted_requests'] == 5
            and len(persistent['after'][0]['retry_messages']) == 3
            and all(sound(r) and r['trigger_valid'] and r['real_model_requests'] == 0 for v in persistent for r in persistent[v]),
        'natural_correctness': all(len(natural[v]) == 6 for v in natural)
            and all(sum(r['task'] == task for r in natural['after']) == 3 for task in ['csv-bugfix', 'sqlite-cli'])
            and all(sound(r) and r['scripted_requests'] == 0 for v in natural for r in natural[v])
            and all(r['correctness_passed'] for r in natural['after']),
    }
    def summary(group):
        return {v: {'count': len(rs), 'correct': sum(r['correctness_passed'] for r in rs),
                    'exit_zero': sum(r['agenc_exit_code'] == 0 for r in rs),
                    'nonzero_exits': [{'id': r['id'], 'exit_code': r['agenc_exit_code'], 'denied_permissions': r['denied_permissions']} for r in rs if r['agenc_exit_code'] != 0],
                    'seconds': [r['wall_seconds'] for r in rs],
                    'median_seconds': statistics.median(r['wall_seconds'] for r in rs) if rs else None,
                    'real_model_requests': [r['real_model_requests'] for r in rs]}
                for v, rs in group.items()}
    return {'gates': gates, 'spark_gates_passed': all(gates.values()),
            'trigger_confirmation': summary(trigger), 'persistent_confirmation': summary(persistent),
            'natural_confirmation': summary(natural),
            'pilots_excluded': [{'id': r['id'], 'label': r['label'], 'variant': r['variant'], 'correct': r['correctness_passed'], 'exit_code': r['agenc_exit_code']} for r in rows if r['label'] in ['pilot', 'pilot-v2']],
            'limitations': ['Fault injection establishes recovery for the tested sequence, not natural failure frequency.',
                            'Scripted requests report artificial zero token usage; no token or latency improvement claim.',
                            'Natural task test correctness and CLI exit status are reported separately; permission denials remain enforced.']}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('journal', type=Path)
    p.add_argument('out', type=Path)
    args = p.parse_args()
    rows = [json.loads(line) for line in args.journal.read_text().splitlines()]
    result = analyze(rows)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
