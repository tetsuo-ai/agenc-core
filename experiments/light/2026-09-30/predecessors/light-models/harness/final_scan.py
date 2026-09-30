import os,subprocess,sys,json,shlex,pathlib
from minimax_secret import key
r=pathlib.Path('/private/tmp/light-models');secret=key()
# Mac-only proxy bearer stays in a Mac process environment; never SSH.
env=os.environ.copy();env['MINIMAX_SCAN_KEY']=secret;env['SOL_SCAN_BEARER']=pathlib.Path('/Users/tetsuoarena/claude-agenc/chatgpt-oauth/secret').read_text().strip()
subprocess.run([sys.executable,str(r/'harness/scan_files.py'),str(r)],env=env,check=True)
env.clear()
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
bootstrap='import os,sys,json;os.environ["MINIMAX_SCAN_KEY"]=json.loads(sys.stdin.readline())["key"];os.execvp("python3",["python3","/home/paul/claude-agenc-work/light-models/harness/scan_files.py","/home/paul/claude-agenc-work/light-models"])'
p=subprocess.run(ssh+['python3 -c '+shlex.quote(bootstrap)],input=json.dumps({'key':secret})+'\n',text=True,stderr=subprocess.DEVNULL,stdout=subprocess.PIPE)
print(p.stdout,end='');sys.exit(p.returncode)
