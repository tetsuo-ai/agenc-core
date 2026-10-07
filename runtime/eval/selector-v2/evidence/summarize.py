"""Read-only statistics and exportable Pareto chart for a locked direct replay.

Usage: python3 summarize.py EVALUATION_JSON OUTPUT_DIR. The replay output lives in
the evaluation archive, not in this repository (see ../README.md).
"""
import json,math,statistics,pathlib,sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
if len(sys.argv)!=3: raise SystemExit('usage: summarize.py EVALUATION_JSON OUTPUT_DIR')
doc=json.loads(pathlib.Path(sys.argv[1]).read_text())
ROOT=pathlib.Path(sys.argv[2]);ROOT.mkdir(parents=True,exist_ok=True)
def wilson(k,n):
 z=1.95996398454;d=1+z*z/n;p=k/n
 center=(p+z*z/(2*n))/d;h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
 return center-h,center+h
names={'selector_v2':'Selector v2 (verified)','current_selector':'Current selector','fixed_parent':'Fixed parent','always_strongest':'Always strongest','always_cheapest':'Always cheapest','openrouter_restricted':'OpenRouter Auto restricted','openrouter_unrestricted':'OpenRouter Auto unrestricted','v2_cold':'V2 parent-first cold','v2_irt':'V2 IRT without verifier',
 'v2_cold_premium_uncapped':'V2 cold, premium uncapped parent','v2_irt_premium_uncapped':'V2 IRT, premium uncapped parent','selector_v2_premium_uncapped':'Selector v2 (verified), premium uncapped parent'}
arms=[arm for arm in names if any(r['arm']==arm for r in doc['rows'])]
def quantile(xs,q):
 xs=sorted(xs);v=(len(xs)-1)*q;lo=int(v);return xs[lo]+(xs[min(lo+1,len(xs)-1)]-xs[lo])*(v-lo)
summaries=[];md=[]
for split in ('calibration','holdout'):
 md+=['## '+split,'','| Arm | Pass / tasks | Wilson 95% | Total USD | USD / task | p50 / p95 seconds | Covered |','|---|---:|---|---:|---:|---:|---:|']
 for arm in arms:
  rows=[r for r in doc['rows'] if r['split']==split and r['arm']==arm]
  if not rows: continue
  n=len(rows);k=sum(r['passed'] for r in rows);lo,hi=wilson(k,n)
  cost=sum(r['costUsd'] or 0 for r in rows);lat=[(r['latencyMs']+r.get('verificationMs',0))/1000 for r in rows]
  s=dict(split=split,arm=arm,n=n,passes=k,quality=k/n,wilson=[lo,hi],costUsd=cost,costPerTask=cost/n,p50=statistics.median(lat),p95=quantile(lat,.95),covered=sum(r['covered'] for r in rows),reconciledTasks=sum(r['costReconciled'] for r in rows))
  summaries.append(s);md.append(f"| {names[arm]} | {k}/{n} | {lo:.1%} to {hi:.1%} | ${cost:.6f} | ${cost/n:.6f} | {s['p50']:.3f} / {s['p95']:.3f} | {s['covered']}/{n} |")
 md+=['']
plt.rcParams.update({'font.size':9,'axes.spines.top':False,'axes.spines.right':False})
fig,axs=plt.subplots(1,2,figsize=(13,5.2),layout='constrained')
colors={'selector_v2':'#dc5a23','current_selector':'#228275','fixed_parent':'#667085','always_strongest':'#8b64aa','always_cheapest':'#2c76b8','openrouter_restricted':'#111111','openrouter_unrestricted':'#70490c'}
for ax,split in zip(axs,('calibration','holdout')):
 ss=[s for s in summaries if s['split']==split and s['arm'] in colors]
 frontier=[s for s in ss if not any(t['costPerTask']<=s['costPerTask'] and t['quality']>=s['quality'] and (t['costPerTask']<s['costPerTask'] or t['quality']>s['quality']) for t in ss)]
 frontier.sort(key=lambda s:s['costPerTask'])
 ax.plot([s['costPerTask'] for s in frontier],[s['quality'] for s in frontier],color='#2c76b8',linestyle='--',alpha=.6,label='Observed Pareto frontier')
 for i,s in enumerate(ss):
  c=colors[s['arm']];q=s['quality'];lo,hi=s['wilson'];ax.errorbar(s['costPerTask'],q,yerr=[[q-lo],[hi-q]],color=c,fmt='o',capsize=3,markersize=7 if s['arm']=='selector_v2' else 5,alpha=.85)
  label=names[s['arm']].replace('OpenRouter Auto ','OR ').replace(' (verified)','')
  offsets={'selector_v2':(0,16),'always_cheapest':(0,16),'current_selector':(0,-28),'fixed_parent':(0,-39),'openrouter_restricted':(32,16),'openrouter_unrestricted':(-35,-17),'always_strongest':(-10,16)}
  if split=='calibration':offsets.update({'current_selector':(15,16),'always_cheapest':(15,-24),'selector_v2':(-15,16),'openrouter_unrestricted':(25,-24),'openrouter_restricted':(12,-17)})
  ax.annotate(label,(s['costPerTask'],q),xytext=offsets[s['arm']],textcoords='offset points',ha='center',fontsize=8,color=c,arrowprops={'arrowstyle':'-','color':c,'linewidth':0.6})
 ax.set_xscale('log');ax.set_ylim(.4,1.035);ax.set_xlim(min(s['costPerTask'] for s in ss)*.65,max(s['costPerTask'] for s in ss)*1.6)
 ax.set_title(('Calibration, 28 tasks (v2 leave-one-task-out)' if split=='calibration' else 'Held out, 14 tasks (policy frozen)'))
 ax.set_xlabel('Mean recorded USD per task, log scale');ax.set_ylabel('Fraction passing all frozen checks');ax.grid(alpha=.15)
fig.suptitle('Selector v2 replay: quality against recorded cost',fontsize=12)
fig.savefig(ROOT/'pareto.png',dpi=180)
(ROOT/'tables.md').write_text('\n'.join(md))
(ROOT/'metrics.json').write_text(json.dumps(summaries,indent=2)+'\n')
for split in ['holdout']:
 v=next(s for s in summaries if s['split']==split and s['arm']=='selector_v2')
 for arm in ['openrouter_restricted','openrouter_unrestricted','always_cheapest']:
  c=next(s for s in summaries if s['split']==split and s['arm']==arm)
  print(arm,'cost reduction',1-v['costUsd']/c['costUsd'],'quality delta',v['quality']-c['quality'])
