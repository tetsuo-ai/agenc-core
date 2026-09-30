import pathlib,json,subprocess,time
r=pathlib.Path('/home/paul/claude-agenc-work/light-ultra');out={}
rows=[]
for p in (r/'runs').glob('*luna*/result.json'):
 x=json.loads(p.read_text())
 if x.get('phase','').startswith('candidate-luna-full') or (x.get('phase')=='candidate-luna' and x.get('agent')=='pi'):rows.append(x)
ids={(x['task'],x['agent'],x['repeat']) for x in rows}
tasks=json.loads((r/'packaged-luna/tasks/manifest.json').read_text())['tasks']
expected={(t['id'],a,i) for t in tasks for a in ['pi','light'] for i in [1,2]}
used=set();finished=set()
for name,target in [('spend-luna.jsonl',finished),('luna-admissions.jsonl',used)]:
 p=r/name
 if p.exists():
  for l in p.read_text().splitlines():
   x=json.loads(l);target.add((x['run'],x['call']))
used|=finished
active=[]
for line in subprocess.check_output(['ps','-eo','pid,args'],text=True).splitlines():
 if 'runner.py' in line and ('packaged-luna/' in line or ('--provider openai' in line and 'light-ultra' in line)):active.append(int(line.split()[0]))
out={'time':time.time(),'completed_primary_cells':len(ids&expected),'expected':48,'missing':[list(x) for x in sorted(expected-ids)],'admitted':len(used),'pending_admissions':len(used-finished),'active_runner_pids':active,'ready':(expected<=ids or len(used)>=600 or (pathlib.Path('/home/paul/claude-agenc-work/light-models/evidence/luna-terminal-status.json').exists() and len(used)==269)) and not active and used<=finished}
pathlib.Path('/home/paul/claude-agenc-work/light-models/evidence/luna-gate.json').write_text(json.dumps(out,indent=2))
print(json.dumps({k:v for k,v in out.items() if k!='missing'}))
