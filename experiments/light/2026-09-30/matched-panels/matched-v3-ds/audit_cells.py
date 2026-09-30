#!/usr/bin/env python3
"""Post-run audit of every captured request in one matched phase (runs on the PC).
Usage: audit_cells.py RUNS_DIR PHASE
Checks, per call: model, reasoning effort, reasoning summary, output cap, store,
stream. For Light cells it also counts sandbox refusals and permission denials
in tool outputs, so a disabled shell can never pass silently as a result.
"""
import collections, glob, json, os, sys

runs, phase = sys.argv[1], sys.argv[2]
report = {}
for cell in sorted(glob.glob(os.path.join(runs, phase + '-*'))):
    name = os.path.basename(cell)
    settings = collections.Counter()
    refusals = collections.Counter()
    for wire in sorted(glob.glob(os.path.join(cell, 'wire-*.json'))):
        body = json.load(open(wire))['body']
        r = body.get('reasoning') or {}
        settings[json.dumps({'model': body.get('model'), 'effort': r.get('effort'), 'summary': r.get('summary'),
                             'max_output_tokens': body.get('max_output_tokens'), 'store': body.get('store'),
                             'stream': body.get('stream')}, sort_keys=True)] += 1
    wires = len(glob.glob(os.path.join(cell, 'wire-*.json')))
    usages = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(cell, 'usage-*.json')))]
    if len(usages) != wires:
        refusals['usage_records_missing'] += wires - len(usages)
    for u in usages:
        if u.get('usage_missing') or not u.get('input_tokens') or not u.get('usage'):
            refusals['empty_or_missing_usage'] += 1
        if u.get('error'):
            refusals['call_error'] += 1
    last = sorted(glob.glob(os.path.join(cell, 'wire-*.json')))
    if last:
        for item in json.load(open(last[-1]))['body'].get('input', []):
            out = str(item.get('output', '')) if item.get('type') == 'function_call_output' else ''
            if 'bubblewrap is unavailable' in out or 'Landlock fallback cannot' in out:
                refusals['sandbox_unavailable'] += 1
            if 'Permission denied: ' in out or 'no approver' in out:
                refusals['permission_denied'] += 1
            if 'sandbox escalation' in out:
                refusals['escalation'] += 1
    report[name] = {'settings': dict(settings), 'refusals': dict(refusals)}
distinct = collections.Counter(s for v in report.values() for s in v['settings'])
print(json.dumps({'cells': len(report), 'distinct_settings': dict(distinct),
                  'cells_with_refusals': {k: v['refusals'] for k, v in report.items() if v['refusals']}}, indent=1))
