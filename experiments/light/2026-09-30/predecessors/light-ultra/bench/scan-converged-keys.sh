#!/bin/bash
set -euo pipefail
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
source /Users/tetsuoarena/.config/agenc-keys/openai-luna.env
python3 /private/tmp/light-ultra/bench/scan_credentials.py --root /private/tmp/light-ultra --report /private/tmp/light-ultra/evidence/key-scan-converged-mac.json
python3 - <<'PY'
import json,os,pathlib,subprocess
root=pathlib.Path('/private/tmp/light-ultra')
needles=[os.environ[k].encode() for k in ['DEEPSEEK_API_KEY','OPENAI_API_KEY']]
git=['git','-C',str(root/'core-converged')]
objects=subprocess.check_output(git+['rev-list','--objects','HEAD','^3c954ea55']).decode().splitlines()
hits=0;size=0
for line in objects:
    data=subprocess.check_output(git+['cat-file','-p',line.split(' ',1)[0]])
    size+=len(data);hits+=sum(data.count(n) for n in needles)
report={'objects':len(objects),'bytes':size,'credential_hits':hits}
(root/'evidence/key-scan-converged-git.json').write_text(json.dumps(report)+'\n')
print(json.dumps(report))
if hits:raise SystemExit('Credential hit: stop publication and redact')
PY
printf '%s\n%s\n' "$DEEPSEEK_API_KEY" "$OPENAI_API_KEY" | ssh -i /Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519 -o IdentitiesOnly=yes paul@192.168.1.218 'python3 -c '\''import os,sys,runpy
os.environ["DEEPSEEK_API_KEY"]=sys.stdin.readline().rstrip("\r\n")
os.environ["OPENAI_API_KEY"]=sys.stdin.readline().rstrip("\r\n")
root=os.path.expanduser("~/claude-agenc-work/light-ultra")
sys.argv=[root+"/analysis/scan_credentials.py","--root",root,"--report",root+"/analysis/key-scan-converged-linux.json"]
runpy.run_path(sys.argv[0],run_name="__main__")'\'''
