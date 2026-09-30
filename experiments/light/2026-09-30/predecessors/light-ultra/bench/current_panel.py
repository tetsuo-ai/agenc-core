import json,pathlib,statistics,random,math,sys
root=pathlib.Path(__file__).resolve().parent.parent
phase=sys.argv[1];luna=sys.argv[2]
base=json.loads((root/'evidence/convergence-results.json').read_text())
new=json.loads((root/'evidence/current-results.json').read_text())
rs=base+new
pi={(r['model'],r['task']):r for r in rs if r['agent']=='pi' and r['repeat']==1 and r['phase'] in ['baseline','candidate-api-b','candidate-api-p']}
cs=[r for r in new if (r['phase']==phase or r['phase'] in luna.split(',')) and r.get('stop_reason') != 'unexpected_model_settings']
lines=[f'# {phase} / {luna} panel','','Cold daemon per task; warm performance is not measured by these cells. Bootstrap resamples paired tasks 10,000 times; four tasks only provide a rejection screen.','','| Model/task | Pi / candidate done | Pi / candidate tokens | Pi / candidate uncached | Pi / candidate seconds | Pi / candidate calls |','| --- | --- | --- | --- | --- | --- |']
for c in sorted(cs,key=lambda r:(r['model'],r['task'])):
 b=pi[c['model'],c['task']];total=lambda r:r['input_tokens']+r['output_tokens']
 lines.append(f"| {c['model']}/{c['task'][:2]} | {int(b['pass'])}/{int(c['pass'])} | {total(b):,}/{total(c):,} | {b['uncached_tokens']:,}/{c['uncached_tokens']:,} | {b['wall_seconds']:.2f}/{c['wall_seconds']:.2f} | {b['model_calls']}/{c['model_calls']} |")
for model in sorted(set(c['model'] for c in cs)):
 cohort=[c for c in cs if c['model']==model];bs=[pi[c['model'],c['task']] for c in cohort]
 lines+=['',f'## {model}: {sum(c["pass"] for c in cohort)}/{len(cohort)} completed','']
 for label,fn in [('tokens',lambda r:r['input_tokens']+r['output_tokens']),('uncached',lambda r:r['uncached_tokens']),('seconds',lambda r:r['wall_seconds'])]:
  ds=[fn(c)-fn(b) for c,b in zip(cohort,bs)];rng=random.Random(20260929)
  boot=sorted(statistics.mean(rng.choices(ds,k=len(ds))) for _ in range(10000))
  lines.append(f'Mean paired delta {label}: {statistics.mean(ds):.2f}, 95% bootstrap [{boot[250]:.2f}, {boot[9749]:.2f}].')
 for label,rr in [('Pi',bs),('Candidate',cohort)]:
  times=sorted(r['wall_seconds'] for r in rr);inp=sum(r['input_tokens'] for r in rr)
  lines.append(f'{label}: median/p90 {statistics.median(times):.2f}/{times[math.ceil(.9*len(times))-1]:.2f}s; mean calls {statistics.mean(r["model_calls"] for r in rr):.2f}; input cache share {sum(r["cached_tokens"] for r in rr)/inp:.2%}; cohort cost ${sum(r.get("cost_usd") or 0 for r in rr):.8f}.')
ports={(r['model'],r['task']):r for r in base if r['phase']=='candidate-eq' and r['repeat']==1}
lines+=['','## Retained port comparison','','| Model | Port / candidate done | Port / candidate mean tokens | Port / candidate median/p90 seconds |','| --- | --- | --- | --- |']
for model in ['deepseek-flash','deepseek-v4-pro']:
 cohort=[c for c in cs if c['model']==model]
 if not cohort:continue
 ps=[ports[c['model'],c['task']] for c in cohort]
 timing=lambda rr:f"{statistics.median(r['wall_seconds'] for r in rr):.2f}/{sorted(r['wall_seconds'] for r in rr)[math.ceil(.9*len(rr))-1]:.2f}"
 tokens=lambda rr:statistics.mean(r['input_tokens']+r['output_tokens'] for r in rr)
 lines.append(f"| {model} | {sum(r['pass'] for r in ps)}/{sum(r['pass'] for r in cohort)} | {tokens(ps):,.0f}/{tokens(cohort):,.0f} | {timing(ps)}/{timing(cohort)} |")
(root/f'evidence/{phase}-panel.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines))
