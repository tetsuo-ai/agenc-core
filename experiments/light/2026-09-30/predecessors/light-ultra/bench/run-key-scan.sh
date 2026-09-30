#!/bin/bash
set -euo pipefail
# Run after benchmarks and artifact writes finish. Secrets enter only the
# scanner process environment. The OAuth bearer never goes to Linux or SSH.
source /Users/tetsuoarena/.config/agenc-keys/test-providers.env
python3 - <<'PY'
import json,os,pathlib,subprocess,sys,shlex
root=pathlib.Path('/private/tmp/light-ultra')
env=dict(os.environ)
env['LUNA_PROXY_BEARER']=pathlib.Path('/Users/tetsuoarena/claude-agenc/chatgpt-oauth/secret').read_text().strip()
scanner=[sys.executable,str(root/'bench/scan_credentials.py')]
subprocess.run(scanner+['--root',str(root),'--report',str(root/'evidence/key-scan-mac.json')],env=env,check=True)
# Never pass credential-bearing environment entries to the transport process.
transport_env={k:v for k,v in os.environ.items() if not any(x in k for x in ('KEY','TOKEN','SECRET','BEARER'))}
# Scan newly created Git objects too, including blobs from earlier branch commits.
# Worktree files alone would miss a credential deleted before the current head.
needles=[env['DEEPSEEK_API_KEY'].encode(),env['LUNA_PROXY_BEARER'].encode()]
git_report={'objects':0,'bytes':0,'credential_hits':0,'hits':[]}
seen_objects=set()
for tree,base in [('core-actions','a5639cb4e'),('core-relative','6c4c68431'),('core','1370385d69'),('core-context','48afd25e8'),('core-focus','9e7edc397'),('core-parity','0d5ad1bed'),('core-speed','41951e4b4'),('core-output','1a7642102'),('core-demand','d12664057'),('core-notice','d12664057'),('core-catalog','1a7642102'),('core-frames','c2a6a35d4'),('core-directed','55cfedd81'),('core-brief','11e51dcc1'),('desktop','c14a9f6c'),('benchmark','1370385d69')]:
    command=['git','-C',str(root/tree)]
    branch=subprocess.check_output(command+['branch','--show-current'],env=transport_env).decode().strip()
    tips=subprocess.check_output(command+['reflog','show','--format=%H',branch],env=transport_env).decode().splitlines()
    objects=subprocess.check_output(command+['rev-list','--objects',*sorted(set(tips)), '^'+base],env=transport_env).decode().splitlines()
    for line in objects:
        oid=line.split(' ',1)[0]
        if oid in seen_objects:continue
        seen_objects.add(oid)
        data=subprocess.check_output(command+['cat-file','-p',oid],env=transport_env)
        git_report['objects']+=1;git_report['bytes']+=len(data)
        count=sum(data.count(needle) for needle in needles)
        if count:
            git_report['credential_hits']+=count
            git_report['hits'].append({'tree':tree,'object':oid,'count':count})
(root/'evidence/key-scan-git.json').write_text(json.dumps(git_report,indent=2)+'\n')
print(json.dumps({k:v for k,v in git_report.items() if k!='hits'}))
if git_report['credential_hits']:raise SystemExit('Credential scan found a Git object requiring redaction')
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
# Include every task-labelled result and its SHA-specific test worktree.
# The shared runner puts these outside light-ultra; never scan unrelated homes.
remote_script = r"""
import json,pathlib,re,subprocess,sys
base=pathlib.Path.home()/'claude-agenc-work'
paths={'light-ultra'}
for log in sorted((base/'results').glob('light-ultra-*.log')):
    paths.add(str(log.relative_to(base)))
    fail=log.with_suffix('.fails')
    if fail.exists():paths.add(str(fail.relative_to(base)))
    first=log.open(errors='replace').readline()
    match=re.search(r'\bsha=([0-9a-f]{40})\b',first)
    if match:
        folder='wt-desktop' if ' files=' in first else 'wt'
        tree=base/folder/match.group(1)[:12]
        if tree.is_dir():paths.add(str(tree.relative_to(base)))
paths=sorted(paths)
(base/'light-ultra/key-scan-inventory.json').write_text(json.dumps({'paths':paths},indent=2)+'\n')
# --hard-dereference scans the bytes of each regular hard link explicitly.
sys.exit(subprocess.call(['tar','--hard-dereference','-I','gzip -1','-cf','-','-C',str(base),*paths]))
"""
remote=subprocess.Popen(ssh+['python3 -c '+shlex.quote(remote_script)],stdout=subprocess.PIPE,env=transport_env)
try:
    result=subprocess.run(scanner+['--tar-stream','--report',str(root/'evidence/key-scan-linux-task.json')],stdin=remote.stdout,env=env)
finally:
    remote.stdout.close()
code=remote.wait()
if code or result.returncode:raise SystemExit(code or result.returncode)
PY
