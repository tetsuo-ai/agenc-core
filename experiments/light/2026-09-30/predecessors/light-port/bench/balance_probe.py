"""Read the account floor without persisting the credential on either host."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path)
args=parser.parse_args()

remote = '''import datetime,json,sys,urllib.request
key=sys.stdin.readline().strip()
request=urllib.request.Request("https://api.deepseek.com/user/balance",headers={"Authorization":"Bearer "+key})
with urllib.request.urlopen(request,timeout=30) as response:
    data=json.load(response)
print(json.dumps({"at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"is_available":data["is_available"],"balance_infos":data["balance_infos"]}))
'''
command = ['ssh', '-i', '/Users/tetsuoarena/claude-agenc/pc-ssh/id_ed25519',
           '-o', 'IdentitiesOnly=yes', 'paul@192.168.1.218',
           'python3 -c '+shlex.quote(remote)]
result = subprocess.run(command, input=os.environ['DEEPSEEK_API_KEY']+'\n',
                        text=True, capture_output=True, check=True)
value = json.loads(result.stdout)
root = Path(__file__).resolve().parent.parent
(args.out or root/'evidence/balance-final.json').write_text(json.dumps(value, indent=2)+'\n')
print(json.dumps(value))
