import pathlib,subprocess,json,time,shlex,sys,datetime
R=pathlib.Path('/private/tmp/light-models')
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
probe='''import pathlib,json,fcntl
r=pathlib.Path('/home/paul/claude-agenc-work/light-models')
rows=[json.loads(p.read_text()) for p in (r/'runs').glob('*/result.json')]
counts={m:sum(x['model']==m and x['repeat']==1 for x in rows) for m in ['MiniMax-M3','grok-4.7','gpt-6-sol']}
p=r/'spend-minimax.jsonl';finished=[json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
a=r/'minimax-admissions.jsonl';admitted=[json.loads(l) for l in a.read_text().splitlines()] if a.exists() else []
ids={(x['run'],x['call']) for x in finished};pending=[x for x in admitted if (x['run'],x['call']) not in ids]
charged=sum(x['budget_charge_usd'] for x in finished)+sum(x['reserve'] for x in pending)
free=False
with (r/'locks/minimax.lock').open('a') as f:
 try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);free=True
 except BlockingIOError:pass
print(json.dumps({'counts':counts,'pending':len(pending),'charged':charged,'provider_lock_free':free}))'''
while True:
 if (R/'evidence/finish-policy.json').exists():raise SystemExit('Second repeats disabled by owner finish update')
 p=subprocess.run(ssh+['python3 -c '+shlex.quote(probe)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 if p.returncode==0:
  state=json.loads(p.stdout)
  if all(n==36 for n in state['counts'].values()) and not state['pending'] and state['provider_lock_free']:break
 time.sleep(30)
state['at']=datetime.datetime.now(datetime.timezone.utc).isoformat();state['admit_repeat2']=state['charged']*2+.25<6
(R/'evidence/minimax-repeat2-admission.json').write_text(json.dumps(state,indent=2)+'\n')
with (R/'STATUS.md').open('a') as f:f.write('\nMiniMax repeat2 budget gate '+state['at']+': '+json.dumps(state)+'.\n')
if not state['admit_repeat2']:raise SystemExit('Insufficient conservative budget for a complete second repeat')
with (R/'logs/minimax-r2.log').open('w') as log:
 code=subprocess.call([sys.executable,str(R/'harness/launch_batch.py'),'minimax','2'],stdout=log,stderr=subprocess.STDOUT)
print(json.dumps({'minimax_repeat2_exit':code}),flush=True)
raise SystemExit(code)
