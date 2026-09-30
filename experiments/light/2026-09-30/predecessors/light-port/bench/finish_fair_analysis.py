"""Analyze the complete predeclared matrix after it finishes; never launch cells."""
from pathlib import Path
import json,subprocess,tarfile,time,shutil
r=Path(__file__).resolve().parent.parent
e=r/'evidence'
ssh=['ssh','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes','paul@192.168.1.218']
scp=['scp','-q','-i','/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519','-o','IdentitiesOnly=yes']
def run(cmd,**kw):return subprocess.run(cmd,check=True,**kw)
while True:
    rows=[]
    for line in (e/'candidate-eq-launch.log').read_text().splitlines():
        try:value=json.loads(line)
        except ValueError:continue
        if 'id' in value:rows.append(value)
    if len(rows)==48:break
    time.sleep(20)
run(ssh+['python3 ~/claude-agenc-work/light-port/verify_fair.py'])
run(scp+['paul@192.168.1.218:claude-agenc-work/light-port/fair-provenance.json',str(e/'fair-provenance.json')])
with (e/'fair-traces.tar.gz').open('wb') as out:
    run(ssh+['python3 ~/claude-agenc-work/light-port/export_fair_traces.py'],stdout=out)
raw=e/'raw/light-port';raw.mkdir(parents=True,exist_ok=True)
with tarfile.open(e/'fair-traces.tar.gz') as archive:
    for member in archive.getmembers():
        target=raw/member.name
        if not member.isfile() or not target.resolve().is_relative_to(raw.resolve()):
            raise ValueError('Unexpected archive member')
        target.parent.mkdir(parents=True,exist_ok=True)
        with archive.extractfile(member) as source, target.open('wb') as dest:
            shutil.copyfileobj(source,dest)
run(['python3',str(r/'bench/decompose.py'),'--roots',str(raw),'--retained',str(e/'decomposition.json'),'--phases','candidate-eq','--tokenizer',str(e/'tokenizer/tokenizer.json'),'--out',str(e/'decomposition-fair.json')])
run(['python3',str(r/'bench/render_status.py'),'--input',str(e/'decomposition-fair.json')])
with (e/'fair-comparison-render.log').open('w') as out:
    run(['python3',str(r/'bench/report_metrics.py'),'--input',str(e/'decomposition-fair.json'),'--cohorts','port/candidate-eq','--out',str(e/'fair-comparison.json'),'--require-full'],stdout=out)
run(ssh+['python3 ~/claude-agenc-work/light-port/overlap.py'])
run(scp+['paul@192.168.1.218:claude-agenc-work/light-port/overlap.json',str(e/'overlap-fair.json')])
o=json.loads((e/'overlap-fair.json').read_text());rows=[x for x in o['runs'] if x['run'].startswith('candidate-eq-')]
summary={'cells':len(rows),'with_other_job':sum(bool(x['other_job_runs']) for x in rows),'with_own_suites':sum(any(n.startswith('light-port-') for n in x['core_suites']) for x in rows),'with_other_suites':sum(any(not n.startswith('light-port-') for n in x['core_suites']) for x in rows)}
(e/'fair-overlap-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
run(ssh+['docker run --rm --user 1000:1000 --cpus=1 --memory=1g -v /home/paul/claude-agenc-work/light-port:/work -w /work node:26.5.0-bookworm python3 /work/harness-fast/trace_audit.py --runs /work/runs --benchmark-root /work --out /work/trace-fair.json --phase candidate-eq --completed-only'])
run(scp+['paul@192.168.1.218:claude-agenc-work/light-port/trace-fair.json',str(e/'trace-fair.json')])
print(json.dumps({'analysis_complete':True,'overlap':summary}),flush=True)
