import tempfile,json,pathlib,sys
import runner as r
with tempfile.TemporaryDirectory() as tmp:
 r.ROOT=pathlib.Path(tmp);r.PROVIDER='openai';r.LEDGER=r.ROOT/'spend-openai.jsonl';r.LUNA_CALL_CAP=2
 assert r.reserve_luna_call('one',1)
 assert r.reserve_luna_call('one',2)
 assert not r.reserve_luna_call('two',1)
 assert len(r.luna_call_ids())==2
 r.LEDGER.write_text(json.dumps({'run':'one','call':1,'budget_charge_usd':0})+'\n')
 assert len(r.luna_call_ids())==2
 r.PROVIDER='minimax';r.LEDGER=r.ROOT/'spend-minimax.jsonl'
 body=r.normalize_body({'model':'MiniMax-M3','stream':True,'reasoning_effort':'high','max_tokens':1})
 assert body['thinking']=={'type':'adaptive'} and body['max_tokens']==8192 and 'reasoning_effort' not in body
 reserve=r.reservation(body)
 (r.ROOT/'minimax-admissions.jsonl').write_text(json.dumps({'run':'a','call':1,'reserve':reserve})+'\n')
 assert r.spend()==reserve
 r.LEDGER.write_text(json.dumps({'run':'a','call':1,'budget_charge_usd':.01})+'\n')
 assert r.spend()==.01
 for provider in ('grok','openai'):
  r.PROVIDER=provider
  assert r.normalize_body({'model':r.MODEL_IDS[provider],'reasoning':{'effort':'low'}})['max_output_tokens']==8192
  try:r.normalize_body({'model':'wrong'})
  except ValueError:pass
  else:raise AssertionError('model accepted')
print(json.dumps({'offline_checks':'pass','provider_requests':0,'covers':['interrupted admissions','cap enforcement','deduplication','durable budget reserves','usage reconciliation','model effort output parity']}))
