"""Add scores in a sidecar. Never overwrite retained outcomes or alter coding graders."""
import argparse,json,pathlib
from call_categories import history,is_error

def score(d,r):
 frozen=r['pass'];symmetric=frozen;detail={}
 if r['task'].startswith('12-'):
  calls,results=history(d)
  successful=[k for k,t in calls.items() if t['name']=='todowrite' and k in results and not is_error(results[k]) and ('Todos have been modified successfully' in str(results[k]) or '"success":true' in str(results[k]).replace(' ',''))]
  code=bool(r.get('coding_pass',r.get('check_pass')) and r.get('exit_code')==0 and not r.get('timeout') and not r.get('budget_stop'))
  # Recover the original discovery receipt even for cohorts scored by the later schema-transition check.
  e=r.get('deferred_evidence',{});frozen=bool(code and (r['agent']=='pi' or e.get('legacy_pass',e.get('pass',False))))
  symmetric=bool(code and successful)
  detail={'successful_plan_calls':len(successful),'coding_complete':code,'pi_tool_unavailable':r['agent']=='pi' and not successful}
 return {**r,'recorded_pass':r['pass'],'frozen_pass':frozen,'symmetric_pass':symmetric,'symmetric_evidence':detail}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root',type=pathlib.Path);p.add_argument('--out',type=pathlib.Path,required=True);a=p.parse_args()
 rows=[score(p.parent,json.loads(p.read_text())) for p in sorted((a.root/'runs').glob('*/result.json'))]
 a.out.write_text(json.dumps(rows,indent=2)+'\n');t=[r for r in rows if r['task'].startswith('12-')]
 print(json.dumps({'retained_cells':len(rows),'task12_cells':len(t),'score_changes':sum(r['symmetric_pass']!=r['frozen_pass'] for r in t),'Pi_without_tool':sum(r['symmetric_evidence']['pi_tool_unavailable'] for r in t)}))
