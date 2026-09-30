import collections,json,pathlib
root=pathlib.Path(__file__).resolve().parent.parent
rs=json.loads((root/'evidence/call-categories.json').read_text());results=json.loads((root/'evidence/symmetric-results.json').read_text())
pi={}
# Prefer the original valid API baselines; p contains the missing tasks and later ablation cells.
for phase in ['candidate-api-p','baseline','candidate-api-b']:
 for r in rs:
  if r['phase']==phase and r['agent']=='pi':pi[r['model'],r['task']]=r
cats=['inspection','edit','test run','rerun of unchanged tests','poll or wait','recovery after a tool error','planning','final answer']
lines=['# Per-call Luna and Flash comparison','', 'Every model call is assigned one primary category; mixed tool calls also retain each operation category in call-categories.json. Counts and token totals are additive. Recovery means the preceding call returned an observed tool failure; it includes expected failing tests, so these are not all avoidable calls. Test reruns require identical command text and no intervening edit; semantic variants need manual review. Tokens are measured provider uncached input plus output, not estimated text tokens. No-tool intermediate messages count as planning; only the last counts as final answer. Historical usage missing from the provider stays unknown.','']
for phase in ['candidate-api-c','candidate-api-q','candidate-c14']:
 cs=[r for r in rs if r['phase']==phase and r['agent']=='light'];bs=[pi[r['model'],r['task']] for r in cs]
 lines += [f'## {phase}: {len(cs)} paired tasks','', '| Category | Pi calls | Light calls | Pi uncached + output | Light uncached + output | Pi raw tokens | Light raw tokens |','|---|---:|---:|---:|---:|---:|---:|']
 def totals(rr,cat):
  cc=[c for r in rr for c in r['calls'] if c['category']==cat]
  return [len(cc),sum((c['uncached_tokens'] or 0)+(c['output_tokens'] or 0) for c in cc),sum((c['input_tokens'] or 0)+(c['output_tokens'] or 0) for c in cc)]
 for cat in cats:
  a,b=totals(bs,cat),totals(cs,cat);lines.append(f'| {cat} | {a[0]} | {b[0]} | {a[1]:,} | {b[1]:,} | {a[2]:,} | {b[2]:,} |')
 for c,b in zip(cs,bs):
  lines+=['',f'### {c["model"]}/{c["task"]}: Light {len(c["calls"])} / Pi {len(b["calls"])} calls','', '| Agent/call | Category | Tools / operation | Uncached + output |','|---|---|---|---:|']
  for agent,r in [('Light',c),('Pi',b)]:
   for row in r['calls']:
    ops=[]
    for t in row['tools']:
     args=t['arguments'];detail=args.get('file_path',args.get('cmd',args.get('command',args.get('select',''))))
     detail=str(detail).replace('\n',' ')[:140].replace('|','/');ops.append(t['name']+': '+detail)
    lines.append(f'| {agent}/{row["call"]} | {row["category"]} | {"; ".join(ops)} | {(row["uncached_tokens"] or 0)+(row["output_tokens"] or 0):,} |')
(root/'CALL-CATEGORY-AUDIT.md').write_text('\n'.join(lines)+'\n')
print('\n'.join(lines[:18]))
