"""Identify coincident retained provider intervals without changing either study."""
import json, re
from datetime import datetime, timezone
from pathlib import Path
root=Path.home()/'claude-agenc-work'
def interval(directory):
    records=[json.loads(p.read_text()) for p in directory.glob('usage-*.json')]
    if not records:return None
    return min(r['time'] for r in records), max(r['time']+r['seconds'] for r in records)
others=[]
for d in (root/'light-ultra/runs').iterdir():
    if d.is_dir() and (value:=interval(d)):
        others.append((d.name,value))
suites=[]
for p in (root/'results').glob('light-*full*.log'):
    s=p.read_text(errors='replace')
    start=re.search(r'start=(\S+)',s[:500]);end=re.findall(r'end=(\S+)',s[-500:])
    if start:
        try:
            lo=datetime.fromisoformat(start[1].replace('Z','+00:00')).timestamp()
            hi=datetime.fromisoformat(end[-1].replace('Z','+00:00')).timestamp() if end else datetime.now(timezone.utc).timestamp()
            suites.append((p.name,(lo,hi)))
        except ValueError:pass
rows=[]
for d in sorted((root/'light-port/runs').iterdir()):
    if not d.is_dir() or not (own:=interval(d)):continue
    overlap=lambda v: max(own[0],v[0]) < min(own[1],v[1])
    rows.append(dict(run=d.name,provider_interval=own,other_job_runs=[n for n,v in others if overlap(v)],
                     core_suites=[n for n,v in suites if overlap(v)]))
out=root/'light-port/overlap.json'
out.write_text(json.dumps(dict(method='Overlap of first-to-last completed provider request intervals; startup and pending requests may extend these. Suites use runner timestamps. No timing correction is applied.',runs=rows),indent=2)+'\n')
print(json.dumps(dict(runs=len(rows),with_other_job=sum(bool(r['other_job_runs']) for r in rows),with_suites=sum(bool(r['core_suites']) for r in rows))))
