import subprocess,json,shlex,sys
from minimax_secret import key
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
args=['python3','/home/paul/claude-agenc-work/light-models/harness/preflight_minimax.py']
bootstrap='import os,sys,json;os.environ["MINIMAX_API_KEY"]=json.loads(sys.stdin.readline())["key"];os.execvp('+repr(args[0])+','+repr(args)+')'
p=subprocess.run(ssh+['python3 -c '+shlex.quote(bootstrap)],input=json.dumps({'key':key()})+'\n',text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
print(p.stdout,end='');sys.exit(p.returncode)
