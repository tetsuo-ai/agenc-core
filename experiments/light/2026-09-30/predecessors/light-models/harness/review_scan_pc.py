import pathlib,json,subprocess,hashlib,collections
r=pathlib.Path('/home/paul/claude-agenc-work/light-models');rows=json.loads((r/'evidence/scan-shape-hashes-linux.json').read_text());out=[]
for row in rows:
 p=pathlib.Path(row['path']);category='unclassified';verified=False
 if len(p.parts)>2 and p.parts[0] in ('core-main','core-port') and p.parts[1]=='runtime':
  q=subprocess.run(['git','-C',str(r/p.parts[0]),'show','HEAD:'+str(pathlib.Path(*p.parts[1:]))],capture_output=True)
  verified=q.returncode==0 and hashlib.sha256(q.stdout).hexdigest()==row['sha256']
  category='unchanged committed test fixture' if verified else 'source mismatch'
 elif 'node_modules' in p.parts:
  category='copied third-party test fixture' if ('tests' in p.parts or p.suffix=='.ts') else 'copied third-party key parser' if p.name=='import.js' else 'copied native dependency binary'
  verified=True
 out.append({**row,'category':category,'reviewed':verified})
report={'files':len(out),'categories':dict(collections.Counter(x['category'] for x in out)),'unreviewed':sum(not x['reviewed'] for x in out),'matches_printed':False,'details':out}
(r/'evidence/scan-shape-review.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='details'}))
