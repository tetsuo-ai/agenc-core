import subprocess,time,json,shlex,pathlib
r=pathlib.Path('/private/tmp/light-models')
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
probe='''import pathlib,json,collections
r=pathlib.Path('/home/paul/claude-agenc-work/light-models');rows=[json.loads(p.read_text()) for p in (r/'runs').glob('*/result.json')];a=[json.loads(s) for s in (r/'minimax-admissions.jsonl').read_text().splitlines()];v=[json.loads(s) for s in (r/'spend-minimax.jsonl').read_text().splitlines()];done={(x['run'],x['call']) for x in v};print(json.dumps({'counts':dict(collections.Counter(x['model'] for x in rows)),'repeats':sorted(set(x['repeat'] for x in rows)),'pending':sum((x['run'],x['call']) not in done for x in a),'minimax_calls':len(a),'last_run':a[-1]['run']}))'''
previous=None
while True:
 p=subprocess.run(ssh+['python3 -c '+shlex.quote(probe)],capture_output=True,text=True)
 if p.returncode:print('read-only progress probe failed',flush=True)
 else:
  s=json.loads(p.stdout);print(json.dumps(s),flush=True)
  n=sum(s['counts'].values())
  if n!=previous:subprocess.run(['bash',str(r/'harness/sync_metrics.sh')],stdout=subprocess.DEVNULL,check=True);previous=n
  if n==108 and not s['pending']:break
 time.sleep(55)
print('FIRST_REPEAT_DRAINED',flush=True)
