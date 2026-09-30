#!/usr/bin/env python3
"""Read-only structural adapter audit, never historical planning rescoring.

The raw captures stay on the benchmark host. Only counts, digests and static
unknown reasons leave it. No credentials, request bodies or normalized text
are emitted. A successful parse does not establish transport provenance.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
REMOTE_AUDIT = r'''
from collections import Counter
from pathlib import Path
import datetime
root = Path('/home/paul/claude-agenc-work/light-ultra/runs')
groups = [
    ('luna_fixed_control', 'candidate-api-fixedconfig-gpt-6-luna-*-light-r1', 'responses'),
    ('flash_c16', 'candidate-c16-deepseek-flash-*-light-r1', 'chat'),
]
out = {'scope': 'structural_compatibility_only_no_scores',
       'adapter_sha256': DIGEST, 'collected_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
       'transport_completeness_attested': False, 'groups': []}
for name, pattern, transport in groups:
    runs = sorted(root.glob(pattern))
    tally = Counter(); reasons = Counter(); captures = []
    for run in runs:
        result_path = run/'result.json'
        if not result_path.is_file():
            tally['unfinalized_runs_skipped'] += 1
            continue
        result = json.loads(result_path.read_bytes())
        files = sorted(run.glob('response-*.txt'))
        tally['finalized_runs'] += 1
        tally['expected_model_calls'] += result.get('model_calls', 0)
        tally['response_files'] += len(files)
        tally['response_count_mismatches'] += len(files) != result.get('model_calls')
        for path in files:
            raw = path.read_bytes()
            # True below deliberately asks whether the format is parseable.
            # It is NOT a transport receipt and is never used to grade a plan.
            adapter = adapt_openai_responses if transport == 'responses' else adapt_chat_completions
            parsed = adapter(raw, adapter_sha256=DIGEST, capture_complete=True, source='provider_response_sse')
            tally['structurally_complete' if parsed['complete'] else 'unknown'] += 1
            reasons.update(parsed.get('unknown_reasons', []))
            captures.append({'response_sha256': hashlib.sha256(raw).hexdigest(),
                             'structurally_complete': parsed['complete'],
                             'unknown_reasons': parsed.get('unknown_reasons', [])})
    out['groups'].append({'group': name, 'transport': transport, 'counts': dict(tally),
                          'unknown_reasons': dict(reasons), 'captures': captures})
print(json.dumps(out, sort_keys=True, indent=2))
'''


def main():
    source = (HERE/'stream_adapters.py').read_bytes()
    digest = hashlib.sha256(source).hexdigest()
    program = source.decode() + '\nDIGEST = ' + repr(digest) + '\n' + REMOTE_AUDIT
    completed = subprocess.run([
        'ssh', '-i', '/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519',
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', 'paul@192.168.1.218',
        'python3', '-'], input=program, text=True, capture_output=True, timeout=90)
    if completed.returncode:
        # Remote tracebacks can include payload-bearing locals in future edits;
        # fail closed rather than forwarding arbitrary diagnostic text.
        raise SystemExit('Remote structural audit failed; raw output withheld')
    report = json.loads(completed.stdout)
    if report.get('adapter_sha256') != digest:
        raise SystemExit('Adapter identity mismatch')
    if len(sys.argv) != 2:
        raise SystemExit('Expected a NEW report output path')
    with Path(sys.argv[1]).open('x') as output:
        json.dump(report, output, indent=2, sort_keys=True)
        output.write('\n')
    print(json.dumps({'adapter_sha256': digest, 'groups': [
        {k: v for k, v in group.items() if k != 'captures'} for group in report['groups']]}))


if __name__ == '__main__':
    main()
