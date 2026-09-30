import pathlib,os,re,json,sys,hashlib
root=pathlib.Path(sys.argv[1]).resolve();known=[v.encode() for k,v in os.environ.items() if k in ('MINIMAX_SCAN_KEY','SOL_SCAN_BEARER') and v]
# Never print matching material or paths. Report aggregate counts only.
patterns=[re.compile(rb'sk-(?:proj-)?[A-Za-z0-9_-]{32,}'),re.compile(rb'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'),re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]
files=total=hits=errors=shapes=0;shape_hashes=[]
for p in root.rglob('*'):
 if p.is_symlink() or not p.is_file():continue
 try:
  files+=1;total+=p.stat().st_size
  found=False;potential=False;tail=b'';digest=hashlib.sha256()
  with p.open('rb') as handle:
   while chunk:=handle.read(1024*1024):
    digest.update(chunk);b=tail+chunk
    found=found or any(k in b for k in known)
    potential=potential or any(pat.search(b) for pat in patterns)
    tail=b[-65536:]
  hits+=found;shapes+=potential
  if potential:shape_hashes.append({'path':str(p.relative_to(root)),'sha256':digest.hexdigest()})
 except OSError:errors+=1
out={'files':files,'bytes':total,'known_secret_match_files':hits,'credential_shape_files':shapes,'read_errors':errors,'known_values':len(known)}
(root/'evidence'/('scan-'+sys.platform+'.json')).write_text(json.dumps(out,indent=2)+'\n')
(root/'evidence'/('scan-shape-hashes-'+sys.platform+'.json')).write_text(json.dumps(shape_hashes,indent=2)+'\n')
print(json.dumps(out))
