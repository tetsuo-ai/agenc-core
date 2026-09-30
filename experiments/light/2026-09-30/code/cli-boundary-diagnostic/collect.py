#!/usr/bin/env python3
"""Collect only scalar diagnostic results/timing spans; never home/log contents."""
import json
from pathlib import Path
import subprocess
import sys

PROGRAM = r'''
import hashlib, json
from pathlib import Path
root = Path('/home/paul/claude-agenc-work/light-ultra/analysis/cli-boundary-diagnostic-v3/results')
out = {'provenance': json.loads((root/'provenance.json').read_bytes()), 'cells': []}
for arm in ('light', 'pi'):
    for repeat in range(1, 4):
        directory = root/f'{arm}-r{repeat}'
        source = directory/'result.json'
        value = json.loads(source.read_bytes())
        spans = []
        hashes = {source.name: hashlib.sha256(source.read_bytes()).hexdigest()}
        for path in sorted(directory.glob('runtime-timing.*.jsonl')):
            hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            for line in path.read_text().splitlines():
                row = json.loads(line)
                spans.append({k: row[k] for k in ('name', 'id', 'pid', 'start_ms', 'duration_ms')})
        out['cells'].append({'result': value, 'spans': spans, 'artifact_sha256': hashes})
print(json.dumps(out))
'''

run = subprocess.run(['ssh', '-i', '/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519',
    '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', 'paul@192.168.1.218', 'python3', '-'],
    input=PROGRAM, text=True, capture_output=True, timeout=30)
if run.returncode:
    raise SystemExit('Diagnostic collection failed; remote text withheld')
report = json.loads(run.stdout)
with Path(sys.argv[1]).open('x') as output:
    json.dump(report, output, indent=2, sort_keys=True)
    output.write('\n')
print(json.dumps({'cells': len(report['cells']),
    'valid': all(c['result']['valid_single_response'] for c in report['cells']),
    'spans': sum(len(c['spans']) for c in report['cells'])}))
