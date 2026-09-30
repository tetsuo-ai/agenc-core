import os,sys,subprocess,json,fcntl
from pathlib import Path
root=Path('/work')
key=sys.stdin.readline().rstrip('\r\n')
if not key: raise SystemExit('Missing key')
lock=root/'locks/openai.lock';lock.parent.mkdir(exist_ok=True)
with lock.open('a') as handle:
 fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
 # Stop files are retained; a health request alone may bypass one in its own
 # ledger directory. The launcher must explicitly inspect it before resuming.
 if (root/'luna-api-stop.json').exists(): raise SystemExit('Stop remains pending')
 rid='health-api-'+str(__import__('time').time_ns());d=root/'runs'/rid;d.mkdir(parents=True,exist_ok=False)
 env=dict(os.environ,OPENAI_API_KEY=key,NODE_OPTIONS='--import=/work/luna-api/direct.mjs',LUNA_LEDGER_ROOT='/work',LUNA_RUN_DIR=str(d),LUNA_RUN_ID=rid)
 key=''
 result=subprocess.run(['node','/work/luna-api/health.mjs'],env=env)
 raise SystemExit(result.returncode)
