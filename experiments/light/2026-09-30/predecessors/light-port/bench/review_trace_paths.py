"""Extract path-like fragments only from new flagged calls in our own traces."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--prior', type=Path, required=True)
parser.add_argument('--audit', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--harness', type=Path)
args = parser.parse_args()
sys.path.insert(0, str(args.harness or args.root/'harness-fast'))
from trace_audit import calls, response_calls, texts

known = {r['run'] for r in json.loads(args.prior.read_text())['runs']}
rows = []
for run in json.loads(args.audit.read_text())['runs']:
    if run['run'] in known:
        continue
    for finding in run['findings']:
        path = args.root/'runs'/run['run']/finding['wire']
        captured = list(calls(json.loads(path.read_text())['body'])) if path.name.startswith('wire-') else response_calls(path)[0]
        matched = False
        for call_id, tool, arguments in captured:
            try:
                canonical = json.loads(arguments) if isinstance(arguments, str) else arguments
            except ValueError:
                canonical = arguments
            digest = hashlib.sha256(json.dumps([call_id,tool,canonical], sort_keys=True).encode()).hexdigest()
            if digest != finding['call_sha256']:
                continue
            matched = True
            fragments = []
            for value in texts(canonical):
                for match in re.finditer(r'''(?<![A-Za-z0-9])/(?:[^\s"'`<>|;&]+)''', value):
                    raw = match.group().rstrip('),]}')
                    if raw.startswith('/work/runs/'+run['run']+'/repo') or raw.startswith(('/usr/bin/', '/bin/')) or raw in ('/dev/null','/dev/stdout','/dev/stderr'):
                        continue
                    fragments.append(value[max(0,match.start()-24):min(len(value),match.end()+24)])
            rows.append(dict(run=run['run'], call_sha256=digest, tool=tool, fragments=fragments))
        assert matched, finding['call_sha256']
args.out.write_text(json.dumps(rows, indent=2)+'\n')
print(json.dumps(rows, indent=2))
