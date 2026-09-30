import pathlib,json,collections,os
from tokenizers import Tokenizer
import tiktoken
root=pathlib.Path.home()/'claude-agenc-work/light-ultra';os.environ['TIKTOKEN_CACHE_DIR']=str(root/'tokenizer/tiktoken-cache')
ds=Tokenizer.from_file(str(root/'tokenizer/deepseek_v4_tokenizer/tokenizer.json'));oa=tiktoken.get_encoding('o200k_base')
rows=[]
for p in (root/'runs').glob('*/result.json'):
 r=json.loads(p.read_text())
 if r['agent']!='light' or r['phase'] not in {'candidate-round2-new','candidate-round2-repeat2','candidate-round2-confirm-screen','candidate-luna-full-r1','candidate-luna-full-r2','candidate-luna-full-light-r1'}:continue
 count=lambda s:len(oa.encode(s,disallowed_special=())) if r['model']=='gpt-6-luna' else len(ds.encode(s,add_special_tokens=False).ids)
 prefix='/work/runs/'+r['id']+'/repo';saved=0;out=0;seen=set();calls=0
 for w in sorted(p.parent.glob('wire-*.json')):
  calls+=1;b=json.loads(w.read_text())['body'];toolcalls=[]
  for m in b.get('messages',[]):
   for c in m.get('tool_calls',[]):toolcalls.append((c['id'],c['function']['arguments']))
  for m in b.get('input',[]):
   if m.get('type')=='function_call':toolcalls.append((m.get('call_id'),m.get('arguments','')))
  for cid,args in toolcalls:
   delta=count(args)-count(args.replace(prefix,'.'));saved+=delta
   if cid not in seen:seen.add(cid);out+=delta
 hint='Use workspace-relative paths for file operations and shell working directories.'
 rows.append({'id':r['id'],'model':r['model'],'N':calls,'history_argument_tokens_saved_same_calls':saved,'visible_argument_tokens_saved_same_calls':out,'prefix_added_estimate':calls*count(hint),'scope':'Only exact valid repo-prefix repetitions; duplicate invalid paths are not normalized. No messages or outputs changed.'})
(root/'analysis/relative-path-counterfactual.json').write_text(json.dumps(rows,indent=2)+'\n')
for m in sorted({r['model'] for r in rows}):
 xs=[r for r in rows if r['model']==m]
 print(json.dumps({'model':m,'n':len(xs),**{k:round(sum(r[k] for r in xs)/len(xs),1) for k in ('N','history_argument_tokens_saved_same_calls','visible_argument_tokens_saved_same_calls','prefix_added_estimate')}}))
