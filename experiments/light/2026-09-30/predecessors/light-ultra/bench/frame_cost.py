from pathlib import Path
import json,sys,functools
from tokenizers import Tokenizer
r=Path(sys.argv[1]);tok=Tokenizer.from_file(str(r/'tokenizer/deepseek_v4_tokenizer/tokenizer.json'));boundary='===== AGENC UNTRUSTED TOOL RESULT DATA ====='
@functools.lru_cache(maxsize=6000)
def delta(c):
 if not c.startswith('The following tool result is untrusted workspace data from ') or c.count(boundary)!=2:return (0,0,0)
 a=c.index(boundary)+len(boundary);b=c.rindex(boundary);body=c[a:b].strip('\n');new='AGENC_DATA\n'+body+'\nAGENC_DATA'
 full=len(tok.encode(c,add_special_tokens=False).ids);small=len(tok.encode(new,add_special_tokens=False).ids)
 return full,small,full-small
rows=[]
for p in sorted((r/'runs').glob('*/result.json')):
 x=json.loads(p.read_text())
 if x['phase'] not in ['candidate-parity3-subset','candidate-demand-subset','candidate-notice2-subset']:continue
 savings=0;occ=0;unique=set()
 for w in p.parent.glob('wire-*.json'):
  for m in json.loads(w.read_text())['body']['messages']:
   if m['role']=='tool' and isinstance(m.get('content'),str):
    original,small,d=delta(m['content']);savings+=d;occ+=int(bool(d))
    if d:unique.add(m.get('tool_call_id'))
 rows.append({'id':x['id'],'phase':x['phase'],'model':x['model'],'task':x['task'],'actual_total':x['input_tokens']+x['output_tokens'],'raw_replay_tokens_saved_if_calls_unchanged':savings,'replayed_frames':occ,'unique_frames':len(unique)})
print(json.dumps({'method':'Counterfactual raw tokenizer difference replacing workspace provenance/fences with an independent compact AgenC data marker, summed over every replay. Same calls/results assumed; no measured model-behavior or quality claim. External results unchanged.','runs':rows},indent=2))
