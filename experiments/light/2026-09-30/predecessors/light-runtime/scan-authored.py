#!/usr/bin/env python3
"""Count suspicious credential literals without printing matching data."""
import json, pathlib, re, sys, subprocess
root=pathlib.Path(sys.argv[1])
patterns=[re.compile(rb'(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}'),re.compile(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----'),re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}'),re.compile(rb'github_pat_[A-Za-z0-9_]{30,}')]
authored={}
for checkout in root.iterdir():
    if checkout.is_dir() and (checkout/'.git').exists() and (checkout/'runtime').is_dir():
        names=set()
        for arguments in (['diff','--name-only','46b2a5dbff45d9010bee965ddc5bad150d2f8bed'],['ls-files','--others','--exclude-standard']):
            result=subprocess.run(['git','-C',str(checkout),*arguments],capture_output=True,text=True)
            if result.returncode:raise RuntimeError('Cannot establish authored-file inventory')
            names.update(result.stdout.splitlines())
        authored[checkout.name]=names
scanned=0;hits=0
for p in root.rglob('*'):
    if not p.is_file() or p.is_symlink() or any(part in {'node_modules','.git','__pycache__','dist'} for part in p.parts):continue
    # Preserve unchanged benchmark input repositories; scan authored code,
    # harness copies, logs, spans and generated reports.
    if any(part in {'repo','repos'} for part in p.relative_to(root).parts):continue
    relative=p.relative_to(root)
    if relative.parts[0] in authored and str(pathlib.Path(*relative.parts[1:])) not in authored[relative.parts[0]]:continue
    try:data=p.read_bytes()
    except (OSError,PermissionError):continue
    scanned+=1
    hits+=sum(len(pattern.findall(data)) for pattern in patterns)
print(json.dumps({'files_scanned':scanned,'suspicious_literals':hits,'matched_values_printed':False}))
sys.exit(1 if hits else 0)
