from pathlib import Path
p=Path('bench/luna-api/runner.py');s=p.read_text()
s=s.replace("OPENAI_UPSTREAM='http://127.0.0.1:8809/v1/responses'", "OPENAI_UPSTREAM='https://api.openai.com/v1'")
a=s.index('class Proxy('); b=s.index('\ndef cmd(',a);s=s[:a]+s[b:]
a=s.index('def luna_call_ids():');b=s.index('@contextmanager',a)
s=s[:a]+'''def api_admissions():
    p=ROOT/'luna-api-ledger.jsonl'
    return [json.loads(x) for x in p.read_text().splitlines() if json.loads(x)['event']=='admit'] if p.exists() else []

def luna_call_ids():
    return {(r['run'],r['call']) for r in api_admissions()}

'''+s[b:]
s=s.replace('LUNA_CALL_CAP=600', "LUNA_CALL_CAP=int(os.environ.get('LUNA_API_CALL_CAP','331'))")
s=s.replace("if RATE_LIMITED.is_set():raise RuntimeError('Provider subset stopped after rate limit')", "if (ROOT/'luna-api-stop.json').exists():raise RuntimeError('API stopped: inspect transport or budget before resuming unstarted cells')")
s=s.replace("base=f'http://127.0.0.1:{port}/{rid}/v1'", "base='https://api.openai.com/v1'")
s=s.replace("env.update(OPENAI_API_KEY='benchmark-proxy',OPENAI_BASE_URL=base,AGENC_EFFORT_LEVEL='low')", "env.update(OPENAI_API_KEY=KEY,OPENAI_BASE_URL=base,AGENC_EFFORT_LEVEL='low', NODE_OPTIONS='--import='+str(HERE/'direct.mjs'), LUNA_LEDGER_ROOT=str(ROOT), LUNA_RUN_DIR=str(d), LUNA_RUN_ID=rid, LUNA_API_CALL_CAP=str(LUNA_CALL_CAP))")
s=s.replace("    records=state['records']", "    records=[json.loads(p.read_text()) for p in sorted(d.glob('usage-*.json'))]\n    state['calls']=sum(r['run']==rid for r in api_admissions())\n    state['reserved']={} if len(records)==state['calls'] else {'unknown':True}\n    state['budget_stop']=(ROOT/'luna-api-stop.json').exists()\n    state['stop_reason']=json.loads((ROOT/'luna-api-stop.json').read_text()).get('reason') if state['budget_stop'] else None")
s=s.replace("result['cost_usd']=None;result['cost_basis']='subscription-unpriced'", "result['cost_basis']='official-openai-api-list-rate'\n        if not result['usage_complete']: result['cost_usd']=None")
s=s.replace("default='deepseek',choices=['deepseek','openai']", "default='openai',choices=['openai']")
s=s.replace("default='deepseek-flash'", "default='gpt-6-luna'")
s=s.replace("default='pi,normal,light'", "default='pi,light'")
s=s.replace("'--workers',type=int,default=2", "'--workers',type=int,default=1")
s=s.replace("help='Existing loopback Responses bridge; no proxy is started'", "help='Official direct API; no relay is used'")
s=s.replace("if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost','::1') or parsed.username or parsed.password or parsed.query or parsed.fragment:", "if args.openai_upstream != 'https://api.openai.com/v1':")
s=s.replace("raise ValueError('OpenAI upstream must be an existing credential-free HTTP loopback URL')", "raise ValueError('Only the official direct API is supported')")
s=s.replace("0<args.spend_cap_usd<=35", "0<args.spend_cap_usd<=10")
s=s.replace("(0,35]", "(0,10]")
s=s.replace("files=sorted([*HERE.glob('*.py'),", "files=sorted([*HERE.glob('*.mjs'),*HERE.glob('*.py'),")
s=s.replace("KEY=os.environ.pop('DEEPSEEK_API_KEY','')", "KEY=os.environ.pop('OPENAI_API_KEY','')")
a=s.index("        if PROVIDER=='deepseek' and not KEY:")
s=s[:a]+'''        if not KEY:raise RuntimeError('Missing OpenAI process credential')
        jobs=[(t,a,m,r) for m in models for r in range(args.repeat_start,args.repeat_start+args.repeats) for t in tasks for a in agents]
        random.Random(args.seed).shuffle(jobs)
        try:
            for t,a,m,r in jobs:
                one(t,a,m,r,args.phase,None)
        finally: KEY=''
if __name__=='__main__':main()
'''
p.write_text(s)
