"""Scan task-owned text and artifacts without displaying credential contents."""
import argparse
import json
import os
from pathlib import Path
import re
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--root', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--key-stdin', action='store_true')
args = parser.parse_args()
key = (sys.stdin.readline().strip() if args.key_stdin else os.environ.get('DEEPSEEK_API_KEY', '')).encode()
if len(key) < 20:
    raise SystemExit('Expected authorized credential in process environment or stdin')
patterns = {
    'exact_authorized_credential': re.compile(re.escape(key)),
    'provider_key_shape': re.compile(rb'\bsk-[a-fA-F0-9]{32,}\b'),
    'private_key_header': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
}
omitted = {'.git', 'node_modules', '__pycache__'}
files = size = 0
findings = []
errors = []
for directory, directories, names in os.walk(args.root, followlinks=False):
    directories[:] = [name for name in directories if name not in omitted and not (Path(directory)/name).is_symlink()]
    for name in names:
        path = Path(directory)/name
        if path.is_symlink() or not path.is_file() or path.resolve() == args.out.resolve():
            continue
        try:
            counts = {label: 0 for label in patterns}
            tail = b''
            with path.open('rb') as stream:
                while chunk := stream.read(1024*1024):
                    block = tail + chunk
                    for label, pattern in patterns.items():
                        counts[label] += sum(match.end() > len(tail) for match in pattern.finditer(block))
                    tail = block[-max(256, len(key)):]
                    size += len(chunk)
            files += 1
            if any(counts.values()):
                findings.append({'path': str(path.relative_to(args.root)), 'counts': counts})
        except OSError as error:
            errors.append({'path': str(path.relative_to(args.root)), 'type': type(error).__name__})
report = dict(root=str(args.root), files=files, bytes=size, findings=findings, errors=errors,
              exclusions=sorted(omitted), follows_symlinks=False,
              note='Contents and credential values are never emitted. Third-party dependency trees and Git object databases are excluded.')
args.out.write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps({k: report[k] for k in ['files', 'bytes']} | {'flagged_files': len(findings), 'errors': len(errors)}))
raise SystemExit(1 if findings or errors else 0)
