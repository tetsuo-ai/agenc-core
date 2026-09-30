"""Hash all task-labelled Linux test logs without publishing log contents or host paths."""
import argparse, hashlib, json, re
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('results', type=Path)
p.add_argument('--out', type=Path, required=True)
a = p.parse_args()
ansi = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
rows = []
for path in sorted(a.results.glob('light-ultra-*.log')):
    data = path.read_bytes()
    text = ansi.sub('', data.decode(errors='replace'))
    lines = text.splitlines()
    revision = re.search(r'\bsha=([0-9a-f]{40})\b', lines[0] if lines else '')
    summaries = [line.strip() for line in lines if re.match(r'^\s*(Test Files|Tests |Duration )', line)]
    endings = [line for line in lines if line.startswith(('exit=', 'wrapper_end='))]
    rows.append({'label': path.stem, 'revision': revision.group(1) if revision else None,
                 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                 'summaries': summaries, 'wrapper_endings': endings,
                 'interpretation': 'Raw observations retained, including failed/interrupted runs; a summary is not an acceptance substitution.'})
a.out.write_text(json.dumps({'schema_version': 1, 'test_logs': rows}, indent=2) + '\n')
print(json.dumps({'hashed_test_logs': len(rows)}))
