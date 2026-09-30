#!/usr/bin/env python3
"""Linux-only matched-agent benchmark. Credentials only enter through environment.
Wire capture excludes headers and uses a dummy client bearer. Do not run on Mac.
"""
import argparse, concurrent.futures, datetime, fcntl, hashlib, http.server, json, os, pathlib, random, re, signal, subprocess, sys, threading, time, urllib.request, urllib.error, urllib.parse
from contextlib import contextmanager
from trace_checks import planning_evidence
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE/'artifacts'
CORE_BASE=CORE_CANDIDATE=PI_PREFIX=None
TASKS_DIR=HERE/'tasks'
KEY=''
PROVIDER='grok'
RATE_LIMITED=threading.Event()
LOCK=threading.Lock()
UPSTREAM=threading.BoundedSemaphore(2)
ACTIVE={}
LEDGER=ROOT/'spend.jsonl'
HARNESS_DIGEST=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
SPEND_CAP=10.0
BALANCE_FLOOR=10.0
MAX_CALLS=45
OPENAI_UPSTREAM='http://127.0.0.1:8809/v1/responses'
PI_VERSION='0.73.1'
PROVENANCE={}
LUNA_CALL_CAP=600
MODEL_IDS={'grok':'grok-4.7','openai':'gpt-6-sol','minimax':'MiniMax-M3'}
RESPONSE_PROVIDERS=('grok','openai')
OPENAI_REASONING_REPLAY=False
PRICING=json.loads((HERE/'pricing.json').read_text())


def luna_call_ids():
    """Count earlier usage and preflight reservations once, including interrupted calls."""
    calls=set()
    for path in (LEDGER, ROOT/(PROVIDER+'-admissions.jsonl')):
        if path.exists():
            for line in path.read_text().splitlines():
                record=json.loads(line)
                calls.add((record['run'],record['call']))
    return calls


def reserve_luna_call(run, call):
    # Caller holds LOCK, and the provider lock excludes another orchestrator.
    if len(luna_call_ids())>=LUNA_CALL_CAP:
        return False
    with (ROOT/(PROVIDER+'-admissions.jsonl')).open('a') as handle:
        handle.write(json.dumps({'run':run,'call':call,'time':time.time()})+'\n')
        handle.flush();os.fsync(handle.fileno())
    return True


@contextmanager
def provider_lock(root, provider):
    """One orchestrator per provider/output root; its requests share one semaphore."""
    lock=root/'locks'/f'{provider}.lock'
    lock.parent.mkdir(parents=True,exist_ok=True)
    with lock.open('a') as handle:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another runner owns this provider/output root') from error
        try:yield
        finally:fcntl.flock(handle,fcntl.LOCK_UN)


def selection(raw, available, label):
    values=raw.split(',') if raw else list(available)
    if not values or len(values)!=len(set(values)) or any(v not in available for v in values):
        raise ValueError(f'Invalid or duplicate {label} selector')
    return values

def write_json(p,v):
    p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(json.dumps(v,indent=2)+'\n')

def spend():
    finished={(r['run'],r['call']):r for r in (json.loads(l) for l in LEDGER.read_text().splitlines())} if LEDGER.exists() else {}
    admissions=ROOT/(PROVIDER+'-admissions.jsonl')
    pending=[json.loads(l) for l in admissions.read_text().splitlines()] if admissions.exists() else []
    return sum(r.get('budget_charge_usd',0) for r in finished.values())+sum(r.get('reserve',0) for r in pending if (r['run'],r['call']) not in finished)

def reservation(body):
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

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':m} for m in list(MODEL_IDS.values())]}).encode())
    def do_POST(self):
        with UPSTREAM:
            self.forward()
    def forward(self):
        rid=self.path.split('/')[1]
        if rid not in ACTIVE: self.send_error(404);return
        state=ACTIVE[rid]
        original=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        try:body=normalize_body(dict(original))
        except ValueError:
            state['budget_stop']=True;state['stop_reason']='settings_mismatch';self.send_error(400);return
        stamp=time.time()
        with LOCK:
            used=spend()
            # Reserve peak-price worst-case completion + prompt per outstanding call.
            reserve=reservation(body)
            reserved=0
            if used+reserved+reserve>=SPEND_CAP:
                self.send_error(429,'Benchmark spend cap');state['budget_stop']=True;state['stop_reason']='spend_cap';return
            if RATE_LIMITED.is_set() or state['calls']>=MAX_CALLS:
                self.send_error(429,'Benchmark call limit');state['budget_stop']=True;state['stop_reason']='provider_subset_stop' if RATE_LIMITED.is_set() else 'call_limit';return
            if PROVIDER in RESPONSE_PROVIDERS and not reserve_luna_call(rid,state['calls']+1):
                RATE_LIMITED.set();state['budget_stop']=True;state['stop_reason']='study_call_cap'
                self.send_error(429,'Study call cap');return
            state['calls']+=1; n=state['calls']
            if PROVIDER=='minimax':
                with (ROOT/'minimax-admissions.jsonl').open('a') as admission:
                    admission.write(json.dumps({'run':rid,'call':n,'time':stamp,'reserve':reserve})+'\n');admission.flush();os.fsync(admission.fileno())
            state.setdefault('reserved',{})[n]=reserve
        dest=state['dir']/f'wire-{n:03}.json'
        write_json(dest,{'sent_at':stamp,'body':body,'client_body':original})
        upstream=OPENAI_UPSTREAM if PROVIDER in RESPONSE_PROVIDERS else 'https://api.minimax.io/v1/chat/completions'
        req=urllib.request.Request(upstream,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+(KEY if PROVIDER=='minimax' else 'benchmark-proxy'),'Content-Type':'application/json'})
        usage={}; toolids=set();error=None
        timing={'request_received_at':stamp,'upstream_start_at':time.time(),
                'response_headers_at':None,'first_token_at':None,'last_token_at':None,'stream_end_at':None}
        try:
            with urllib.request.urlopen(req,timeout=180) as res:
                timing['response_headers_at']=time.time()
                self.send_response(res.status);self.send_header('Content-Type',res.headers.get('Content-Type','text/event-stream'));self.end_headers()
                chunks=[]
                for line in res:
                    if KEY:line=line.replace(KEY.encode(),b'[REDACTED]')
                    chunks.append(line)
                    try:self.wfile.write(line);self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):pass
                    if line.startswith(b'data: '):
                        try:
                            event=json.loads(line[6:])
                            token=any(any(c.get('delta',{}).get(k) for k in ('content','reasoning_content','tool_calls')) for c in event.get('choices',[]))
                            token=token or (event.get('type') in ('response.output_text.delta','response.function_call_arguments.delta','response.reasoning_summary_text.delta','response.reasoning_text.delta') and bool(event.get('delta')))
                            if token:
                                now=time.time()
                                if timing['first_token_at'] is None:timing['first_token_at']=now
                                timing['last_token_at']=now
                            if event.get('usage'):usage=event['usage']
                            if event.get('type') in ('response.completed','response.failed','response.incomplete') and event.get('response',{}).get('usage'):
                                usage=event['response']['usage']
                            item=event.get('item',{})
                            if item.get('type')=='function_call':toolids.add(item.get('call_id',item.get('id')))
                            if event.get('type') in ('error','response.failed','response.incomplete'):
                                error={'type':'upstream_event','event_type':event.get('type'),'code':event.get('code',event.get('error',{}).get('code'))}
                                if PROVIDER in RESPONSE_PROVIDERS:RATE_LIMITED.set()
                            for c in event.get('choices',[]):
                                for t in c.get('delta',{}).get('tool_calls',[]): toolids.add(t.get('index',t.get('id')))
                        except (ValueError,TypeError):pass
                timing['stream_end_at']=time.time()
                raw=b''.join(chunks)
                if not body.get('stream'):
                    event=json.loads(raw);usage=event.get('usage',{})
                    for item in event.get('output',[]):
                        if item.get('type')=='function_call':toolids.add(item.get('call_id',item.get('id')))
                    for c in event.get('choices',[]):
                        for t in c.get('message',{}).get('tool_calls',[]):toolids.add(t.get('id'))
                (state['dir']/f'response-{n:03}.txt').write_bytes(raw)
        except urllib.error.HTTPError as e:
            error={'status':e.code,'type':'provider_http_error'}
            e.read()
            if e.code in (401,402,403,429,503):RATE_LIMITED.set()
            try:self.send_error(e.code)
            except OSError:pass
        except Exception as e:
            error={'type':type(e).__name__}
            try:self.send_error(502)
            except OSError:pass
        hit=usage.get('prompt_cache_hit_tokens',usage.get('prompt_tokens_details',{}).get('cached_tokens',0))
        inp=usage.get('prompt_tokens',0);out=usage.get('completion_tokens',0)
        if PROVIDER in RESPONSE_PROVIDERS:
            inp=usage.get('input_tokens',0);out=usage.get('output_tokens',0)
            hit=usage.get('input_tokens_details',{}).get('cached_tokens',0)
        miss=usage.get('prompt_cache_miss_tokens',inp-hit)
        price=([.06,.30,1.20] if inp<=512000 else [.12,.60,2.40]) if PROVIDER=='minimax' else None
        cost=(hit*price[0]+miss*price[1]+out*price[2])/1e6 if PROVIDER=='minimax' else None
        budget_charge=(cost or 0) if usage or (error and 400<=error.get('status',0)<500) else reserve
        record={'run':rid,'call':n,'model':body['model'],'input_tokens':inp,'cached_tokens':hit,'uncached_tokens':miss,'output_tokens':out,'tool_calls':len(toolids),'cost_usd':cost,'cost_basis':'provider-list-rate' if PROVIDER=='minimax' else 'subscription-unpriced','rates':price,'time':stamp,'seconds':time.time()-stamp,'error':error,'usage':usage,'budget_charge_usd':budget_charge,'usage_missing':not bool(usage) and not (error and 400<=error.get('status',0)<500)}
        record['timing']=timing
        with LOCK:
            with LEDGER.open('a') as f:f.write(json.dumps(record)+'\n');f.flush();os.fsync(f.fileno())
            state['records'].append(record);state['reserved'].pop(n,None)
        write_json(state['dir']/f'usage-{n:03}.json',record)


def cmd(args,cwd=None,env=None,timeout=180,output=None):
    return subprocess.run(args,cwd=cwd,env=env,timeout=timeout,stdout=output or subprocess.PIPE,stderr=subprocess.STDOUT,text=True)

def one(task,agent,model,repeat,phase,port):
    rid=f'{PROVIDER[0]}{repeat}-{task["id"][:2]}-{agent}'
    d=ROOT/'runs'/rid
    core=CORE_CANDIDATE if agent=='light-port' else CORE_BASE
    revision=cmd(['git','rev-parse','HEAD'],cwd=core).stdout.strip() if agent!='pi' else PI_VERSION
    if (d/'result.json').exists():
        existing=json.loads((d/'result.json').read_text())
        if existing.get('prompt_sha256')!=hashlib.sha256(task['prompt'].encode()).hexdigest() or existing.get('agent_revision')!=revision or existing.get('configuration_sha256')!=PROVENANCE.get('configuration_sha256'):
            raise RuntimeError('Existing result identity differs; use a new phase: '+rid)
        return existing
    if d.exists():raise RuntimeError('Incomplete attempt preserved; use a new phase: '+rid)
    with LOCK:
        if RATE_LIMITED.is_set():raise RuntimeError('Provider subset stopped after rate limit')
        if PROVIDER in RESPONSE_PROVIDERS and len(luna_call_ids())>=LUNA_CALL_CAP:
            raise RuntimeError('Luna study call cap reached; remaining cells stay unstarted')
        if PROVIDER=='minimax':
            if spend()>=SPEND_CAP:
                raise RuntimeError('Provider budget floor reached')
    d.mkdir(parents=True,exist_ok=True)
    repo=d/'repo'; home=d/'home';home.mkdir(exist_ok=True)
    cache=ROOT/'repos'/task['repo_sha']
    if not cache.exists():
        with LOCK:
            if not cache.exists():
                r=cmd(['git','clone','-q',task['repo_url'],str(cache)])
                if r.returncode:raise RuntimeError(r.stdout)
                r=cmd(['git','checkout','-q',task['repo_sha']],cwd=cache)
                if r.returncode:raise RuntimeError(r.stdout)
    clone=cmd(['git','clone','-q','--no-hardlinks',str(cache),str(repo)])
    if clone.returncode:raise RuntimeError('Fresh task clone failed '+rid)
    setup=cmd([sys.executable,str(TASKS_DIR/task['setup_script']),str(repo)],timeout=120)
    (d/'setup.log').write_text(setup.stdout)
    if setup.returncode:raise RuntimeError('Task setup failed '+rid)
    state={'dir':d,'calls':0,'records':[]};ACTIVE[rid]=state
    base=f'http://127.0.0.1:{port}/{rid}/v1'
    env={k:v for k,v in os.environ.items() if not any(s in k for s in ['KEY','TOKEN','SECRET'])}
    env.update(HOME=str(home),USER='benchmark',LOGNAME='benchmark',AGENC_HOME=str(home/'agenc'),PI_CODING_AGENT_DIR=str(home/'pi'),AGENC_EFFORT_LEVEL='high',AGENC_MAX_OUTPUT_TOKENS='8192',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0',PI_OFFLINE='1',CI='1')
    if PROVIDER in RESPONSE_PROVIDERS:
        env.pop('DEEPSEEK_API_KEY',None);env.pop('DEEPSEEK_BASE_URL',None)
        env.update(OPENAI_API_KEY='benchmark-proxy',OPENAI_BASE_URL=base,AGENC_EFFORT_LEVEL='low')
        env['AGENC_OPENAI_REASONING_REPLAY']='1' if OPENAI_REASONING_REPLAY else '0'
    if PROVIDER=='grok':env.update(XAI_API_KEY='benchmark-proxy',XAI_BASE_URL=base)
    if PROVIDER=='minimax':env.update(MINIMAX_API_KEY='benchmark-proxy',MINIMAX_BASE_URL=base)
    effort='low' if PROVIDER in RESPONSE_PROVIDERS else 'high'
    if agent!='pi':
        # The owner authorized these task-owned repositories for benchmark edits.
        write_json(home/'agenc/trusted-projects.json',{'version':1,'trustedProjects':[{'path':str(repo),'trustedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}]})
        (home/'agenc/trusted-projects.json').chmod(0o600)
    if agent=='pi':
        api='openai-responses' if PROVIDER in RESPONSE_PROVIDERS else 'openai-completions'
        compat={} if PROVIDER in RESPONSE_PROVIDERS else {'supportsDeveloperRole':False,'supportsStore':False,'maxTokensField':'max_tokens','thinkingFormat':'openai','requiresReasoningContentOnAssistantMessages':True}
        write_json(home/'pi/models.json',{'providers':{PROVIDER:{'baseUrl':base,'api':api,'apiKey':'OPENAI_API_KEY' if PROVIDER in RESPONSE_PROVIDERS else 'MINIMAX_API_KEY','models':[{'id':model,'reasoning':True,'contextWindow':1050000 if PROVIDER=='openai' else 1000000,'maxTokens':8192,'compat':compat}]}}})
        args=[str((PI_PREFIX or ROOT/'pi')/'node_modules/.bin/pi'),'--provider',PROVIDER,'--model',model,'--thinking',effort,'--mode','json','--no-session','-p',task['prompt']]
    else:
        args=['node',str(core/'runtime/bin/agenc'),'--provider',PROVIDER,'--model',model,'-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox']
        if agent.startswith('light'):args+=['--light']
        args+=[task['prompt']]
    if len(str(home/'agenc/daemon.sock').encode())>=104:raise RuntimeError('Socket path too long')
    load_start=os.getloadavg()
    start=time.monotonic();epoch_start=time.time();rc=None;timeout=False
    with (d/'agent.log').open('w') as log:
        p=subprocess.Popen(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:rc=p.wait(timeout=task.get('timeout_seconds',600))
        except subprocess.TimeoutExpired:
            timeout=True;os.killpg(p.pid,signal.SIGTERM)
            try:rc=p.wait(timeout=15)
            except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);rc=p.wait()
    wall=time.monotonic()-start;epoch_end=time.time()
    if agent!='pi':
        with (d/'daemon-stop.log').open('w') as log:
            try:cmd(['node',str(core/'runtime/bin/agenc'),'daemon','stop'],env=env,output=log,timeout=25)
            except subprocess.TimeoutExpired:pass
    check=cmd([sys.executable,str(TASKS_DIR/task['check_script']),str(repo)],timeout=120)
    (d/'check.log').write_text(check.stdout)
    drain_deadline=time.monotonic()+210
    while state.get('reserved') and time.monotonic()<drain_deadline:
        time.sleep(.25)
    records=state['records']
    result={'id':rid,'harness_sha256':HARNESS_DIGEST,'agent_revision':revision,'prompt_sha256':hashlib.sha256(task['prompt'].encode()).hexdigest(),'load_start':load_start,'load_end':os.getloadavg(),'phase':phase,'provider':PROVIDER,'task':task['id'],'agent':agent,'model':model,'repeat':repeat,'pass':check.returncode==0 and rc==0 and not timeout and not state.get('budget_stop',False),'check_pass':check.returncode==0,'exit_code':rc,'timeout':timeout,'budget_stop':state.get('budget_stop',False),'stop_reason':state.get('stop_reason'),'wall_seconds':wall,'model_calls':state['calls'],'provider_errors':sum(bool(r['error']) for r in records),'usage_complete':not bool(state.get('reserved')) and len(records)==state['calls'] and all(not r['usage_missing'] for r in records),'first_system_chars':0,'first_schema_chars':0}
    for k in ['input_tokens','cached_tokens','uncached_tokens','output_tokens','tool_calls','cost_usd','budget_charge_usd']:result[k]=sum(r[k] for r in records if r[k] is not None)
    if (d/'wire-001.json').exists():
        body=json.loads((d/'wire-001.json').read_text())['body']
        result['first_system_chars']=len(body.get('instructions',''))+sum(len(json.dumps(m.get('content',''))) for m in body.get('messages',body.get('input',[])) if m.get('role') in ['system','developer'])
        result['first_schema_chars']=len(json.dumps(body.get('tools',[])))
        result['sampling']={k:body.get(k) for k in ['model','thinking','reasoning_effort','max_tokens','max_completion_tokens','max_output_tokens','reasoning','temperature','top_p']}
        result['initial_tools']=[t.get('function',t)['name'] for t in body.get('tools',[]) if 'name' in t.get('function',t)]
    if PROVIDER in RESPONSE_PROVIDERS:
        result['cost_usd']=None;result['cost_basis']='subscription-unpriced'
    result['started_at']=epoch_start
    result['finished_at']=epoch_end
    result['model_seconds']=sum(max(0,min(r['time']+r['seconds'],epoch_end)-max(r['time'],epoch_start)) for r in records)
    result['tool_plus_runtime_seconds']=wall-result['model_seconds']
    result['configuration_sha256']=PROVENANCE.get('configuration_sha256')
    result['provenance']=PROVENANCE
    if task.get('deferred_capability'):
        result['deferred_evidence']=planning_evidence(d,'light' if agent.startswith('light') else agent)
        result['coding_pass']=result['pass']
        if agent!='pi':result['pass'] = result['pass'] and result['deferred_evidence']['pass']
    write_json(d/'result.json',result)
    print(json.dumps(result),flush=True)
    return result

def parser():
    ap=argparse.ArgumentParser(description=__doc__)
    for option in ('root','core-base','core-candidate','pi-prefix'):
        ap.add_argument('--'+option,type=pathlib.Path,required=True)
    ap.add_argument('--tasks-manifest',type=pathlib.Path,default=HERE/'tasks/manifest.json')
    ap.add_argument('--pricing-file',type=pathlib.Path,default=HERE/'pricing.json')
    ap.add_argument('--phase',required=True,help='baseline or candidate-NAME; use a new name for each changed candidate')
    ap.add_argument('--provider',default='grok',choices=['grok','openai','minimax'])
    ap.add_argument('--models',default='grok-4.7')
    ap.add_argument('--agents',default='pi,light-main,light-port')
    ap.add_argument('--tasks',default='')
    ap.add_argument('--repeats',type=int,default=2)
    ap.add_argument('--repeat-start',type=int,default=1,help='First repeat ID; resume missing cells without repeating completed attempts')
    ap.add_argument('--workers',type=int,default=2)
    ap.add_argument('--spend-cap-usd',type=float,default=10)
    ap.add_argument('--balance-floor-usd',type=float,default=10)
    ap.add_argument('--max-calls',type=int,default=45)
    ap.add_argument('--seed',type=int,default=29092026)
    ap.add_argument('--openai-upstream',default=OPENAI_UPSTREAM,help='Existing loopback Responses bridge; no proxy is started')
    ap.add_argument('--openai-reasoning-replay',action='store_true',help='Explicit Light replay ablation; default omits optional replay')
    ap.add_argument('--validate-only',action='store_true',help='Validate paths and write provenance without credentials or provider calls')
    return ap


def configure(args):
    global LUNA_CALL_CAP,ROOT,CORE_BASE,CORE_CANDIDATE,PI_PREFIX,TASKS_DIR,PROVIDER,LEDGER,PRICING,PROVENANCE,SPEND_CAP,BALANCE_FLOOR,MAX_CALLS,OPENAI_UPSTREAM,OPENAI_REASONING_REPLAY,UPSTREAM
    if sys.platform!='linux':raise RuntimeError('Benchmarks must run on Linux')
    if not 1<=args.workers<=2 or args.repeats<1 or args.repeat_start<1 or args.max_calls<1:
        raise ValueError('Require workers 1..2, repeats/repeat-start >=1 and max-calls >=1')
    if args.workers!=1:
        raise ValueError('Luna permits exactly one concurrent run')
    if not (0<args.spend_cap_usd<=35) or not (args.balance_floor_usd>=10):
        raise ValueError('Spend cap must be in (0,35]; balance floor must be at least10')
    if not re.fullmatch(r'baseline(?:-[A-Za-z0-9_-]+)?|candidate-[A-Za-z0-9_-]+',args.phase):
        raise ValueError('Use a baseline or candidate-NAME phase')
    parsed=urllib.parse.urlparse(args.openai_upstream)
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost','::1') or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('OpenAI upstream must be an existing credential-free HTTP loopback URL')
    ROOT=args.root.resolve();CORE_BASE=args.core_base.resolve();CORE_CANDIDATE=args.core_candidate.resolve();PI_PREFIX=args.pi_prefix.resolve()
    TASKS_DIR=args.tasks_manifest.resolve().parent
    PROVIDER=args.provider;LEDGER=ROOT/('spend-'+PROVIDER+'.jsonl')
    LUNA_CALL_CAP=800 if PROVIDER=='grok' else 600
    OPENAI_REASONING_REPLAY=args.openai_reasoning_replay
    UPSTREAM=threading.BoundedSemaphore(1)
    SPEND_CAP=args.spend_cap_usd;BALANCE_FLOOR=args.balance_floor_usd;MAX_CALLS=args.max_calls;OPENAI_UPSTREAM=args.openai_upstream
    PRICING=json.loads(args.pricing_file.read_text())
    tasks=json.loads(args.tasks_manifest.read_text())['tasks']
    task_ids=[t['id'] for t in tasks]
    if len(task_ids)!=len(set(task_ids)):raise ValueError('Duplicate manifest task IDs')
    selected=selection(args.tasks,task_ids,'task')
    agents=selection(args.agents,['pi','light-main','light-port'],'agent')
    models=selection(args.models,[MODEL_IDS[PROVIDER]],'model')
    tasks=[t for t in tasks if t['id'] in selected]
    for task in tasks:
        if not re.fullmatch(r'[A-Za-z0-9_-]+',task['id']):raise ValueError('Unsafe task ID')
        for field in ('setup_script','check_script'):
            path=(TASKS_DIR/task[field]).resolve()
            if not path.is_relative_to(TASKS_DIR) or not path.is_file():raise ValueError('Task script escapes manifest directory or is missing')
    for checkout in (CORE_BASE,CORE_CANDIDATE):
        if not (checkout/'runtime/bin/agenc').is_file():raise ValueError('Missing built Core CLI')
        if cmd(['git','status','--porcelain','--untracked-files=no'],cwd=checkout).stdout.strip():raise ValueError('Core checkout has tracked edits')
    pi_package=PI_PREFIX/'node_modules/@mariozechner/pi-coding-agent/package.json'
    if not (PI_PREFIX/'node_modules/.bin/pi').is_file() or json.loads(pi_package.read_text())['version']!=PI_VERSION:
        raise ValueError('Install pinned Pi '+PI_VERSION+' in --pi-prefix')
    def revision(path):
        result=cmd(['git','rev-parse','HEAD'],cwd=path)
        if result.returncode:raise ValueError('Core checkout revision unavailable')
        return result.stdout.strip()
    files=sorted([*HERE.glob('*.py'),*HERE.joinpath('tasks').rglob('*.py'),HERE/'tasks/manifest.json',HERE/'pricing.json'])
    source_hashes={str(p.relative_to(HERE)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    PROVENANCE={'schema_version':1,'harness_files_sha256':source_hashes,
      'task_manifest_sha256':hashlib.sha256(args.tasks_manifest.read_bytes()).hexdigest(),
      'pricing_sha256':hashlib.sha256(args.pricing_file.read_bytes()).hexdigest(),
      'baseline_revision':revision(CORE_BASE),'candidate_revision':revision(CORE_CANDIDATE),'pi_version':PI_VERSION,
      'node_version':cmd(['node','--version']).stdout.strip(),'python_version':sys.version.split()[0],
      'provider':PROVIDER,'models':models,'tasks':selected,'agents':agents,'phase':args.phase,
      'repeats':args.repeats,'repeat_start':args.repeat_start,'workers':args.workers,'seed':args.seed,'max_calls':MAX_CALLS,
      'spend_cap_usd':SPEND_CAP,'balance_floor_usd':BALANCE_FLOOR,
      'luna_study_call_cap':LUNA_CALL_CAP if PROVIDER in RESPONSE_PROVIDERS else None,
      'openai_reasoning_replay':OPENAI_REASONING_REPLAY if PROVIDER in RESPONSE_PROVIDERS else None,
      'reasoning_effort':'low' if PROVIDER in RESPONSE_PROVIDERS else 'high','output_cap':8192,
      'pricing_verified_on':PRICING['verified_on']}
    PROVENANCE['configuration_sha256']=hashlib.sha256(json.dumps(PROVENANCE,sort_keys=True).encode()).hexdigest()
    return tasks,agents,models


def main():
    global KEY
    args=parser().parse_args()
    # Remove the real key before even metadata/build-validation subprocesses.
    KEY=os.environ.pop('MINIMAX_API_KEY','')
    tasks,agents,models=configure(args)
    ROOT.mkdir(parents=True,exist_ok=True)
    with provider_lock(ROOT,PROVIDER):
        write_json(ROOT/f'provenance-{args.phase}-{PROVIDER}.json',PROVENANCE)
        if args.validate_only:
            KEY=''
            print(json.dumps({'validation':'pass','provider_calls':0,'configuration_sha256':PROVENANCE['configuration_sha256']}));return
        if PROVIDER=='minimax' and not KEY:raise RuntimeError('Missing MiniMax process credential')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            jobs=[(t,a,m,r) for m in models for r in range(args.repeat_start,args.repeat_start+args.repeats) for t in tasks for a in agents]
            random.Random(args.seed).shuffle(jobs)
            jobs.sort(key=lambda x:(x[3],x[0]['id']))
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures=[pool.submit(one,t,a,m,r,args.phase,server.server_port) for t,a,m,r in jobs]
                for f in concurrent.futures.as_completed(futures):f.result()
        finally:
            server.shutdown();server.server_close();KEY=''
if __name__=='__main__':main()
