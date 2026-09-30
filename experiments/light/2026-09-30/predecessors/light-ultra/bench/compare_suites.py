"""Compare finished Linux runner logs without reclassifying failed observations."""
import argparse,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('baseline',type=Path);p.add_argument('candidate',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
def parse(path):
 text=re.sub(r'\x1b\[[0-9;]*m','',path.read_text(errors='replace'))
 lines=text.splitlines()
 if not any(re.match(r'^(?:exit=\d+ end=|wrapper_end=)',line) for line in lines[-4:]):raise ValueError('Suite is not finished: '+path.name)
 failures=sorted(set(re.sub(r' \[.*','',line).strip()[5:].strip() for line in lines if line.startswith(' FAIL ')))
 return {'file':path.name,'header':lines[0],'failures':failures,'summary':[line.strip() for line in lines if re.match(r'^\s*(?:Tests |Test Files |Duration |exit=|wrapper_end=)',line)]}
b,c=parse(a.baseline),parse(a.candidate)
r={'baseline':b,'candidate':c,'new_failures':sorted(set(c['failures'])-set(b['failures'])),'baseline_failures_absent':sorted(set(b['failures'])-set(c['failures']))}
a.out.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'new_failures':r['new_failures'],'candidate_summary':c['summary']}))
