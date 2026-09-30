import json,pathlib,re
root=pathlib.Path('/home/paul/claude-agenc-work/light-runtime');results=root.parent/'results'
labels=['light-runtime-r2-focus','light-runtime-r2-full']+[line.split('\t')[0] for line in (root/'r2-rerun-map.tsv').read_text().splitlines()]
reports=[]
for label in labels:
 p=results/(label+'.log')
 raw=(root/'r2-full-live.log').read_text(errors='replace') if label.endswith('-full') else p.read_text(errors='replace')
 s=re.sub(r'\x1b\[[0-9;]*m','',raw)
 entry={'label':label,'summary':[line.strip() for line in s.splitlines() if re.match(r'^\s*(?:Test Files|Tests|Duration)\s',line)],'failures':[line.strip() for line in s.splitlines() if line.startswith(' FAIL ')]}
 entry['exit']=(root/'r2-full-container-exit.txt').read_text().strip() if label.endswith('-full') else next((line for line in s.splitlines() if line.startswith('exit=')),None)
 reports.append(entry)
(root/'r2-test-evidence.json').write_text(json.dumps({'source':'36751015fdf7c4e2b45506f131d5025be7bcfbcc','baseline':'46b2a5dbff45d9010bee965ddc5bad150d2f8bed','triage':json.loads((root/'r2-triage.json').read_text()),'runs':reports},indent=2)+'\n')
for entry in reports:print(entry['label'],entry['summary'][:2],entry['exit'])
