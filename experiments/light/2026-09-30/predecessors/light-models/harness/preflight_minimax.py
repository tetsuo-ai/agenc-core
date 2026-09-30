import os,json,urllib.request,urllib.error
from pathlib import Path
key=os.environ.pop('MINIMAX_API_KEY')
out={'provider':'minimax','endpoint':'https://api.minimax.io/v1/models'}
try:
    req=urllib.request.Request(out['endpoint'],headers={'Authorization':'Bearer '+key})
    with urllib.request.urlopen(req,timeout=30) as res:data=json.load(res)
    out.update(models=[x['id'] for x in data.get('data',[])],ok=any(x.get('id')=='MiniMax-M3' for x in data.get('data',[])))
except urllib.error.HTTPError as e:out.update(ok=False,error='http_'+str(e.code))
except Exception as e:out.update(ok=False,error=type(e).__name__)
Path('/home/paul/claude-agenc-work/light-models/evidence/minimax-preflight.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out))
