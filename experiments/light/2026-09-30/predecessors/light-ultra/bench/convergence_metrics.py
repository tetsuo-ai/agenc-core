import json,subprocess,statistics,math,re
from pathlib import Path
root=Path('/private/tmp/light-ultra')
remote=r'''
from pathlib import Path
import json,re
r=Path.home()/'claude-agenc-work';out=[]
for job in ['light-ultra','light-port']:
 for p in (r/job/'runs').glob('*/result.json'):
  x=json.loads(p.read_text());phase=x['phase']
  keep=bool(re.fullmatch(r'candidate-c[0-9]+',phase)) or phase.startswith('candidate-api-') if job=='light-ultra' else phase in ['candidate-eq','candidate-confirm','candidate-confirm2','candidate-conf','candidate-final']
  if job=='light-ultra' and phase=='baseline' and x['agent']=='pi':keep=True
  if job=='light-port' and x.get('agent_revision','').startswith('3c954ea55'):keep=True
  if keep:out.append(dict(x,job=job))
print(json.dumps(out))
'''
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218','python3 -']
rows=json.loads(subprocess.check_output(ssh,input=remote.encode()))
(root/'evidence/convergence-results.json').write_text(json.dumps(rows,indent=2))
hard={'03','07','09','12'}
def metric(xs):
 walls=sorted(x['wall_seconds'] for x in xs);complete=all(x.get('usage_complete',False) for x in xs)
 return {'n':len(xs),'pass':sum(x['pass'] for x in xs),'median':statistics.median(walls),'p90':walls[math.ceil(.9*len(xs))-1], 'tokens':statistics.mean(x['input_tokens']+x['output_tokens'] for x in xs) if complete else None,'calls':statistics.mean(x['model_calls'] for x in xs),'cost':sum(x.get('cost_usd') or 0 for x in xs)}
groups={}
for x in rows:
 if x['model'].startswith('deepseek') and x['task'][:2] not in hard:continue
 phase=x['phase'];label=x['job']+'/'+phase+'/'+x['agent'];groups.setdefault((x['model'],label),[]).append(x)
lines=['| Model | Cohort | Effective | Tokens/run | Median / p90 s | Calls | Cost |','| --- | --- | ---: | ---: | ---: | ---: | ---: |'];stats=[]
for (model,label),xs in sorted(groups.items()):
 m=metric(xs);stats.append(dict(model=model,cohort=label,**m));token=f'{m["tokens"]:,.0f}' if m['tokens'] is not None else 'unknown'
 lines.append(f'| {model} | {label} | {m["pass"]}/{m["n"]} | {token} | {m["median"]:.2f} / {m["p90"]:.2f} | {m["calls"]:.2f} | ${m["cost"]:.6f} |')
(root/'evidence/convergence-screen.md').write_text('\n'.join(lines)+'\n')
(root/'evidence/convergence-stats.json').write_text(json.dumps(stats,indent=2))
print('\n'.join(lines))
