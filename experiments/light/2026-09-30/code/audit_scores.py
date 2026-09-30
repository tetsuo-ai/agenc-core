"""Read-only audit of retained scores; never changes graders or source records."""
import argparse
import collections
import hashlib
import json
from pathlib import Path


def audit(row):
    result = {key: row.get(key) for key in
              ('id', 'phase', 'model', 'agent', 'task', 'repeat', 'agent_revision')}
    result['recorded_pass'] = row.get('recorded_pass', row.get('pass'))
    result['legacy_frozen_pass'] = row.get('frozen_pass')
    result['proposed_symmetric_pass'] = row.get('symmetric_pass')
    # check_pass can include tool-discovery requirements. Do not label it as a
    # code-only score when a separate coding_pass was not captured.
    code = row.get('coding_pass')
    result['coding_pass'] = code
    result['coding_completion'] = (
        bool(code and row.get('exit_code') == 0
             and not row.get('timeout') and not row.get('budget_stop'))
        if code is not None else None
    )
    task12 = str(row.get('task', '')).startswith('12-')
    result['tool_requirement_comparable'] = None if task12 else True
    result['comparison_caveat'] = (
        'Historical task 12 did not give both agents the same planning-tool '
        'contract. Neither the original score nor the proposed rescore proves '
        'symmetric completion. Keep both; obtain code-only evidence separately.'
        if task12 else None
    )
    return result


def report(rows, digest):
    audited = [audit(row) for row in rows]
    groups = collections.defaultdict(list)
    for row in audited:
        if str(row['task']).startswith('12-'):
            groups[row['agent']].append(row)
    return {
        'input_sha256': digest,
        'policy': 'Analysis sidecar only. No task12 comparative win is accepted.',
        'task12': {agent: {
            'cells': len(items),
            'recorded_passes': sum(item['recorded_pass'] is True for item in items),
            'proposed_symmetric_passes': sum(item['proposed_symmetric_pass'] is True for item in items),
            'missing_separate_coding_score': sum(item['coding_pass'] is None for item in items),
        } for agent, items in groups.items()},
        'cells': audited,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    result = report(json.loads(raw), hashlib.sha256(raw).hexdigest())
    # Output only aggregate numbers, never captured model arguments or secrets.
    print(json.dumps({k: v for k, v in result.items() if k != 'cells'}, indent=2))
