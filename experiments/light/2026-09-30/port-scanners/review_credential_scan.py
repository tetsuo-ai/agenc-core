"""Validate known synthetic header fixtures without printing their contents."""
import argparse,json,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--scan',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
s=json.loads(a.scan.read_text());reviews=[]
actual=sum(x['counts']['exact_authorized_credential'] for x in s['findings'])
generic=sum(x['counts']['provider_key_shape'] for x in s['findings'])
for item in s['findings']:
    if not item['counts']['private_key_header']:continue
    path=Path(item['path']);parts=path.parts
    identical=False
    if parts and parts[0].startswith('core'):
        baseline=subprocess.run(['git','-C',str(a.root/parts[0]),'show','3caa13df9d56d1623766096f013e8ffc7e54c043:'+str(Path(*parts[1:]))],capture_output=True)
        identical=baseline.returncode==0 and baseline.stdout==(a.root/path).read_bytes()
    reviews.append({'path':str(path),'baseline_identical':identical})
result={'files':s['files'],'bytes':s['bytes'],'actual_credential_matches':actual,'generic_provider_key_matches':generic,'baseline_fixture_files':len(reviews),'errors':len(s['errors']),'review':reviews}
a.out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k!='review'}))
raise SystemExit(0 if not actual and not generic and not s['errors'] and all(x['baseline_identical'] for x in reviews) else 1)
