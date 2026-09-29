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
PROVIDER='deepseek'
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
PRICING=json.loads((HERE/'pricing.json').read_text())


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

def balance():
    req=urllib.request.Request('https://api.deepseek.com/user/balance',headers={'Authorization':'Bearer '+KEY})
    d=json.load(urllib.request.urlopen(req,timeout=30))
    return {'is_available':d['is_available'],'total_balance':d['balance_infos'][0]['total_balance']}

def spend():
    return sum(json.loads(l).get('budget_charge_usd',json.loads(l).get('cost_usd',0)) for l in LEDGER.read_text().splitlines()) if LEDGER.exists() else 0

def rates(model,stamp):
    d=datetime.datetime.fromtimestamp(stamp,datetime.timezone.utc)
    peak=d.weekday() in PRICING['peak_weekdays_utc'] and any(start<=d.hour<end for start,end in PRICING['peak_hours_utc'])
    base=PRICING['models'][model]['usd_per_million_tokens']
    return [v*(PRICING['peak_multiplier'] if peak else 1) for v in base]


def reservation(body):
    if PROVIDER=='openai':return 0
    # Serialized bytes conservatively bound prompt tokens; reserve peak output.
    peak=PRICING['peak_multiplier']
    rate=PRICING['models'][body['model']]['usd_per_million_tokens']
    output=body.get('max_tokens',body.get('max_completion_tokens',8192))
    return (output*rate[2]*peak+len(json.dumps(body).encode())*rate[1]*peak)/1e6

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':m} for m in ['deepseek-flash','deepseek-v4-pro','gpt-6-luna']]}).encode())
    def do_POST(self):
        with UPSTREAM:
            self.forward()
    def forward(self):
        rid=self.path.split('/')[1]
        if rid not in ACTIVE: self.send_error(404);return
        state=ACTIVE[rid]
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if PROVIDER=='deepseek' and body.get('model') not in PRICING['models']:
            state['budget_stop']=True;state['stop_reason']='unpriced_model'
            self.send_error(400,'Unpriced model refused');return
        stamp=time.time()
        with LOCK:
            used=spend()
            # Reserve peak-price worst-case completion + prompt per outstanding call.
            reserve=reservation(body)
            reserved=sum(sum(s.get('reserved',{}).values()) for s in ACTIVE.values())
            if used+reserved+reserve>=SPEND_CAP:
                self.send_error(429,'Benchmark spend cap');state['budget_stop']=True;state['stop_reason']='spend_cap';return
            if RATE_LIMITED.is_set() or state['calls']>=MAX_CALLS:
                self.send_error(429,'Benchmark call limit');state['budget_stop']=True;state['stop_reason']='provider_subset_stop' if RATE_LIMITED.is_set() else 'call_limit';return
            state['calls']+=1; n=state['calls']
            state.setdefault('reserved',{})[n]=reserve
        dest=state['dir']/f'wire-{n:03}.json'
        write_json(dest,{'sent_at':stamp,'body':body})
        upstream=OPENAI_UPSTREAM if PROVIDER=='openai' else 'https://api.deepseek.com/chat/completions'
        req=urllib.request.Request(upstream,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+(KEY if PROVIDER=='deepseek' else 'benchmark-proxy'),'Content-Type':'application/json'})
        usage={}; toolids=set();error=None
        try:
            with urllib.request.urlopen(req,timeout=180) as res:
                self.send_response(res.status);self.send_header('Content-Type',res.headers.get('Content-Type','text/event-stream'));self.end_headers()
                chunks=[]
                for line in res:
                    chunks.append(line)
                    try:self.wfile.write(line);self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):pass
                    if line.startswith(b'data: '):
                        try:
                            event=json.loads(line[6:])
                            if event.get('usage'):usage=event['usage']
                            if event.get('type') in ('response.completed','response.failed','response.incomplete') and event.get('response',{}).get('usage'):
                                usage=event['response']['usage']
                            item=event.get('item',{})
                            if item.get('type')=='function_call':toolids.add(item.get('call_id',item.get('id')))
                            if event.get('type') in ('error','response.failed','response.incomplete'):
                                error={'type':'upstream_event','event_type':event.get('type'),'code':event.get('code',event.get('error',{}).get('code'))}
                                if PROVIDER=='openai':RATE_LIMITED.set()
                            for c in event.get('choices',[]):
                                for t in c.get('delta',{}).get('tool_calls',[]): toolids.add(t.get('index',t.get('id')))
                        except (ValueError,TypeError):pass
                raw=b''.join(chunks)
                if not body.get('stream'):
                    event=json.loads(raw);usage=event.get('usage',{})
                    for item in event.get('output',[]):
                        if item.get('type')=='function_call':toolids.add(item.get('call_id',item.get('id')))
                    for c in event.get('choices',[]):
                        for t in c.get('message',{}).get('tool_calls',[]):toolids.add(t.get('id'))
                (state['dir']/f'response-{n:03}.txt').write_bytes(raw)
        except urllib.error.HTTPError as e:
            error={'status':e.code,'body':e.read().decode()}
            if PROVIDER=='openai' and e.code in (429,503):RATE_LIMITED.set()
            try:self.send_error(e.code)
            except OSError:pass
        except Exception as e:
            error={'type':type(e).__name__}
            try:self.send_error(502)
            except OSError:pass
        hit=usage.get('prompt_cache_hit_tokens',usage.get('prompt_tokens_details',{}).get('cached_tokens',0))
        inp=usage.get('prompt_tokens',0);out=usage.get('completion_tokens',0)
        if PROVIDER=='openai':
            inp=usage.get('input_tokens',0);out=usage.get('output_tokens',0)
            hit=usage.get('input_tokens_details',{}).get('cached_tokens',0)
        miss=usage.get('prompt_cache_miss_tokens',inp-hit)
        price=rates(body['model'],stamp) if PROVIDER=='deepseek' else None
        cost=(hit*price[0]+miss*price[1]+out*price[2])/1e6 if PROVIDER=='deepseek' else None
        budget_charge=(cost or 0) if usage or (error and 400<=error.get('status',0)<500) else reserve
        record={'run':rid,'call':n,'model':body['model'],'input_tokens':inp,'cached_tokens':hit,'uncached_tokens':miss,'output_tokens':out,'tool_calls':len(toolids),'cost_usd':cost,'cost_basis':'provider-list-rate' if PROVIDER=='deepseek' else 'subscription-unpriced','rates':price,'time':stamp,'seconds':time.time()-stamp,'error':error,'usage':usage,'budget_charge_usd':budget_charge,'usage_missing':not bool(usage) and not (error and 400<=error.get('status',0)<500)}
        with LOCK:
            with LEDGER.open('a') as f:f.write(json.dumps(record)+'\n')
            state['records'].append(record);state['reserved'].pop(n,None)
        write_json(state['dir']/f'usage-{n:03}.json',record)


def cmd(args,cwd=None,env=None,timeout=180,output=None):
    return subprocess.run(args,cwd=cwd,env=env,timeout=timeout,stdout=output or subprocess.PIPE,stderr=subprocess.STDOUT,text=True)

def one(task,agent,model,repeat,phase,port):
    rid=f'{phase}-{model}-{task["id"]}-{agent}-r{repeat}'
    d=ROOT/'runs'/rid
    candidate=phase.startswith('candidate') and agent=='light'
    core=(CORE_CANDIDATE if candidate else CORE_BASE) or ROOT/('core-candidate' if candidate else 'core-base')
    revision=cmd(['git','rev-parse','HEAD'],cwd=core).stdout.strip() if agent!='pi' else PI_VERSION
    if (d/'result.json').exists():
        existing=json.loads((d/'result.json').read_text())
        if existing.get('prompt_sha256')!=hashlib.sha256(task['prompt'].encode()).hexdigest() or existing.get('agent_revision')!=revision or existing.get('configuration_sha256')!=PROVENANCE.get('configuration_sha256'):
            raise RuntimeError('Existing result identity differs; use a new phase: '+rid)
        return existing
    if d.exists():raise RuntimeError('Incomplete attempt preserved; use a new phase: '+rid)
    with LOCK:
        if RATE_LIMITED.is_set():raise RuntimeError('Provider subset stopped after rate limit')
        if PROVIDER=='deepseek':
            b=balance();print(json.dumps(b),flush=True)
            if not b['is_available'] or float(b['total_balance'])<BALANCE_FLOOR or spend()>=SPEND_CAP:
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
    env.update(HOME=str(home),USER='benchmark',LOGNAME='benchmark',AGENC_HOME=str(home/'agenc'),PI_CODING_AGENT_DIR=str(home/'pi'),DEEPSEEK_API_KEY='benchmark-proxy',DEEPSEEK_BASE_URL=base,AGENC_EFFORT_LEVEL='high',AGENC_MAX_OUTPUT_TOKENS='8192',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0',PI_OFFLINE='1',CI='1')
    if PROVIDER=='openai':
        env.pop('DEEPSEEK_API_KEY',None);env.pop('DEEPSEEK_BASE_URL',None)
        env.update(OPENAI_API_KEY='benchmark-proxy',OPENAI_BASE_URL=base,AGENC_EFFORT_LEVEL='low')
    effort='low' if PROVIDER=='openai' else 'high'
    if agent!='pi':
        # The owner authorized these task-owned repositories for benchmark edits.
        write_json(home/'agenc/trusted-projects.json',{'version':1,'trustedProjects':[{'path':str(repo),'trustedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}]})
        (home/'agenc/trusted-projects.json').chmod(0o600)
    if agent=='pi':
        api='openai-responses' if PROVIDER=='openai' else 'openai-completions'
        compat={} if PROVIDER=='openai' else {'supportsDeveloperRole':False,'supportsStore':False,'maxTokensField':'max_tokens','thinkingFormat':'deepseek','requiresReasoningContentOnAssistantMessages':True}
        write_json(home/'pi/models.json',{'providers':{PROVIDER:{'baseUrl':base,'api':api,'apiKey':'OPENAI_API_KEY' if PROVIDER=='openai' else 'DEEPSEEK_API_KEY','models':[{'id':model,'reasoning':True,'contextWindow':1050000 if PROVIDER=='openai' else 1048576,'maxTokens':8192,'compat':compat}]}}})
        args=[str((PI_PREFIX or ROOT/'pi')/'node_modules/.bin/pi'),'--provider',PROVIDER,'--model',model,'--thinking',effort,'--mode','json','--no-session','-p',task['prompt']]
    else:
        args=['node',str(core/'runtime/bin/agenc'),'--provider',PROVIDER,'--model',model,'-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox']
        if agent=='light':args+=['--light']
        args+=[task['prompt']]
    load_start=os.getloadavg()
    start=time.monotonic();rc=None;timeout=False
    with (d/'agent.log').open('w') as log:
        p=subprocess.Popen(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:rc=p.wait(timeout=task.get('timeout_seconds',600))
        except subprocess.TimeoutExpired:
            timeout=True;os.killpg(p.pid,signal.SIGTERM)
            try:rc=p.wait(timeout=15)
            except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);rc=p.wait()
    wall=time.monotonic()-start
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
    result={'id':rid,'harness_sha256':HARNESS_DIGEST,'agent_revision':revision,'prompt_sha256':hashlib.sha256(task['prompt'].encode()).hexdigest(),'load_start':load_start,'load_end':os.getloadavg(),'phase':phase,'provider':PROVIDER,'task':task['id'],'agent':agent,'model':model,'repeat':repeat,'pass':check.returncode==0 and rc==0 and not timeout and not state.get('budget_stop',False),'check_pass':check.returncode==0,'exit_code':rc,'timeout':timeout,'budget_stop':state.get('budget_stop',False),'stop_reason':state.get('stop_reason'),'wall_seconds':wall,'model_calls':len(records),'provider_errors':sum(bool(r['error']) for r in records),'usage_complete':not bool(state.get('reserved')) and len(records)==state['calls'] and all(not r['usage_missing'] for r in records),'first_system_chars':0,'first_schema_chars':0}
    for k in ['input_tokens','cached_tokens','uncached_tokens','output_tokens','tool_calls','cost_usd','budget_charge_usd']:result[k]=sum(r[k] for r in records if r[k] is not None)
    if (d/'wire-001.json').exists():
        body=json.loads((d/'wire-001.json').read_text())['body']
        result['first_system_chars']=len(body.get('instructions',''))+sum(len(json.dumps(m.get('content',''))) for m in body.get('messages',body.get('input',[])) if m.get('role') in ['system','developer'])
        result['first_schema_chars']=len(json.dumps(body.get('tools',[])))
        result['sampling']={k:body.get(k) for k in ['model','thinking','reasoning_effort','max_tokens','max_completion_tokens','max_output_tokens','reasoning','temperature','top_p']}
        result['initial_tools']=[t.get('function',t)['name'] for t in body.get('tools',[]) if 'name' in t.get('function',t)]
    if PROVIDER=='openai':
        result['cost_usd']=None;result['cost_basis']='subscription-unpriced'
    result['configuration_sha256']=PROVENANCE.get('configuration_sha256')
    result['provenance']=PROVENANCE
    if task.get('deferred_capability'):
        result['deferred_evidence']=planning_evidence(d,agent)
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
    ap.add_argument('--provider',default='deepseek',choices=['deepseek','openai'])
    ap.add_argument('--models',default='deepseek-flash')
    ap.add_argument('--agents',default='pi,normal,light')
    ap.add_argument('--tasks',default='')
    ap.add_argument('--repeats',type=int,default=2)
    ap.add_argument('--workers',type=int,default=2)
    ap.add_argument('--spend-cap-usd',type=float,default=10)
    ap.add_argument('--balance-floor-usd',type=float,default=10)
    ap.add_argument('--max-calls',type=int,default=45)
    ap.add_argument('--seed',type=int,default=29092026)
    ap.add_argument('--openai-upstream',default=OPENAI_UPSTREAM,help='Existing loopback Responses bridge; no proxy is started')
    ap.add_argument('--validate-only',action='store_true',help='Validate paths and write provenance without credentials or provider calls')
    return ap


def configure(args):
    global ROOT,CORE_BASE,CORE_CANDIDATE,PI_PREFIX,TASKS_DIR,PROVIDER,LEDGER,PRICING,PROVENANCE,SPEND_CAP,BALANCE_FLOOR,MAX_CALLS,OPENAI_UPSTREAM
    if sys.platform!='linux':raise RuntimeError('Benchmarks must run on Linux')
    if not 1<=args.workers<=2 or args.repeats<1 or args.max_calls<1:
        raise ValueError('Require workers 1..2, repeats >=1 and max-calls >=1')
    if not (0<args.spend_cap_usd<=10) or not (args.balance_floor_usd>=10):
        raise ValueError('Spend cap must be in (0,10]; balance floor must be at least10')
    if not re.fullmatch(r'baseline(?:-[A-Za-z0-9_-]+)?|candidate-[A-Za-z0-9_-]+',args.phase):
        raise ValueError('Use a baseline or candidate-NAME phase')
    parsed=urllib.parse.urlparse(args.openai_upstream)
    if parsed.scheme!='http' or parsed.hostname not in ('127.0.0.1','localhost','::1') or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('OpenAI upstream must be an existing credential-free HTTP loopback URL')
    ROOT=args.root.resolve();CORE_BASE=args.core_base.resolve();CORE_CANDIDATE=args.core_candidate.resolve();PI_PREFIX=args.pi_prefix.resolve()
    TASKS_DIR=args.tasks_manifest.resolve().parent
    PROVIDER=args.provider;LEDGER=ROOT/f'spend-{PROVIDER}.jsonl'
    SPEND_CAP=args.spend_cap_usd;BALANCE_FLOOR=args.balance_floor_usd;MAX_CALLS=args.max_calls;OPENAI_UPSTREAM=args.openai_upstream
    PRICING=json.loads(args.pricing_file.read_text())
    tasks=json.loads(args.tasks_manifest.read_text())['tasks']
    task_ids=[t['id'] for t in tasks]
    if len(task_ids)!=len(set(task_ids)):raise ValueError('Duplicate manifest task IDs')
    selected=selection(args.tasks,task_ids,'task')
    agents=selection(args.agents,['pi','normal','light'],'agent')
    models=selection(args.models,list(PRICING['models']) if PROVIDER=='deepseek' else ['gpt-6-luna'],'model')
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
      'repeats':args.repeats,'workers':args.workers,'seed':args.seed,'max_calls':MAX_CALLS,
      'spend_cap_usd':SPEND_CAP,'balance_floor_usd':BALANCE_FLOOR,
      'reasoning_effort':'low' if PROVIDER=='openai' else 'high','output_cap':8192,
      'pricing_verified_on':PRICING['verified_on']}
    PROVENANCE['configuration_sha256']=hashlib.sha256(json.dumps(PROVENANCE,sort_keys=True).encode()).hexdigest()
    return tasks,agents,models


def main():
    global KEY
    args=parser().parse_args()
    # Remove the real key before even metadata/build-validation subprocesses.
    KEY=os.environ.pop('DEEPSEEK_API_KEY','')
    tasks,agents,models=configure(args)
    ROOT.mkdir(parents=True,exist_ok=True)
    with provider_lock(ROOT,PROVIDER):
        write_json(ROOT/f'provenance-{args.phase}-{PROVIDER}.json',PROVENANCE)
        if args.validate_only:
            KEY=''
            print(json.dumps({'validation':'pass','provider_calls':0,'configuration_sha256':PROVENANCE['configuration_sha256']}));return
        if PROVIDER=='deepseek' and not KEY:raise RuntimeError('Missing DeepSeek process credential')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            jobs=[(t,a,m,r) for m in models for r in range(1,args.repeats+1) for t in tasks for a in agents]
            random.Random(args.seed).shuffle(jobs)
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                futures=[pool.submit(one,t,a,m,r,args.phase,server.server_port) for t,a,m,r in jobs]
                for f in concurrent.futures.as_completed(futures):f.result()
        finally:
            server.shutdown();server.server_close();KEY=''
if __name__=='__main__':main()
