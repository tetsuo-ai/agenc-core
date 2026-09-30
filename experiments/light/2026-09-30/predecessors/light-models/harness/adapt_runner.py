from pathlib import Path
p=Path(__file__).with_name('runner-source.py');s=p.read_text()
s=s.replace("PROVIDER='deepseek'","PROVIDER='grok'")
s=s.replace("LUNA_CALL_CAP=600","LUNA_CALL_CAP=600\nMODEL_IDS={'grok':'grok-4.7','openai':'gpt-6-sol','minimax':'MiniMax-M3'}\nRESPONSE_PROVIDERS=('grok','openai')")
s=s.replace("ROOT/'luna-admissions.jsonl'","ROOT/(PROVIDER+'-admissions.jsonl')")
s=s.replace("'luna-admissions.jsonl'","(PROVIDER+'-admissions.jsonl')")
s=s.replace("'gpt-6-luna'","'gpt-6-sol'")
s=s.replace("['deepseek-flash','deepseek-v4-pro','gpt-6-sol']","list(MODEL_IDS.values())")
s=s.replace("PROVIDER=='openai'", "PROVIDER in RESPONSE_PROVIDERS")
s=s.replace("if args.provider=='openai' and args.workers!=1:","if args.workers!=1:")
s=s.replace("def spend():\n    return sum(json.loads(l).get('budget_charge_usd',json.loads(l).get('cost_usd',0)) for l in LEDGER.read_text().splitlines()) if LEDGER.exists() else 0",'''def spend():
    finished={(r['run'],r['call']):r for r in (json.loads(l) for l in LEDGER.read_text().splitlines())} if LEDGER.exists() else {}
    admissions=ROOT/(PROVIDER+'-admissions.jsonl')
    pending=[json.loads(l) for l in admissions.read_text().splitlines()] if admissions.exists() else []
    return sum(r.get('budget_charge_usd',0) for r in finished.values())+sum(r.get('reserve',0) for r in pending if (r['run'],r['call']) not in finished)''')
a=s.index('def reservation(body):');b=s.index('\nclass Proxy',a)
s=s[:a]+'''def reservation(body):
    if PROVIDER in RESPONSE_PROVIDERS:return 0
    # Standard M3: reserve long-context rates against serialized UTF-8 bytes.
    return (8192*2.40+(len(json.dumps(body).encode())+4096)*.60)/1e6

def normalize_body(body):
    if body.get('model')!=MODEL_IDS[PROVIDER]:raise ValueError('model_mismatch')
    if PROVIDER in RESPONSE_PROVIDERS:
        if body.get('reasoning',{}).get('effort')!='low':raise ValueError('effort_mismatch')
        body['max_output_tokens']=8192
    else:
        body.pop('reasoning_effort',None)
        body['thinking']={'type':'adaptive'}
        body['reasoning_split']=True
        body['service_tier']='standard'
        body.pop('max_completion_tokens',None)
        body['max_tokens']=8192
        if body.get('stream'):body['stream_options']={'include_usage':True}
    return body
''' +s[b:]
s=s.replace("body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))", "original=json.loads(self.rfile.read(int(self.headers['Content-Length'])))\n        try:body=normalize_body(dict(original))\n        except ValueError:\n            state['budget_stop']=True;state['stop_reason']='settings_mismatch';self.send_error(400);return")
s=s.replace("'body':body})","'body':body,'client_body':original})")
s=s.replace("upstream=OPENAI_UPSTREAM if PROVIDER in RESPONSE_PROVIDERS else 'https://api.deepseek.com/chat/completions'", "upstream=OPENAI_UPSTREAM if PROVIDER in RESPONSE_PROVIDERS else 'https://api.minimax.io/v1/chat/completions'")
s=s.replace("KEY if PROVIDER=='deepseek' else 'benchmark-proxy'", "KEY if PROVIDER=='minimax' else 'benchmark-proxy'")
s=s.replace("state['calls']+=1; n=state['calls']", "state['calls']+=1; n=state['calls']\n            if PROVIDER=='minimax':\n                with (ROOT/'minimax-admissions.jsonl').open('a') as admission:\n                    admission.write(json.dumps({'run':rid,'call':n,'time':stamp,'reserve':reserve})+'\\n');admission.flush();os.fsync(admission.fileno())")
# Spend includes pending reservations, so don't double count the in-memory copy.
s=s.replace("reserved=sum(sum(s.get('reserved',{}).values()) for s in ACTIVE.values())","reserved=0")
s=s.replace("error={'status':e.code,'body':e.read().decode()}", "error={'status':e.code,'type':'provider_http_error'}\n            e.read()")
s=s.replace("if PROVIDER in RESPONSE_PROVIDERS and e.code in (429,503):RATE_LIMITED.set()", "if e.code in (401,402,403,429,503):RATE_LIMITED.set()")
s=s.replace("price=rates(body['model'],stamp) if PROVIDER=='deepseek' else None", "price=([.06,.30,1.20] if inp<=512000 else [.12,.60,2.40]) if PROVIDER=='minimax' else None")
s=s.replace("if PROVIDER=='deepseek' else None\n        budget_charge", "if PROVIDER=='minimax' else None\n        budget_charge")
s=s.replace("'provider-list-rate' if PROVIDER=='deepseek'", "'provider-list-rate' if PROVIDER=='minimax'")
s=s.replace("with LEDGER.open('a') as f:f.write(json.dumps(record)+'\\n')", "with LEDGER.open('a') as f:f.write(json.dumps(record)+'\\n');f.flush();os.fsync(f.fileno())")
s=s.replace("rid=f'{phase}-{model}-{task[\"id\"]}-{agent}-r{repeat}'", "rid=f'{PROVIDER[0]}{repeat}-{task[\"id\"][:2]}-{agent}'")
s=s.replace("candidate=phase.startswith('candidate') and agent=='light'\n    core=(CORE_CANDIDATE if candidate else CORE_BASE) or ROOT/('core-candidate' if candidate else 'core-base')", "core=CORE_CANDIDATE if agent=='light-port' else CORE_BASE")
s=s.replace("if agent=='light':args+=['--light']", "if agent.startswith('light'):args+=['--light']")
s=s.replace("if PROVIDER=='deepseek':\n            b=balance();print(json.dumps(b),flush=True)\n            if not b['is_available'] or float(b['total_balance'])<BALANCE_FLOOR or spend()>=SPEND_CAP:", "if PROVIDER=='minimax':\n            if spend()>=SPEND_CAP:")
s=s.replace("effort='low' if PROVIDER in RESPONSE_PROVIDERS else 'high'", "if PROVIDER=='grok':env.update(XAI_API_KEY='benchmark-proxy',XAI_BASE_URL=base)\n    if PROVIDER=='minimax':env.update(MINIMAX_API_KEY='benchmark-proxy',MINIMAX_BASE_URL=base)\n    effort='low' if PROVIDER in RESPONSE_PROVIDERS else 'high'")
s=s.replace("{'supportsDeveloperRole':False,'supportsStore':False,'maxTokensField':'max_tokens','thinkingFormat':'deepseek','requiresReasoningContentOnAssistantMessages':True}", "{'supportsDeveloperRole':False,'supportsStore':False,'maxTokensField':'max_tokens','thinkingFormat':'openai','requiresReasoningContentOnAssistantMessages':True}")
s=s.replace("'OPENAI_API_KEY' if PROVIDER in RESPONSE_PROVIDERS else 'DEEPSEEK_API_KEY'", "'OPENAI_API_KEY' if PROVIDER in RESPONSE_PROVIDERS else 'MINIMAX_API_KEY'")
s=s.replace("1050000 if PROVIDER in RESPONSE_PROVIDERS else 1048576", "1050000 if PROVIDER=='openai' else 1000000")
s=s.replace("choices=['deepseek','openai']", "choices=['grok','openai','minimax']")
s=s.replace("default='deepseek'", "default='grok'")
s=s.replace("default='deepseek-flash'", "default='grok-4.7'")
s=s.replace("default='pi,normal,light'", "default='pi,light-main,light-port'")
s=s.replace("['pi','normal','light']", "['pi','light-main','light-port']")
s=s.replace("list(PRICING['models']) if PROVIDER=='deepseek' else ['gpt-6-sol']", "[MODEL_IDS[PROVIDER]]")
s=s.replace("LEDGER=ROOT/('spend-luna.jsonl' if PROVIDER in RESPONSE_PROVIDERS else 'spend-deepseek.jsonl')", "LEDGER=ROOT/('spend-'+PROVIDER+'.jsonl')\n    LUNA_CALL_CAP=800 if PROVIDER=='grok' else 600")
s=s.replace("global ROOT,CORE_BASE", "global LUNA_CALL_CAP,ROOT,CORE_BASE")
s=s.replace("KEY=os.environ.pop('DEEPSEEK_API_KEY','')", "KEY=os.environ.pop('MINIMAX_API_KEY','')")
s=s.replace("if PROVIDER=='deepseek' and not KEY:raise RuntimeError('Missing DeepSeek process credential')", "if PROVIDER=='minimax' and not KEY:raise RuntimeError('Missing MiniMax process credential')")
s=s.replace("random.Random(args.seed).shuffle(jobs)", "random.Random(args.seed).shuffle(jobs)\n            jobs.sort(key=lambda x:(x[3],x[0]['id']))")
# Validate short UNIX-socket paths before any launch.
s=s.replace("load_start=os.getloadavg()", "if len(str(home/'agenc/daemon.sock').encode())>=104:raise RuntimeError('Socket path too long')\n    load_start=os.getloadavg()")
s=s.replace("'model_calls':len(records)","'model_calls':state['calls']")
s=s.replace("result['configuration_sha256']=", "result['started_at']=time.time()-wall\n    result['finished_at']=time.time()\n    result['model_seconds']=sum(max(0,min(r['time']+r['seconds'],time.time())-r['time']) for r in records)\n    result['tool_plus_runtime_seconds']=wall-result['model_seconds']\n    result['configuration_sha256']=")
Path(__file__).with_name('runner.py').write_text(s)
