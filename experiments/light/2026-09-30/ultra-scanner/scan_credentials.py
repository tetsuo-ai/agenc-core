#!/usr/bin/env python3
"""Scan task artifacts for exact authorized credentials without emitting them.

Credentials enter only in the scanner's process environment. --tar-stream
scans remote file bytes on the Mac so the local OAuth bearer never leaves it.
Reports contain counts and paths/offsets, never matching bytes. Symlinks are
not followed. A final scan must run after the last artifact is written.
"""
import argparse, json, os, pathlib, sys, tarfile, time

def scan(stream, needles):
    overlap=max((len(x) for x in needles),default=1)-1
    tail=b''; consumed=0; found=[]
    while True:
        chunk=stream.read(1024*1024)
        if not chunk:break
        data=tail+chunk; start=consumed-len(tail)
        for index,needle in enumerate(needles):
            position=0
            while True:
                position=data.find(needle,position)
                if position<0:break
                absolute=start+position
                item=(absolute,len(needle),index)
                if item not in found:found.append(item)
                position+=len(needle)
        consumed+=len(chunk)
        tail=data[-overlap:] if overlap else b''
    return consumed,found

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=pathlib.Path)
    parser.add_argument('--tar-stream',action='store_true')
    parser.add_argument('--report',type=pathlib.Path,required=True)
    args=parser.parse_args()
    if bool(args.root)==bool(args.tar_stream):parser.error('Choose root or tar stream')
    secrets={name:os.environ.pop(name,'').encode() for name in ('DEEPSEEK_API_KEY','LUNA_PROXY_BEARER','OPENAI_API_KEY')}
    secrets={name:value for name,value in secrets.items() if value}
    if 'DEEPSEEK_API_KEY' not in secrets or len(secrets)<2:raise RuntimeError('DeepSeek and an authorized Luna credential required in process environment')
    needles=list(secrets.values())
    counts={'credential_names':list(secrets),'files':0,'bytes':0,'symlinks_skipped':0,'credential_hits':0,'errors':[],'hits':[]}
    last_progress=time.monotonic()
    def visit(name,stream):
        nonlocal last_progress
        size,hits=scan(stream,needles)
        counts['files']+=1;counts['bytes']+=size
        if hits:
            counts['credential_hits']+=len(hits)
            counts['hits'].append({'path':name,'ranges':[{'offset':p,'length':n,'credential_index':i} for p,n,i in hits]})
        if time.monotonic()-last_progress>=30:
            print(json.dumps({'scan_progress':True,'files':counts['files'],'bytes':counts['bytes'],'credential_hits':counts['credential_hits']}),flush=True)
            last_progress=time.monotonic()
    if args.tar_stream:
        with tarfile.open(fileobj=sys.stdin.buffer,mode='r|*') as archive:
            for member in archive:
                if member.isfile():
                    with archive.extractfile(member) as stream:visit(member.name,stream)
                elif member.issym():counts['symlinks_skipped']+=1
    else:
        for directory,dirs,files in os.walk(args.root,followlinks=False):
            for name in files:
                path=pathlib.Path(directory)/name
                if path.is_symlink():counts['symlinks_skipped']+=1;continue
                try:
                    if path.is_file():
                        with path.open('rb') as stream:visit(str(path),stream)
                except OSError as error:counts['errors'].append({'path':str(path),'type':type(error).__name__})
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(counts,indent=2)+'\n')
    print(json.dumps({k:v for k,v in counts.items() if k not in ('hits','errors')}|{'error_count':len(counts['errors'])}))
    return 1 if counts['credential_hits'] or counts['errors'] else 0

if __name__=='__main__':sys.exit(main())
