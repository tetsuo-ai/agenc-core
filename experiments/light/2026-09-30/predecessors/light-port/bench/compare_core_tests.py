"""Preserve full-suite outcome identities rather than comparing only counts."""
import argparse,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--baseline',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
def parse(path):
    text=re.sub(r'\x1b\[[0-9;]*m','',path.read_text())
    lines=text.splitlines()
    assert any(line.startswith('exit=') for line in lines), 'Full suite not finished'
    return {'file':path.name,'header':lines[0], 'failures':sorted({line.strip()[5:].strip().split(' [')[0] for line in lines if line.strip().startswith('FAIL ')}),
            'summary':[line.strip() for line in lines if re.match(r'^\s*(Tests |Test Files |Duration |exit=)',line)]}
b,c=parse(a.baseline),parse(a.candidate)
assert 'sha=3caa13df9d56d1623766096f013e8ffc7e54c043 ' in b['header'], 'Wrong pinned main'
assert 'sha=3c954ea5591c683aa9b14a0219345e11051b06dd ' in c['header'], 'Wrong frozen candidate'
for result in (b,c):
    totals=[int(m[1]) for line in result['summary'] if (m:=re.search(r'^Tests .*\((\d+)\)$',line))]
    assert totals and totals[0]>=32500, 'Incomplete Core suite'
r={'baseline':b,'candidate':c,'new_failures':sorted(set(c['failures'])-set(b['failures'])),'baseline_failures_absent':sorted(set(b['failures'])-set(c['failures']))}
a.out.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'baseline':b['summary'],'candidate':c['summary'],'new_failures':r['new_failures']}))
