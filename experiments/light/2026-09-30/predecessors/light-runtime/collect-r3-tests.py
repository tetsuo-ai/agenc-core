import json,pathlib,re
root=pathlib.Path('/home/paul/claude-agenc-work/light-runtime');results=root.parent/'results'
labels=['light-runtime-r3-focus','light-runtime-r3-full']+[line.split('\t')[0] for line in (root/'r3-rerun-map.tsv').read_text().splitlines()]
reports=[]
for label in labels:
 raw=(results/(label+'.log')).read_text(errors='replace');s=re.sub(r'\x1b\[[0-9;]*m','',raw)
 entry={'label':label,'summary':[line.strip() for line in s.splitlines() if re.match(r'^\s*(?:Test Files|Tests|Duration)\s',line)],'failures':[line.strip() for line in s.splitlines() if line.startswith(' FAIL ')], 'exit':next((line for line in s.splitlines() if line.startswith('exit=')),None)}
 reports.append(entry)
(root/'r3-test-evidence.json').write_text(json.dumps({'source':'e6d260717cf9e9e3f1c3defe5a0fc8c7d7102f78','source_tree':'18bd634c6f8109b60892cf72c1eda530a50c378e','baseline':'46b2a5dbff45d9010bee965ddc5bad150d2f8bed','triage':json.loads((root/'r3-triage.json').read_text()),'runs':reports},indent=2)+'\n')
for e in reports:print(e['label'],e['summary'][:2],e['exit'])
