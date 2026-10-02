#!/usr/bin/env python3
"""Linux-only matched-agent benchmark. Credentials only enter through environment.
Wire capture excludes headers and uses a dummy client bearer. Do not run on Mac.
"""
import argparse, concurrent.futures, datetime, hashlib, http.server, json, os, pathlib, random, shutil, signal, subprocess, sys, threading, time, urllib.request, urllib.error
from trace_checks import planning_evidence
ROOT=pathlib.Path('/work')
KEY=os.environ.pop('DEEPSEEK_API_KEY')
LOCK=threading.Lock()
UPSTREAM=threading.BoundedSemaphore(2)
ACTIVE={}
LEDGER=ROOT/'spend.jsonl'
HARNESS_DIGEST=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()

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
    peak=d.weekday()<5 and (1<=d.hour<4 or 6<=d.hour<10)
    base=(.022,.66,1.98) if model=='deepseek-v4-pro' else (.003,.15,.6)
    return [v*(2 if peak else 1) for v in base]

class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'id':m} for m in ['deepseek-flash','deepseek-v4-pro']]}).encode())
    def do_POST(self):
        with UPSTREAM:
            self.forward()
    def forward(self):
        rid=self.path.split('/')[1]
        if rid not in ACTIVE: self.send_error(404);return
        state=ACTIVE[rid]
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        stamp=time.time()
        with LOCK:
            used=spend()
            # Reserve peak-price worst-case completion + prompt per outstanding call.
            reserve=(body.get('max_tokens',body.get('max_completion_tokens',8192))*3.96+len(json.dumps(body))*1.32)/1e6
            reserved=sum(sum(s.get('reserved',{}).values()) for s in ACTIVE.values())
            if used+reserved+reserve>=10:
                self.send_error(429,'Benchmark spend cap');state['budget_stop']=True;return
            if state['calls']>=45:
                self.send_error(429,'Benchmark call limit');state['budget_stop']=True;return
            state['calls']+=1; n=state['calls']
            state.setdefault('reserved',{})[n]=reserve
        dest=state['dir']/f'wire-{n:03}.json'
        write_json(dest,{'sent_at':stamp,'body':body})
        req=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+KEY,'Content-Type':'application/json'})
        usage={}; toolids=set();error=None
        try:
            with urllib.request.urlopen(req,timeout=180) as res:
                self.send_response(res.status);self.send_header('Content-Type',res.headers.get('Content-Type','text/event-stream'));self.end_headers()
                chunks=[]
                for line in res:
                    chunks.append(line)
                    try:self.wfile.write(line);self.wfile.flush()
                    except BrokenPipeError:pass
                    if line.startswith(b'data: '):
                        try:
                            event=json.loads(line[6:])
                            if event.get('usage'):usage=event['usage']
                            for c in event.get('choices',[]):
                                for t in c.get('delta',{}).get('tool_calls',[]): toolids.add(t.get('index',t.get('id')))
                        except (ValueError,TypeError):pass
                raw=b''.join(chunks)
                if not body.get('stream'):
                    event=json.loads(raw);usage=event.get('usage',{})
                    for c in event.get('choices',[]):
                        for t in c.get('message',{}).get('tool_calls',[]):toolids.add(t.get('id'))
                (state['dir']/f'response-{n:03}.txt').write_bytes(raw)
        except urllib.error.HTTPError as e:
            error={'status':e.code,'body':e.read().decode()}
            try:self.send_error(e.code)
            except OSError:pass
        except Exception as e:
            error={'type':type(e).__name__}
            try:self.send_error(502)
            except OSError:pass
        hit=usage.get('prompt_cache_hit_tokens',usage.get('prompt_tokens_details',{}).get('cached_tokens',0))
        inp=usage.get('prompt_tokens',0);out=usage.get('completion_tokens',0)
        miss=usage.get('prompt_cache_miss_tokens',inp-hit)
        price=rates(body['model'],stamp)
        cost=(hit*price[0]+miss*price[1]+out*price[2])/1e6
        record={'run':rid,'call':n,'model':body['model'],'input_tokens':inp,'cached_tokens':hit,'uncached_tokens':miss,'output_tokens':out,'tool_calls':len(toolids),'cost_usd':cost,'rates':price,'time':stamp,'seconds':time.time()-stamp,'error':error,'usage':usage,'budget_charge_usd':cost if usage or (error and 400<=error.get('status',0)<500) else reserve,'usage_missing':not bool(usage) and not (error and 400<=error.get('status',0)<500)}
        with LOCK:
            with LEDGER.open('a') as f:f.write(json.dumps(record)+'\n')
            state['records'].append(record);state['reserved'].pop(n,None)
        write_json(state['dir']/f'usage-{n:03}.json',record)


def cmd(args,cwd=None,env=None,timeout=180,output=None):
    return subprocess.run(args,cwd=cwd,env=env,timeout=timeout,stdout=output or subprocess.PIPE,stderr=subprocess.STDOUT,text=True)

def one(task,agent,model,repeat,phase,port):
    rid=f'{phase}-{model}-{task["id"]}-{agent}-r{repeat}'
    d=ROOT/'runs'/rid
    if (d/'result.json').exists():return json.loads((d/'result.json').read_text())
    with LOCK:
        b=balance();print(json.dumps(b),flush=True)
        if not b['is_available'] or float(b['total_balance'])<10 or spend()>9.5:
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
    if repo.exists():shutil.rmtree(repo)
    cmd(['git','clone','-q','--no-hardlinks',str(cache),str(repo)])
    setup=cmd(['python3',str(ROOT/'bench/tasks'/task['setup_script']),str(repo)],timeout=120)
    (d/'setup.log').write_text(setup.stdout)
    if setup.returncode:raise RuntimeError('Task setup failed '+rid)
    state={'dir':d,'calls':0,'records':[]};ACTIVE[rid]=state
    base=f'http://127.0.0.1:{port}/{rid}/v1'
    env={k:v for k,v in os.environ.items() if not any(s in k for s in ['KEY','TOKEN','SECRET'])}
    env.update(HOME=str(home),USER='benchmark',LOGNAME='benchmark',AGENC_HOME=str(home/'agenc'),PI_CODING_AGENT_DIR=str(home/'pi'),DEEPSEEK_API_KEY='benchmark-proxy',DEEPSEEK_BASE_URL=base,AGENC_EFFORT_LEVEL='high',AGENC_MAX_OUTPUT_TOKENS='8192',PI_SKIP_VERSION_CHECK='1',PI_TELEMETRY='0',PI_OFFLINE='1',CI='1')
    core=ROOT/('core-candidate' if phase.startswith('candidate') and agent=='light' else 'core-base')
    if agent!='pi':
        # The owner authorized these task-owned repositories for benchmark edits.
        write_json(home/'agenc/trusted-projects.json',{'version':1,'trustedProjects':[{'path':str(repo),'trustedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}]})
        (home/'agenc/trusted-projects.json').chmod(0o600)
    if agent=='pi':
        write_json(home/'pi/models.json',{'providers':{'deepseek':{'baseUrl':base,'api':'openai-completions','apiKey':'DEEPSEEK_API_KEY','models':[{'id':model,'reasoning':True,'contextWindow':1048576,'maxTokens':8192,'compat':{'supportsDeveloperRole':False,'supportsStore':False,'maxTokensField':'max_tokens','thinkingFormat':'deepseek','requiresReasoningContentOnAssistantMessages':True}}]}}})
        args=[str(ROOT/'pi/node_modules/.bin/pi'),'--provider','deepseek','--model',model,'--thinking','high','--mode','json','--no-session','-p',task['prompt']]
    else:
        args=['node',str(core/'runtime/bin/agenc'),'--provider','deepseek','--model',model,'-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox']
        if agent=='light':args+=['--light']
        args+=[task['prompt']]
    load_start=os.getloadavg()
    revision=cmd(['git','rev-parse','HEAD'],cwd=core).stdout.strip() if agent!='pi' else '0.73.1'
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
    check=cmd(['python3',str(ROOT/'bench/tasks'/task['check_script']),str(repo)],timeout=120)
    (d/'check.log').write_text(check.stdout)
    drain_deadline=time.monotonic()+210
    while state.get('reserved') and time.monotonic()<drain_deadline:
        time.sleep(.25)
    records=state['records']
    result={'id':rid,'harness_sha256':HARNESS_DIGEST,'agent_revision':revision,'prompt_sha256':hashlib.sha256(task['prompt'].encode()).hexdigest(),'load_start':load_start,'load_end':os.getloadavg(),'phase':phase,'task':task['id'],'agent':agent,'model':model,'repeat':repeat,'pass':check.returncode==0 and rc==0,'check_pass':check.returncode==0,'exit_code':rc,'timeout':timeout,'wall_seconds':wall,'model_calls':len(records),'provider_errors':sum(bool(r['error']) for r in records),'usage_complete':not bool(state.get('reserved')) and len(records)==state['calls'] and all(not r['usage_missing'] for r in records),'first_system_chars':0,'first_schema_chars':0}
    for k in ['input_tokens','cached_tokens','uncached_tokens','output_tokens','tool_calls','cost_usd','budget_charge_usd']:result[k]=sum(r[k] for r in records)
    if (d/'wire-001.json').exists():
        body=json.loads((d/'wire-001.json').read_text())['body']
        result['first_system_chars']=sum(len(json.dumps(m['content'])) for m in body['messages'] if m['role'] in ['system','developer'])
        result['first_schema_chars']=len(json.dumps(body.get('tools',[])))
        result['sampling']={k:body.get(k) for k in ['model','thinking','reasoning_effort','max_tokens','max_completion_tokens','temperature','top_p']}
        result['initial_tools']=[t['function']['name'] for t in body.get('tools',[])]
    if task.get('deferred_capability'):
        result['deferred_evidence']=planning_evidence(d,agent)
        result['coding_pass']=result['pass']
        if agent!='pi':result['pass'] = result['pass'] and result['deferred_evidence']['pass']
    write_json(d/'result.json',result)
    print(json.dumps(result),flush=True)
    return result

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--phase',default='baseline');ap.add_argument('--models',default='deepseek-flash');ap.add_argument('--agents',default='pi,normal,light');ap.add_argument('--tasks',default='');ap.add_argument('--repeats',type=int,default=2);ap.add_argument('--workers',type=int,default=2);args=ap.parse_args()
    if sys.platform!='linux':raise RuntimeError('Benchmarks must run on Linux')
    if args.workers>2:raise RuntimeError('Maximum concurrency is two')
    tasks=json.loads((ROOT/'bench/tasks/manifest.json').read_text())
    if isinstance(tasks,dict):tasks=tasks['tasks']
    if args.tasks:tasks=[t for t in tasks if t['id'] in args.tasks.split(',')]
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);threading.Thread(target=server.serve_forever,daemon=True).start()
    jobs=[(t,a,m,r) for m in args.models.split(',') for r in range(1,args.repeats+1) for t in tasks for a in args.agents.split(',')]
    random.Random(29092026).shuffle(jobs)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures=[pool.submit(one,t,a,m,r,args.phase,server.server_port) for t,a,m,r in jobs]
        for f in concurrent.futures.as_completed(futures):f.result()
    server.shutdown()
if __name__=='__main__':main()
