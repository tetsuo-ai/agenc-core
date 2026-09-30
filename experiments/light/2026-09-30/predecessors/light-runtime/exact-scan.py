#!/usr/bin/env python3
import json,pathlib,sys
secret=sys.stdin.buffer.readline().rstrip(b'\r\n')
if not secret:raise SystemExit('Missing scan token on stdin')
root=pathlib.Path(sys.argv[1]);files=[]
for p in root.rglob('*'):
    if p.is_file() and not p.is_symlink() and not any(part in {'node_modules','.git','__pycache__'} for part in p.parts):files.append(p)
if len(sys.argv)>2:files.extend(pathlib.Path(sys.argv[2]).glob('light-runtime-*'))
hits=0;scanned=0
for p in files:
    if not p.is_file():continue
    try:
        with p.open('rb') as f:
            carry=b''
            while chunk:=f.read(1024*1024):
                data=carry+chunk
                if secret in data:hits+=1;break
                carry=data[-len(secret)+1:]
        scanned+=1
    except PermissionError:raise SystemExit('Credential scan could not read a task file')
print(json.dumps({'files_scanned':scanned,'credential_matches':hits,'matched_values_printed':False}))
sys.exit(1 if hits else 0)
