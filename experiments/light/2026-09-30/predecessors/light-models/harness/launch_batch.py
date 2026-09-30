import sys,subprocess,json,shlex,pathlib,datetime
from minimax_secret import key
R=pathlib.Path('/private/tmp/light-models');provider=sys.argv[1];repeat=int(sys.argv[2]);tasks=sys.argv[3] if len(sys.argv)>3 else ''
policy=R/'evidence/finish-policy.json'
if policy.exists() and (repeat != 1 or (R/'evidence/finished.json').exists()):
 raise SystemExit('This round is closed to new cells; coordinator must authorize a new revision and run namespace.')
models={'grok':'grok-4.7','minimax':'MiniMax-M3','openai':'gpt-6-sol'}
args=['--root','/work','--core-base','/work/core-main','--core-candidate','/work/core-port','--pi-prefix','/work/pi','--provider',provider,'--models',models[provider],'--phase','candidate-r'+str(repeat),'--agents','pi,light-main,light-port','--workers','1','--repeats','1','--repeat-start',str(repeat),'--spend-cap-usd','6']
if tasks:args+=['--tasks',tasks]
if provider in ('grok','openai'):args+=['--openai-upstream','http://127.0.0.1:'+('8816' if provider=='grok' else '8817')+'/v1/responses']
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
command='docker run --rm --init -i --network host --user "$(id -u):$(id -g)" --cpus=2 --memory=4g -v "$HOME/claude-agenc-work/light-models:/work" -w /work node:26.5.0-bookworm python3 /work/harness/remote_entry.py'
payload={'args':args}
if provider=='minimax':payload['key']=key()
p=subprocess.Popen(ssh+[command],stdin=subprocess.PIPE)
p.stdin.write((json.dumps(payload)+'\n').encode());p.stdin.flush();p.stdin.close();payload.clear()
code=p.wait()
subprocess.run(['bash',str(R/'harness/sync_metrics.sh')],check=False)
with (R/'STATUS.md').open('a') as f:f.write('\nBatch '+provider+' repeat '+str(repeat)+' tasks '+(tasks or 'all')+' ended '+datetime.datetime.now(datetime.timezone.utc).isoformat()+' exit '+str(code)+'. Raw records retained on PC; analysis follows.\n')
sys.exit(code)
