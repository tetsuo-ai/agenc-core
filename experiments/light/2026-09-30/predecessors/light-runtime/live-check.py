#!/usr/bin/env python3
"""Credential handoff only through SSH stdin; never logs the input."""
import pathlib,shlex,subprocess,sys
base=pathlib.Path('/private/tmp/light-runtime')
secret=None
with pathlib.Path('/Users/tetsuoarena/.config/agenc-keys/test-providers.env').open() as f:
    for line in f:
        if line.startswith('export DEEPSEEK_API_KEY='):
            values=shlex.split(line.split('=',1)[1],comments=True)
            if len(values)==1:secret=values[0]
            break
if not secret:raise SystemExit('DeepSeek credential export not found')
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
remote='''docker run --rm --init -i --user "$(id -u):$(id -g)" --cpus=2 --memory=4g \
-v "$HOME/claude-agenc-work/light-runtime:/work" \
-v "$HOME/claude-agenc-work/light-runtime:$HOME/claude-agenc-work/light-runtime:ro" \
-v "$HOME/claude-agenc-work/agenc-core/.git/objects:$HOME/claude-agenc-work/agenc-core/.git/objects:ro" \
-v "$HOME/claude-agenc-work/light-ultra/pi:/pi:ro" -w /work node:26.5.0-bookworm \
python3 /work/frozen-harness/stdin_entry.py \
--root /work/flash-check --core-base /work/core-candidate --core-candidate /work/core-candidate --pi-prefix /pi \
--phase candidate-runtime --agents light --models deepseek-flash \
--tasks 03-window-padding,07-source-manifest,09-separator-payload,12-partition-map \
--repeats 1 --workers 1 --spend-cap-usd 2 --balance-floor-usd 10 \
> "$HOME/claude-agenc-work/light-runtime/flash-launch.log" 2>&1'''
result=subprocess.run(ssh+[remote],input=secret+'\n',text=True)
with (base/'credential-scan-exact-local.json').open('w') as log:
    local=subprocess.run([sys.executable,str(base/'exact-scan.py'),str(base)],input=secret+'\n',text=True,stdout=log)
remote_scan='python3 ~/claude-agenc-work/light-runtime/exact-scan.py ~/claude-agenc-work/light-runtime ~/claude-agenc-work/results > ~/claude-agenc-work/light-runtime/credential-scan-exact-remote.json'
scan=subprocess.run(ssh+[remote_scan],input=secret+'\n',text=True)
secret=''
print('Flash harness exit:',result.returncode,'local scan exit:',local.returncode,'remote scan exit:',scan.returncode)
sys.exit(result.returncode or local.returncode or scan.returncode)
