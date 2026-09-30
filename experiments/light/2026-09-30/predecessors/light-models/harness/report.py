from pathlib import Path
import json,statistics,math,datetime,collections
R=Path('/private/tmp/light-models');d=json.loads((R/'evidence/metrics.json').read_text());rows=[x for x in d['runs'] if x['repeat']==1]
def mean(v):return statistics.mean(v) if v else float('nan')
def p90(v):return sorted(v)[max(0,math.ceil(.9*len(v))-1)] if v else float('nan')
def f(v):return f'{v:,.1f}' if v is not None else 'unknown'
def tokens(xs):
 n=mean([x['tokens'] for x in xs]);return ('≥' if any(not x['usage_complete'] for x in xs) else '')+f'{n:,.0f}'
def table(xs):
 return '| '+ ' | '.join([str(sum(x.get('effective_pass',x['pass']) for x in xs))+'/'+str(len(xs)),str(sum(x['check_pass'] for x in xs))+'/'+str(len(xs)),tokens(xs),f(statistics.median(x['wall_seconds'] for x in xs))+' / '+f(p90([x['wall_seconds'] for x in xs])),f(mean([x['model_calls'] for x in xs])),f(mean([x['model_seconds'] for x in xs]))+' / '+f(mean([x['tool_plus_runtime_seconds'] for x in xs]))])+' |'
text=['# Light versus Pi: three additional model families','',f'Updated {datetime.datetime.now(datetime.timezone.utc).isoformat()}. '+('Final report.' if (R/'evidence/finished.json').exists() else 'Live report; matrix not yet complete.'),'','Pinned agents: Pi 0.73.1; main Light 11e51dcc132dac8f413b59cc745135592f90dfed; port Light 3c954ea5591c683aa9b14a0219345e11051b06dd. The main job rejected brief df0f47246, so it is not an arm. No AgenC production source was changed.','', 'The frozen 12 tasks and graders are copied verbatim from the main job. Deadline 300 seconds, maximum 45 calls per task, output ceiling 8192. Each provider runs serially; different providers may overlap. Grok/Sol use low reasoning. MiniMax uses its adaptive default, standard service tier; Core internally calls that high, while the transport removes the ineffective reasoning_effort parameter for both agents. Captures retain original and forwarded bodies. Sol uses the existing ChatGPT proxy, which removes output ceilings upstream, just as in the Luna comparison.','', 'Completion is effective/artifact; time includes failures and deadlines. Tokens and calls are means per task/run. P90 uses nearest rank. Model time is the captured upstream interval clipped to agent wall time, including transport/network time. Tool+runtime is the remaining wall time, including local retries or waiting after a per-task call cap; it is not an independently measured provider compute split. Missing usage is a lower bound (≥), never zero.','', '| Model | Agent | Effective / N | Artifact / N | Tokens/task | Median / p90 s | Calls/task | Model / tool+runtime s |','|---|---|---:|---:|---:|---:|---:|---:|']
for model in ['grok-4.7','gpt-6-sol','MiniMax-M3']:
 for agent in ['pi','light-main','light-port']:
  xs=[x for x in rows if x['model']==model and x['agent']==agent]
  if xs:text.append('| '+model+' | '+agent+' '+table(xs))
text+=['','Continuation evidence: Grok stores response history server-side. The original frozen request-only trace check cannot always associate a later tool result with its earlier function call. An analysis-only copy inserts exact function-call records from earlier captured responses before their matching outputs, then runs the unchanged grader. Main tables use that verified effective score; raw failures remain below. Source requests, responses, times, tokens and result.json files are unchanged. Negative controls remove the success receipt, break call identity, or preload the planning tool; all correctly fail. See evidence/continuation-grader-audit.json and continuation-controls.json.','', '| Model | Agent | Raw effective / N | Verified effective / N |','|---|---|---:|---:|']
for model in ['grok-4.7','gpt-6-sol','MiniMax-M3']:
 for agent in ['pi','light-main','light-port']:
  group=[x for x in rows if x['model']==model and x['agent']==agent]
  if group:text.append('| '+model+' | '+agent+' | '+str(sum(x['pass'] for x in group))+'/'+str(len(group))+' | '+str(sum(x.get('effective_pass',x['pass']) for x in group))+'/'+str(len(group))+' |')
for model in ['grok-4.7','gpt-6-sol','MiniMax-M3']:
 xs=[x for x in rows if x['model']==model]
 text+=['',f'## {model}','']
 if not xs:text+=['No benchmark cells completed. See availability and gate notes in STATUS.md.'];continue
 text+=['| Task | Agent | Effective / N | Artifact / N | Tokens/task | Median / p90 s | Calls/task | Model / tool+runtime s |','|---|---|---:|---:|---:|---:|---:|---:|']
 for task in sorted(set(x['task'] for x in xs)):
  for agent in ['pi','light-main','light-port']:
   group=[x for x in xs if x['task']==task and x['agent']==agent]
   if group:text.append('| '+task+' | '+agent+' '+table(group))
 text+=['','Paired comparisons use only identical task/repeat IDs. Positive deltas mean Light used more than Pi.','', '| Light arm | Paired cells | Effective Δ | Tokens Δ/task | Wall Δ/task s | Calls Δ/task | Model Δ s | Tool+runtime Δ s |','|---|---:|---:|---:|---:|---:|---:|---:|']
 pi={(x['task'],x['repeat']):x for x in xs if x['agent']=='pi'}
 for agent in ['light-main','light-port']:
  pairs=[(x,pi[(x['task'],x['repeat'])]) for x in xs if x['agent']==agent and (x['task'],x['repeat']) in pi]
  if not pairs:continue
  vals=[f(mean([a[k]-b[k] for a,b in pairs])) for k in ['tokens','wall_seconds','model_calls','model_seconds','tool_plus_runtime_seconds']]
  if any(not a['usage_complete'] or not b['usage_complete'] for a,b in pairs):vals[0]='unknown'
  text.append('| '+agent+' | '+str(len(pairs))+' | '+str(sum(a.get('effective_pass',a['pass'])-b.get('effective_pass',b['pass']) for a,b in pairs))+' | '+' | '.join(vals)+' |')
text+=['','## Failures','', '| Record | Category | Cause | Artifact |','|---|---|---|---:|']
for x in rows:
 if not x['pass']:text.append('| '+x['id']+' | '+x['failure_category']+' | '+str(x['failure_cause']).replace('|','/')+' | '+str(x['check_pass'])+' |')
if all(x['pass'] for x in rows):text.append('| None among completed cells | — | — | — |')
text+=['','## Provider accounting','', '| Provider | Admitted calls | Completed usage records | Missing usage | Recorded USD | Charged/reserved USD | Cap |','|---|---:|---:|---:|---:|---:|---|']
for p,v in d['ledgers'].items():text.append('| '+p+' | '+str(v['admitted'])+' | '+str(v['completed_records'])+' | '+str(v['missing_usage'])+' | '+('subscription unpriced' if v['recorded_usd'] is None else f"{v['recorded_usd']:.6f}")+' | '+('—' if v['charged_usd'] is None else f"{v['charged_usd']:.6f}")+' | '+({'minimax':'$6','grok':'800 requests','openai':'600 requests'}[p])+' |')
text+=['','MiniMax dollar amounts are computed from recorded usage and published standard rates. MiniMax prices were verified against [official pay-as-you-go pricing](https://platform.minimax.io/docs/guides/pricing-paygo): standard≤512K input $0.30/M uncached,$0.06/M cached,$1.20/M output; longer input doubles these rates. Unresolved requests retain long-context worst-case reservations. Thinking follows the [official OpenAI-compatible API contract](https://platform.minimax.io/docs/api-reference/text-openai-api). Grok low effort is documented in [xAI reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning).','', '## Overlap and evidence','']
for job in ['light-ultra','light-port']:
 n=sum(job in x.get('other_job_provider_overlap',[]) for x in rows);m=sum(any(s.startswith(job+':suite_or_build') for s in x.get('other_job_overlap',[])) for x in rows)
 text.append(f'{job}: {n}/{len(rows)} completed cells overlap measured other-job provider intervals; {m}/{len(rows)} overlap sampled build/suite processes. No timing adjustment is applied.')
text+=['','Raw artifacts stay under `/home/paul/claude-agenc-work/light-models/runs/` on the PC; aggregate proof is [metrics.json](evidence/metrics.json). Frozen source snapshots, availability records, runner versions, request admissions, and overlap samples are retained. Credentials never enter agent environments, captures or reports. Credential scan and process shutdown evidence appear in the round-closure section.']
(R/'REPORT.md').write_text('\n'.join(text)+'\n')
status=f"\nMetrics snapshot {datetime.datetime.now(datetime.timezone.utc).isoformat()}: {len(rows)} completed cells, {sum(x.get('effective_pass',x['pass']) for x in rows)} effective passes. "+'; '.join(p+': '+str(v['admitted'])+' calls'+(f", charged ${v['charged_usd']:.6f}" if v['charged_usd'] is not None else '') for p,v in d['ledgers'].items())+'. Other-job provider overlap: '+', '.join(job+' '+str(sum(job in x.get('other_job_provider_overlap',[]) for x in rows))+' cells' for job in ['light-ultra','light-port'])+'. Sampled other-job suite/build overlap: '+', '.join(job+' '+str(sum(any(s.startswith(job+':suite_or_build') for s in x.get('other_job_overlap',[])) for x in rows))+' cells' for job in ['light-ultra','light-port'])+'. See REPORT.md and evidence/metrics.json.\n'
with (R/'STATUS.md').open('a') as out:out.write(status)
print(status.strip())
