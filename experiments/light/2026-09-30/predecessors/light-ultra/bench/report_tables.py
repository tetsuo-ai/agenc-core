"""Render compact tables from the authoritative Linux analysis JSON. No regrading."""
import argparse,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('input',type=Path);p.add_argument('output',type=Path);a=p.parse_args();r=json.loads(a.input.read_text())
def n(v,d=0):return 'unknown' if v is None else f'{v:,.{d}f}'
def cost(g):return n(g['sums']['cost_usd'],6) if g['sums']['cost_usd'] is not None else '>='+n(g['observed_sums']['cost_usd'],6)
def row(label,g):
 return f"| {label} | {g['passed']}/{g['runs']} | {n(g['means']['total_tokens'])} | {n(g['wall_seconds']['median'],1)} / {n(g['wall_seconds']['p90'],1)} | {n(g['means']['model_calls'],2)} / {n(g['means']['tool_calls'],2)} | {cost(g)} |"
lines=['All attempts are included, including failures/timeouts. Tokens and model/tool calls are per-run means; cost is the total for the row. Tool calls count model-issued calls, not a guarantee of successful execution. Unknown values retain missing legacy usage; >= costs are observed lower bounds. Each task/agent has two repeats. Effective completion requires clean agent completion and every grader/tool requirement.','']
for m in r['models']:
 lines += [f"### {m['model']}",'','| Task / agent | Effective | Tokens/run | Median / p90 seconds | Model / tool calls | Cost USD |','| --- | ---: | ---: | ---: | ---: | ---: |']
 for task in m['tasks']:
  for agent in ('pi','normal','light'):lines.append(row(task['task']+' / '+agent,task['agents'][agent]))
 lines += ['', '| Aggregate | Effective | Tokens/run | Median / p90 seconds | Model / tool calls | Cost USD |','| --- | ---: | ---: | ---: | ---: | ---: |']
 for agent in ('pi','normal','light'):lines.append(row(agent,m['totals'][agent]))
 lines += ['', '| Token totals | Cached input | Uncached input | Output | Total |','| --- | ---: | ---: | ---: | ---: |']
 for agent in ('pi','normal','light'):
  g=m['totals'][agent];s=g['sums'];lines.append('| '+agent+' | '+' | '.join(n(s[k]) for k in ('cached_tokens','uncached_tokens','output_tokens','total_tokens'))+' |')
 lines += ['']
a.output.write_text('\n'.join(lines)+'\n')
