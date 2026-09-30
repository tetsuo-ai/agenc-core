#!/usr/bin/env python3
"""Report lexical overlap without emitting reference-package text."""
import argparse, collections, hashlib, json, pathlib, re, subprocess
p=argparse.ArgumentParser();p.add_argument('--core',type=pathlib.Path,required=True);p.add_argument('--reference',type=pathlib.Path,required=True);p.add_argument('--base',required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--n',type=int,default=8);p.add_argument('--extra',nargs='*',type=pathlib.Path,default=[]);a=p.parse_args()
def tokens(s):return re.findall(r'[a-z0-9_]+',s.lower())
def grams(s,n=None):
 n=n or a.n
 t=tokens(s);return {tuple(t[i:i+n]) for i in range(max(0,len(t)-n+1))}
def git(*args):return subprocess.check_output(['git','-C',str(a.core),*args],text=True)
index=set();reference=[]
for f in sorted(a.reference.rglob('*')):
 if not f.is_file() or f.suffix not in {'.ts','.js','.mjs','.json','.md','.map'}:continue
 if 'node_modules' in f.relative_to(a.reference).parts:continue
 raw=f.read_bytes();index.update(grams(raw.decode(errors='replace')));reference.append({'path':str(f.relative_to(a.reference)),'sha256':hashlib.sha256(raw).hexdigest()})
changed=git('diff','--name-only',a.base,'HEAD').splitlines();rows=[]
for name in changed:
 f=a.core/name
 if not f.is_file() or f.suffix not in {'.ts','.tsx','.js','.mjs','.md','.json'}:continue
 s=f.read_text();g=grams(s)
 old=subprocess.run(['git','-C',str(a.core),'show',a.base+':'+name],capture_output=True,text=True)
 inherited=grams(old.stdout) if old.returncode==0 else set()
 overlap=g & index;new=overlap-inherited
 positions=[]
 if new:
  ts=list(re.finditer(r'[a-z0-9_]+',s.lower()))
  for i in range(len(ts)-a.n+1):
   if tuple(t.group() for t in ts[i:i+a.n]) in new:
    positions.append(s.count('\n',0,ts[i].start())+1)
 rows.append({'path':name,'sha256':hashlib.sha256(s.encode()).hexdigest(),'ngrams':len(g),'overlap':len(overlap),'overlap_ratio':len(overlap)/max(1,len(g)),'new_overlap':len(new),'numeric_only_new_overlap':sum(all(t.isdigit() for t in gram) for gram in new),'candidate_line_numbers':positions,'new_overlap_hashes':[hashlib.sha256(' '.join(x).encode()).hexdigest() for x in sorted(new)]})
for f in a.extra:
 s=f.read_text();g=grams(s);overlap=g & index
 positions=[]
 if overlap:
  ts=list(re.finditer(r'[a-z0-9_]+',s.lower()))
  for i in range(len(ts)-a.n+1):
   if tuple(t.group() for t in ts[i:i+a.n]) in overlap:
    positions.append(s.count('\n',0,ts[i].start())+1)
 rows.append({'path':str(f),'sha256':hashlib.sha256(s.encode()).hexdigest(),'ngrams':len(g),'overlap':len(overlap),'new_overlap':len(overlap),'numeric_only_new_overlap':sum(all(t.isdigit() for t in gram) for gram in overlap),'candidate_line_numbers':positions})
result={'method':f'lowercase alphanumeric/underscore word {a.n}-grams; full-file and baseline-subtracted overlap; reference text never emitted','base':a.base,'head':git('rev-parse','HEAD').strip(),'reference_files':len(reference),'reference_inventory_sha256':hashlib.sha256(json.dumps(reference,sort_keys=True).encode()).hexdigest(),'files':rows,'new_overlap_total':sum(r['new_overlap'] for r in rows),'caveat':'A lexical screen is evidence of textual independence, not proof of provenance or semantic dissimilarity.'}
result['numeric_only_new_overlap_total']=sum(r['numeric_only_new_overlap'] for r in rows)
result['new_text_overlap_total']=result['new_overlap_total']-result['numeric_only_new_overlap_total']
a.out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'files':len(rows),'reference_files':len(reference),'new_overlap_total':result['new_overlap_total']}))
