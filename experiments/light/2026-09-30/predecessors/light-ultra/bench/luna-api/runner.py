#!/usr/bin/env python3
"""Linux-only matched-agent benchmark. Credentials only enter through environment.
Wire capture excludes headers and uses a dummy client bearer. Do not run on Mac.
"""
import shutil
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
OPENAI_UPSTREAM='https://api.openai.com/v1'
PI_VERSION='0.73.1'
PROVENANCE={}
LUNA_CALL_CAP=None
ADAPTIVE_EFFORT=False
ADAPTIVE_HIGH=False
OPENAI_REASONING_REPLAY=False
REASONING_SUMMARY='auto'
REASONING_SUMMARIES=('auto','concise','detailed','none')
PRICING=json.loads((HERE/'pricing.json').read_text())


def api_admissions():
    p=ROOT/'luna-api-ledger.jsonl'
    return [json.loads(x) for x in p.read_text().splitlines() if json.loads(x)['event']=='admit'] if p.exists() else []

def luna_call_ids():
    return {(r['run'],r['call']) for r in api_admissions()}

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


def cmd(args,cwd=None,env=None,timeout=180,output=None):
    return subprocess.run(args,cwd=cwd,env=env,timeout=timeout,stdout=output or subprocess.PIPE,stderr=subprocess.STDOUT,text=True)

def validate_reasoning_summary(summary, agents):
    if summary not in REASONING_SUMMARIES:
        raise ValueError('Unsupported reasoning summary')
    if 'pi' in agents and summary!='auto':
        raise ValueError('Pi uses reasoning.summary=auto; select auto for a matched Pi panel')

def luna_reasoning_settings(agent):
    validate_reasoning_summary(REASONING_SUMMARY,[agent])
    return {'reasoning_effort':'low','reasoning_summary':REASONING_SUMMARY,
            'light_reasoning_policy':'adaptive' if agent=='light' and ADAPTIVE_EFFORT else 'fixed'}

def write_reasoning_config(run_dir, summary):
    """A new per-run operator config layer; never overwrite retained artifacts."""
    validate_reasoning_summary(summary,[])
    path=run_dir/'agenc-reasoning.toml'
    with path.open('x',encoding='utf-8') as handle:
        handle.write('config_version = 2\nreasoning_summary = '+json.dumps(summary)+'\n')
    path.chmod(0o600)
    return path.resolve()

def write_phase_provenance(path, provenance):
    if path.exists():
        if json.loads(path.read_text())!=provenance:
            raise RuntimeError('Existing phase provenance differs; use a new phase')
        return
    with path.open('x',encoding='utf-8') as handle:
        handle.write(json.dumps(provenance,indent=2)+'\n')

def one(task,agent,model,repeat,phase,port):
    reasoning=luna_reasoning_settings(agent)
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
    if shutil.disk_usage(ROOT).free < 10*1024**3:raise RuntimeError('Paid batch stopped: less than 10 GiB free')
    with LOCK:
        if (ROOT/'luna-api-stop.json').exists():raise RuntimeError('API stopped: inspect transport or budget before resuming unstarted cells')
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
    base='https://api.openai.com/v1'
    env={k:v for k,v in os.environ.items() if not any(s in k for s in ['KEY','TOKEN','SECRET'])}
    env.update(HOME=str(home),USER='benchmark',LOGNAME='benchmark',AGENC_HOME=str(home/'agenc'),PI_CODING_AGENT_DIR=str(home/'pi'),DEEPSEEK_API_KEY='benchmark-proxy',DEEPSEEK_BASE_URL=base,AGENC_EFFORT_LEVEL='high',AGENC_MAX_OUTPUT_TOKENS='8192',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0',PI_OFFLINE='1',CI='1')
    if PROVIDER=='openai':
        env.pop('DEEPSEEK_API_KEY',None);env.pop('DEEPSEEK_BASE_URL',None)
        env.update(OPENAI_API_KEY=KEY,OPENAI_BASE_URL=base,AGENC_EFFORT_LEVEL='low', NODE_OPTIONS='--import='+str(HERE/'direct.mjs'), LUNA_LEDGER_ROOT=str(ROOT), LUNA_RUN_DIR=str(d), LUNA_RUN_ID=rid, LUNA_TASK_CALL_CAP=str(MAX_CALLS), LUNA_ALLOW_ADAPTIVE='1' if ADAPTIVE_EFFORT and agent=='light' else '0', LUNA_ADAPTIVE_HIGH='1' if ADAPTIVE_HIGH and agent=='light' else '0')
        env['AGENC_OPENAI_REASONING_REPLAY']='1' if OPENAI_REASONING_REPLAY else '0'
        env['AGENC_LIGHT_REASONING_POLICY']=reasoning['light_reasoning_policy']
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
        config_path=write_reasoning_config(d,reasoning['reasoning_summary'])
        args=['node',str(core/'runtime/bin/agenc'),'--config',str(config_path),'--provider',PROVIDER,'--model',model,'-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox']
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
    records=[json.loads(p.read_text()) for p in sorted(d.glob('usage-*.json'))]
    state['calls']=sum(r['run']==rid for r in api_admissions())
    state['reserved']={} if len(records)==state['calls'] else {'unknown':True}
    state['budget_stop']=(ROOT/'luna-api-stop.json').exists()
    state['stop_reason']=json.loads((ROOT/'luna-api-stop.json').read_text()).get('reason') if state['budget_stop'] else None
    result={'id':rid,'harness_sha256':HARNESS_DIGEST,'agent_revision':revision,'prompt_sha256':hashlib.sha256(task['prompt'].encode()).hexdigest(),'load_start':load_start,'load_end':os.getloadavg(),'phase':phase,'provider':PROVIDER,'task':task['id'],'agent':agent,'model':model,'repeat':repeat,'pass':check.returncode==0 and rc==0 and not timeout and not state.get('budget_stop',False),'check_pass':check.returncode==0,'exit_code':rc,'timeout':timeout,'budget_stop':state.get('budget_stop',False),'stop_reason':state.get('stop_reason'),'wall_seconds':wall,'model_calls':len(records),'provider_errors':sum(bool(r['error']) for r in records),'usage_complete':not bool(state.get('reserved')) and len(records)==state['calls'] and all(not r['usage_missing'] for r in records),'first_system_chars':0,'first_schema_chars':0}
    for k in ['input_tokens','cached_tokens','uncached_tokens','output_tokens','tool_calls','cost_usd','budget_charge_usd']:result[k]=sum(r[k] for r in records if r[k] is not None)
    if (d/'wire-001.json').exists():
        body=json.loads((d/'wire-001.json').read_text())['body']
        result['first_system_chars']=len(body.get('instructions',''))+sum(len(json.dumps(m.get('content',''))) for m in body.get('messages',body.get('input',[])) if m.get('role') in ['system','developer'])
        result['first_schema_chars']=len(json.dumps(body.get('tools',[])))
        result['sampling']={k:body.get(k) for k in ['model','thinking','reasoning_effort','max_tokens','max_completion_tokens','max_output_tokens','reasoning','temperature','top_p']}
        result['initial_tools']=[t.get('function',t)['name'] for t in body.get('tools',[]) if 'name' in t.get('function',t)]
    if PROVIDER=='openai':
        result['cost_basis']='official-openai-api-list-rate'
        if not result['usage_complete']: result['cost_usd']=None
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
    ap.add_argument('--provider',default='openai',choices=['openai'])
    ap.add_argument('--models',default='gpt-6-luna')
    ap.add_argument('--agents',default='pi,light')
    ap.add_argument('--tasks',default='')
    ap.add_argument('--repeats',type=int,default=2)
    ap.add_argument('--repeat-start',type=int,default=1,help='First repeat ID; resume missing cells without repeating completed attempts')
    ap.add_argument('--workers',type=int,default=1)
    ap.add_argument('--spend-cap-usd',type=float,default=0,help='0: owner-authorized credit exhaustion, durable accounting retained')
    ap.add_argument('--balance-floor-usd',type=float,default=1)
    ap.add_argument('--max-calls',type=int,default=45)
    ap.add_argument('--seed',type=int,default=29092026)
    ap.add_argument('--openai-upstream',default=OPENAI_UPSTREAM,help='Official direct API; no relay is used')
    ap.add_argument('--openai-reasoning-replay',action='store_true',help='Explicit Light replay ablation; default omits optional replay')
    ap.add_argument('--adaptive-high',action='store_true',help='Allow the explicitly measured low-medium-high ladder')
    ap.add_argument('--adaptive-effort',action='store_true',help='Light-only low-to-medium policy experiment; Pi remains low')
    ap.add_argument('--reasoning-summary',choices=REASONING_SUMMARIES,default='auto',help='Explicit AgenC reasoning summary; Pi panels require auto')
    ap.add_argument('--validate-only',action='store_true',help='Validate paths and write provenance without credentials or provider calls')
    return ap


def configure(args):
    global ROOT,CORE_BASE,CORE_CANDIDATE,PI_PREFIX,TASKS_DIR,PROVIDER,LEDGER,PRICING,PROVENANCE,SPEND_CAP,BALANCE_FLOOR,MAX_CALLS,OPENAI_UPSTREAM,OPENAI_REASONING_REPLAY,UPSTREAM,ADAPTIVE_EFFORT,ADAPTIVE_HIGH,REASONING_SUMMARY
    if sys.platform!='linux':raise RuntimeError('Benchmarks must run on Linux')
    if not 1<=args.workers<=2 or args.repeats<1 or args.repeat_start<1 or args.max_calls<1:
        raise ValueError('Require workers 1..2, repeats/repeat-start >=1 and max-calls >=1')
    if args.provider=='openai' and args.workers!=1:
        raise ValueError('Luna permits exactly one concurrent run')
    if args.spend_cap_usd<0 or args.balance_floor_usd<1:
        raise ValueError('Nonnegative optional spend cap and balance floor >=1 required')
    if not re.fullmatch(r'baseline(?:-[A-Za-z0-9_-]+)?|candidate-[A-Za-z0-9_-]+',args.phase):
        raise ValueError('Use a baseline or candidate-NAME phase')
    parsed=urllib.parse.urlparse(args.openai_upstream)
    if args.openai_upstream != 'https://api.openai.com/v1':
        raise ValueError('Only the official direct API is supported')
    ROOT=args.root.resolve();CORE_BASE=args.core_base.resolve();CORE_CANDIDATE=args.core_candidate.resolve();PI_PREFIX=args.pi_prefix.resolve()
    TASKS_DIR=args.tasks_manifest.resolve().parent
    PROVIDER=args.provider;LEDGER=ROOT/('spend-luna.jsonl' if PROVIDER=='openai' else 'spend-deepseek.jsonl')
    OPENAI_REASONING_REPLAY=args.openai_reasoning_replay
    ADAPTIVE_EFFORT=args.adaptive_effort
    ADAPTIVE_HIGH=args.adaptive_high
    REASONING_SUMMARY=args.reasoning_summary
    if ADAPTIVE_HIGH and not ADAPTIVE_EFFORT:raise ValueError("High ladder requires adaptive-effort")
    UPSTREAM=threading.BoundedSemaphore(1 if PROVIDER=='openai' else 2)
    SPEND_CAP=args.spend_cap_usd or float("inf");BALANCE_FLOOR=args.balance_floor_usd;MAX_CALLS=args.max_calls;OPENAI_UPSTREAM=args.openai_upstream
    PRICING=json.loads(args.pricing_file.read_text())
    tasks=json.loads(args.tasks_manifest.read_text())['tasks']
    task_ids=[t['id'] for t in tasks]
    if len(task_ids)!=len(set(task_ids)):raise ValueError('Duplicate manifest task IDs')
    selected=selection(args.tasks,task_ids,'task')
    agents=selection(args.agents,['pi','normal','light'],'agent')
    validate_reasoning_summary(REASONING_SUMMARY,agents)
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
    files=sorted([*HERE.glob('*.mjs'),*HERE.glob('*.py'),*HERE.joinpath('tasks').rglob('*.py'),HERE/'tasks/manifest.json',HERE/'pricing.json'])
    source_hashes={str(p.relative_to(HERE)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    PROVENANCE={'schema_version':1,'harness_files_sha256':source_hashes,
      'task_manifest_sha256':hashlib.sha256(args.tasks_manifest.read_bytes()).hexdigest(),
      'pricing_sha256':hashlib.sha256(args.pricing_file.read_bytes()).hexdigest(),
      'baseline_revision':revision(CORE_BASE),'candidate_revision':revision(CORE_CANDIDATE),'pi_version':PI_VERSION,
      'node_version':cmd(['node','--version']).stdout.strip(),'python_version':sys.version.split()[0],
      'provider':PROVIDER,'models':models,'tasks':selected,'agents':agents,'phase':args.phase,
      'repeats':args.repeats,'repeat_start':args.repeat_start,'workers':args.workers,'seed':args.seed,'max_calls':MAX_CALLS,
      'spend_cap_usd':args.spend_cap_usd or None,'balance_floor_usd':BALANCE_FLOOR,
      'light_adaptive_effort':ADAPTIVE_EFFORT,'light_adaptive_high':ADAPTIVE_HIGH,
      'reasoning_summary':REASONING_SUMMARY,
      'reasoning_settings_by_agent':{agent:luna_reasoning_settings(agent) for agent in agents},
      'luna_study_call_cap':LUNA_CALL_CAP if PROVIDER=='openai' else None,
      'openai_reasoning_replay':OPENAI_REASONING_REPLAY if PROVIDER=='openai' else None,
      'reasoning_effort':'low' if PROVIDER=='openai' else 'high','output_cap':8192,
      'pricing_verified_on':PRICING['verified_on']}
    PROVENANCE['configuration_sha256']=hashlib.sha256(json.dumps(PROVENANCE,sort_keys=True).encode()).hexdigest()
    return tasks,agents,models


def main():
    global KEY
    args=parser().parse_args()
    # Remove the real key before even metadata/build-validation subprocesses.
    KEY=os.environ.pop('OPENAI_API_KEY','')
    tasks,agents,models=configure(args)
    ROOT.mkdir(parents=True,exist_ok=True)
    with provider_lock(ROOT,PROVIDER):
        write_phase_provenance(ROOT/f'provenance-{args.phase}-{PROVIDER}.json',PROVENANCE)
        if args.validate_only:
            KEY=''
            print(json.dumps({'validation':'pass','provider_calls':0,'configuration_sha256':PROVENANCE['configuration_sha256']}));return
        if not KEY:raise RuntimeError('Missing OpenAI process credential')
        jobs=[(t,a,m,r) for m in models for r in range(args.repeat_start,args.repeat_start+args.repeats) for t in tasks for a in agents]
        random.Random(args.seed).shuffle(jobs)
        try:
            for t,a,m,r in jobs:
                one(t,a,m,r,args.phase,None)
        finally: KEY=''
if __name__=='__main__':main()
