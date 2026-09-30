import time,subprocess,json,pathlib
r=pathlib.Path('/home/paul/claude-agenc-work/light-models')
while not (r/'monitor.stop').exists():
 rows=[]
 for line in subprocess.check_output(['ps','-eo','pid,etimes,args'],text=True).splitlines()[1:]:
  parts=line.strip().split(None,2)
  if len(parts)!=3:continue
  pid,elapsed,args=parts
  if 'light-models' in args:continue
  for job in ('light-ultra','light-port'):
   if job in args:
    kind='bridge' if 'luna_bridge.py' in args else 'benchmark' if 'runner.py' in args or 'run_matrix' in args else 'suite_or_build' if any(s in args for s in ('test','build','bun','docker run')) else 'other'
    rows.append({'pid':int(pid),'elapsed':int(elapsed),'job':job,'kind':kind})
 with (r/'evidence/overlap-snapshots.jsonl').open('a') as f:f.write(json.dumps({'time':time.time(),'processes':rows})+'\n')
 time.sleep(10)
