"""Bundle only this cohort's measurement captures, excluding task checkouts."""
from pathlib import Path
import sys,tarfile
root=Path.home()/'claude-agenc-work/light-port/runs'
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as archive:
    for directory in sorted(root.glob('candidate-eq-*')):
        for pattern in ['result.json','wire-*.json','response-*.txt','usage-*.json','agent.log','balance-admission.json','check.log']:
            for path in sorted(directory.glob(pattern)):
                archive.add(path,arcname='runs/'+str(path.relative_to(root)))
        for path in sorted((directory/'home').rglob('rollout-*.jsonl')):
            archive.add(path,arcname='runs/'+str(path.relative_to(root)))
