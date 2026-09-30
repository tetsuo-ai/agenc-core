"""Per-model-call behavioral accounting from retained wire and usage, no prompt copying."""
import argparse,collections,json,pathlib,re

def norm(s):
 s=re.sub(r'^tool2__','',s)
 return re.sub('[^a-z0-9]','',re.sub(r'_x([0-9a-fA-F]{2})',lambda m:chr(int(m[1],16)),s).lower())

def history(d):
 calls={};results={}
 for p in sorted(d.glob('wire-*.json')):
  b=json.loads(p.read_text())['body']
  for m in b.get('messages',b.get('input',[])):
   ts=m.get('tool_calls',[])
   if m.get('type')=='function_call':ts=[{'id':m['call_id'],'function':m}]
   for t in ts:
    f=t['function'];args=f.get('arguments',{})
    try:args=json.loads(args) if isinstance(args,str) else args
    except ValueError:args={'raw':args}
    calls[t['id']]={'name':norm(f['name']),'args':args}
   if m.get('role')=='tool' or m.get('type')=='function_call_output':results[m.get('tool_call_id',m.get('call_id'))]=m.get('content',m.get('output',''))
 return calls,results

def response_tools(p):
 out={};response=None
 for line in p.read_text().splitlines():
  if not line.startswith('data: '):continue
  try:e=json.loads(line[6:])
  except ValueError:continue
  if e.get('type')=='response.completed':response=e.get('response')
  if e.get('type')=='response.output_item.done' and e.get('item',{}).get('type')=='function_call':
   t=e['item'];out[t['call_id']]={'name':norm(t['name']),'arguments':t.get('arguments','')}
  for c in e.get('choices',[]):
   for t in c.get('delta',{}).get('tool_calls',[]):
    k=t.get('index',0);v=out.setdefault(k,{'name':'','arguments':'','id':''});f=t.get('function',{})
    v['id']+=t.get('id','');v['name']+=f.get('name','');v['arguments']+=f.get('arguments','')
 if response:
  for t in response.get('output',[]):
   if t.get('type')=='function_call':out[t['call_id']]={'name':norm(t['name']),'arguments':t.get('arguments','')}
 result=[]
 for k,v in out.items():
  try:args=json.loads(v['arguments'])
  except ValueError:args={'raw':v['arguments']}
  result.append({'id':v.get('id',k),'name':norm(v['name']),'args':args})
 return result

def is_error(x):
 s=json.dumps(x).lower()
 return bool(re.search(r'"(?:iserror|is_error)"\s*:\s*true|"status"\s*:\s*"error"|\[exec exit_code=[1-9]|process exited with code [1-9]|<tool_use_error>|traceback \(most recent call last\):|(?:bash|sh):[^\n]*command not found|"error"\s*:\s*"',s))


def classify(t,seen,epoch):
 n=t['name'];s=json.dumps(t['args']);cmd=t['args'].get('command',t['args'].get('cmd',''))
 # References to command names in grep/cat are inspection, not execution.
 cmd_exec=re.sub(r'(?m)(?:^|[;\n]|&&)\s*(?:grep|rg|cat|sed|head|tail|find)\b[^;\n]*', '',cmd)
 if any(x in n for x in ['todowrite','plan','searchtools']):return 'planning'
 if any(x in n for x in ['stdin','wait','poll','sleep']):return 'poll or wait'
 if any(x in n for x in ['edit','write','patch']) and 'stdin' not in n:return 'edit'
 if re.search(r'\b(?:unittest|pytest|vitest|jest|py_compile|compileall|npm test|typecheck)\b|\bassert\b',cmd_exec):
  key=re.sub(r'\s+',' ',cmd).strip();cat='rerun of unchanged tests' if (key,epoch) in seen else 'test run';seen.add((key,epoch));return cat
 if re.search(r'write_text|write_bytes|sed -i|\bpatch\b|open\([^\n]+["\x27][wa]["\x27]',cmd):return 'edit'
 return 'inspection'

def analyze(d):
 r=json.loads((d/'result.json').read_text());_,results=history(d);rows=[];seen=set();epoch=0;prior_error=False
 for p in sorted(d.glob('wire-*.json')):
  i=int(p.stem.split('-')[1]);u=d/f'usage-{i:03}.json';rp=d/f'response-{i:03}.txt';usage=json.loads(u.read_text()) if u.exists() else {};ts=response_tools(rp) if rp.exists() else []
  cs=[classify(t,seen,epoch) for t in ts]
  # Each call has one primary category so provider totals reconcile exactly.
  # Recovery supersedes its attempted operation; mixed calls retain tool categories.
  cat='recovery after a tool error' if prior_error else next((c for c in ['edit','rerun of unchanged tests','test run','poll or wait','planning','inspection'] if c in cs),('final answer' if i==len(list(d.glob('wire-*.json'))) else 'planning') if rp.exists() else 'unknown')
  if 'edit' in cs:epoch+=1
  prior_error=any(is_error(results.get(t['id'],'')) for t in ts)
  rows.append({'call':i,'category':cat,'tools':[{'name':t['name'],'category':c,'arguments':t['args'],'result_error':is_error(results.get(t['id'],''))} for t,c in zip(ts,cs)],**{k:usage.get(k) for k in ['input_tokens','cached_tokens','uncached_tokens','output_tokens','seconds','usage_missing']}})
 return {'id':r['id'],'phase':r['phase'],'agent':r['agent'],'model':r['model'],'task':r['task'],'repeat':r['repeat'],'calls':rows}

def main():
 ap=argparse.ArgumentParser();ap.add_argument('root',type=pathlib.Path);ap.add_argument('--out',type=pathlib.Path,required=True);ap.add_argument('--phases',default='candidate-c14,candidate-api-q,candidate-api-c,baseline,candidate-api-b,candidate-api-p');a=ap.parse_args();out=[]
 for p in sorted((a.root/'runs').glob('*/result.json')):
  r=json.loads(p.read_text())
  if r['phase'] not in a.phases.split(',') or r['model'] not in ['deepseek-flash','gpt-6-luna'] or r['repeat']!=1:continue
  if r['phase']=='baseline' and r['agent']!='pi':continue
  out.append(analyze(p.parent))
 a.out.write_text(json.dumps(out,indent=2)+'\n');print('Audited',len(out),'runs;',sum(len(x['calls']) for x in out),'model calls')
if __name__=='__main__':main()
