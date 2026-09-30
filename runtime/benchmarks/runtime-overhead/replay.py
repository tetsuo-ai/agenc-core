#!/usr/bin/env python3
"""Zero-delay OpenAI SSE replay. No network upstream and no credentials.
Runs only in a Linux container with a task-owned /work and read-only /evidence.
"""
import argparse, collections, hashlib, http.server, json, os, pathlib, re, shutil, stat, subprocess, threading, time

def confined_path(root, relative):
    """Select a symlink-free child of a trusted benchmark root.

    Resolve only the trusted root. Walk child components relative to directory
    descriptors without following links, so even a rejected selector cannot
    probe an outside symlink target. Internal aliases are intentionally refused
    too. Missing descendants remain supported, as with non-strict resolve.

    This checks a selector, not subsequent execution: the returned pathname can
    still be replaced by a same-UID writer before copy/interpreter use. Fixtures
    and roots must remain trusted; this is not a hostile-filesystem sandbox.
    """
    relative = pathlib.Path(relative)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts:
        raise ValueError('Expected a confined relative path')
    root = pathlib.Path(root).resolve()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent = os.open(root, flags)
    try:
        for index, component in enumerate(relative.parts):
            try:
                info = os.stat(component, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                break
            if stat.S_ISLNK(info.st_mode):
                raise ValueError('Symlinks are not allowed in benchmark selectors')
            if index < len(relative.parts) - 1:
                child = os.open(component, flags, dir_fd=parent)
                os.close(parent)
                parent = child
    finally:
        os.close(parent)
    return root / relative

def repository_cache_path(root, revision):
    """A cache selector is a pinned Git object ID, never a general path.

    Fixtures are trusted local workloads. The no-follow child walk rejects
    stable symlinks; neither this validation nor the walk prevents later renames.
    """
    if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Expected a pinned 40-character lowercase Git object ID')
    return confined_path(root, revision)

def command(args, *, env=None, cwd=None, log=None, timeout=120, stdin_text=None):
    # Only interpreter + absolute script invocations, never interpreter flags
    # or an executable supplied by a task manifest. Script content is trusted
    # benchmark code, confined to the disposable container, not a sandbox here.
    if (not isinstance(args, list) or len(args) < 2 or
            args[0] not in ('python3', 'node') or
            not isinstance(args[1], str) or not pathlib.Path(args[1]).is_absolute()):
        raise ValueError('Expected an approved interpreter and absolute script')
    with open(log or '/dev/null','w') as output:
        return subprocess.run(args,shell=False,input=stdin_text,text=True,env=env,cwd=cwd,stdout=output,stderr=subprocess.STDOUT,timeout=timeout).returncode

def responses(source, repo):
    result=[]
    for f in sorted(source.glob('response-*.txt')):
        calls={}; content=''; reasoning=''
        for line in f.read_text().splitlines():
            if not line.startswith('data: ') or line=='data: [DONE]': continue
            event=json.loads(line[6:])
            for choice in event.get('choices',[]):
                delta=choice.get('delta',{})
                content+=delta.get('content') or ''
                reasoning+=delta.get('reasoning_content') or ''
                for part in delta.get('tool_calls',[]):
                    call=calls.setdefault(part['index'],{'index':part['index'],'id':'','type':'function','function':{'name':'','arguments':''}})
                    if part.get('id'):call['id']=part['id']
                    for key in ('name','arguments'):call['function'][key]+=part.get('function',{}).get(key) or ''
        for call in calls.values():
            args=call['function']['arguments']
            # Recorded benchmark paths only. The container cannot write evidence.
            args=re.sub(r'/work/runs/[^/\\"\s]+/repo',str(repo),args)
            call['function']['arguments']=args
        result.append({'role':'assistant','content':content, 'reasoning_content':reasoning,**({'tool_calls':list(calls.values())} if calls else {})})
    if not result:raise RuntimeError('No recorded responses: '+str(source))
    return result

SESSION_ID = re.compile(r"session_id\s*[=:]\s*(\d+)")

def recorded_yields(source):
    expected={}
    for file in sorted(source.glob('wire-*.json')):
        body=json.loads(file.read_text())['body']
        for message in body.get('messages',[]):
            if message.get('role')!='tool':continue
            match=SESSION_ID.search(str(message.get('content','')))
            if match and message.get('tool_call_id'):
                expected[message['tool_call_id']]=int(match.group(1))
    return expected

def prepare_polled_commands(replies, expected):
    # A zero-delay model removes the original think time, and the same process
    # may otherwise finish before its recorded polling call. Only shorten the
    # yield boundary for commands known to be polled; execute their real work.
    adjusted=[]
    for reply in replies:
        for call in reply.get('tool_calls',[]):
            if call['id'] in expected and call['function']['name']=='exec_command':
                args=json.loads(call['function']['arguments'])
                args['yield_time_ms']=1
                call['function']['arguments']=json.dumps(args)
                adjusted.append(call['id'])
    return adjusted

def map_poll_sessions(body, reply, expected, mapping):
    for message in body.get('messages',[]):
        if message.get('role')!='tool':continue
        old=expected.get(message.get('tool_call_id'))
        match=SESSION_ID.search(str(message.get('content','')))
        if old is not None and match:mapping[old]=int(match.group(1))
    reply=json.loads(json.dumps(reply))
    for call in reply.get('tool_calls',[]):
        if call['function']['name']=='write_stdin':
            args=json.loads(call['function']['arguments']);old=args['session_id']
            if old not in mapping:raise RuntimeError('Recorded poll has no live process handle')
            args['session_id']=mapping[old];call['function']['arguments']=json.dumps(args)
    return reply

class Replay(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args):pass
    def do_GET(self):
        data=b'{"data":[{"id":"deepseek-flash"}]}'
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with self.server.lock:
            n=self.server.calls;self.server.calls+=1
        if n>=len(self.server.replies):
            delta={'role':'assistant','content':'Replay complete.'}
        else:
            try:delta=map_poll_sessions(body,self.server.replies[n],self.server.expected_yields,self.server.session_mapping)
            except RuntimeError:
                self.server.replay_errors.append('unmapped_process_handle');self.send_error(500,'Replay process mapping failed');return
        event={'id':f'replay-{n}','object':'chat.completion.chunk','created':int(time.time()),'model':'deepseek-flash','choices':[{'index':0,'delta':delta,'finish_reason':None}]}
        final={**event,'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if delta.get('tool_calls') else 'stop'}], 'usage':{'prompt_tokens':100,'completion_tokens':10,'total_tokens':110}}
        data=('data: '+json.dumps(event)+'\n\ndata: '+json.dumps(final)+'\n\ndata: [DONE]\n\n').encode()
        boundary={'request_ms':time.time()*1000,'call':n+1}
        self.server.boundaries.append(boundary)
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);self.wfile.flush()
        boundary['response_end_ms']=time.time()*1000

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--native-io');ap.add_argument('--core',required=True);ap.add_argument('--label',required=True);ap.add_argument('--traces',default='/evidence/light-ultra/runs');ap.add_argument('--prefix',default='candidate-round2-new-deepseek-flash');ap.add_argument('--tasks',default='03-window-padding,07-source-manifest,09-separator-payload,12-partition-map');ap.add_argument('--modes',default='cold,warm');ap.add_argument('--repeats',type=int,default=1);ap.add_argument('--repeat-start',type=int,default=1);args=ap.parse_args()
    if args.native_io and args.modes!='warm':raise ValueError('Native I/O diagnostics require --modes warm')
    if any(mode not in ('cold', 'warm', 'daemon') for mode in args.modes.split(',')):
        raise ValueError('Invalid replay mode')
    root=pathlib.Path('/work'); core=confined_path(root,args.core)
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.label):raise ValueError('Invalid run label')
    revision=(core/'.git/HEAD').read_text().strip()
    if not re.fullmatch('[0-9a-f]{40}',revision):raise ValueError('Replay requires a detached, pinned Core checkout')
    harness_digest=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    tasks=json.loads((root/'bench/tasks/manifest.json').read_text());tasks=tasks['tasks'] if isinstance(tasks,dict) else tasks
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Replay);server.lock=threading.Lock();server.boundaries=[];threading.Thread(target=server.serve_forever,daemon=True).start()
    for mode in args.modes.split(','):
      for repeat in range(args.repeat_start-1,args.repeat_start-1+args.repeats):
       for task in tasks:
        if task['id'] not in args.tasks.split(','):continue
        if not re.fullmatch(r'[A-Za-z0-9_-]+', task['id']):raise ValueError('Invalid task ID')
        setup_script=confined_path(root/'bench/tasks',task['setup_script'])
        check_script=confined_path(root/'bench/tasks',task['check_script'])
        dest=root/'replay-runs'/f'{args.label}-{mode}-{task["id"]}-{repeat+1}'
        dest.mkdir(parents=True,exist_ok=False);repo=dest/'repo';home=dest/'home';home.mkdir()
        cache=repository_cache_path('/evidence/light-ultra/repos',task['repo_sha'])
        shutil.copytree(cache,repo,symlinks=True)
        if command(['python3',str(setup_script),str(repo)],log=dest/'setup.log'):raise RuntimeError('setup failed')
        env={k:v for k,v in os.environ.items() if not any(s in k for s in ('KEY','TOKEN','SECRET','AGENC'))}
        env.update(HOME=str(home),AGENC_HOME=str(home/'agenc'),DEEPSEEK_API_KEY='local-replay',DEEPSEEK_BASE_URL=f'http://127.0.0.1:{server.server_port}/v1',AGENC_RUNTIME_TIMING=str(dest/'timing'),CI='1')
        if args.native_io: env['LD_PRELOAD']=args.native_io
        (home/'agenc').mkdir();(home/'agenc/trusted-projects.json').write_text(json.dumps({'version':1,'trustedProjects':[{'path':str(repo),'trustedAt':'2026-09-29T00:00:00Z'}]}))
        source=pathlib.Path(args.traces)/f'{args.prefix}-{task["id"]}-light-r1'
        if task['id']=='12-partition-map' and args.prefix=='candidate-round2-new-deepseek-flash':
            source=pathlib.Path(args.traces)/'candidate-round2-confirm-screen-deepseek-flash-12-partition-map-light-r1'
        trace_digest=hashlib.sha256(b''.join(f.name.encode()+b'\0'+hashlib.sha256(f.read_bytes()).digest() for f in sorted([*source.glob('response-*.txt'),*source.glob('wire-*.json')]))).hexdigest()
        server.replies=responses(source,repo);server.calls=0;server.boundaries=[]
        server.expected_yields=recorded_yields(source);server.session_mapping={};server.replay_errors=[]
        adjusted_yields=prepare_polled_commands(server.replies,server.expected_yields)
        cli=['node',str(core/'runtime/bin/agenc')]
        native_daemon=None
        if mode in ('warm', 'daemon'):
            if args.native_io:
                # Autostart correctly sanitizes loader variables. Start the
                # diagnostic daemon in this process so the preload stays loaded.
                with (dest/'daemon-start.log').open('w') as log:
                    native_daemon=subprocess.Popen(cli+['daemon','start','--foreground'],env=env,cwd=repo,stdout=log,stderr=subprocess.STDOUT)
                deadline=time.monotonic()+45
                while 'daemon websocket listening' not in (dest/'daemon-start.log').read_text():
                    if native_daemon.poll() is not None or time.monotonic()>deadline:raise RuntimeError('native diagnostic daemon failed')
                    time.sleep(.05)
            elif command(cli+['daemon','start'],env=env,cwd=repo,log=dest/'daemon-start.log'):raise RuntimeError('warm daemon failed')
        if mode=='daemon':
            (dest/'client-input.json').write_text(json.dumps({'cwd':str(repo),'prompt':task['prompt']}))
            rc=command(['node',str(core/'runtime/benchmarks/runtime-overhead/daemon-client.mjs'),str(dest/'client-input.json'),str(dest/'client-result.json')],env=env,cwd=repo,log=dest/'agent.log',timeout=240)
            measured=json.loads((dest/'client-result.json').read_text())
            start=measured['start_ms']/1000;end=measured['end_ms']/1000
        else:
            # Prompt text is data, never command-line options (even if it starts
            # with a dash). The CLI's existing stdin prompt path preserves it.
            start=time.time();rc=command(cli+['--provider','deepseek','--model','deepseek-flash','-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox'],stdin_text=task['prompt'],env=env,cwd=repo,log=dest/'agent.log',timeout=240);end=time.time()
        stopstart=time.time()
        if native_daemon is not None:
            native_daemon.terminate()  # Only the diagnostic process created above.
            stoprc=native_daemon.wait(timeout=30)
        else:
            stoprc=command(cli+['daemon','stop'],env=env,cwd=repo,log=dest/'daemon-stop.log',timeout=30)
        stopend=time.time()
        check=command(['python3',str(check_script),str(repo)],log=dest/'check.log')
        result={'label':args.label,'core_revision':revision,'harness_sha256':harness_digest,'trace_sha256':trace_digest,'source_dir':str(source),'adjusted_yield_calls':adjusted_yields,'replay_errors':server.replay_errors,'replay_valid':not server.replay_errors and server.calls==len(server.replies),'mode':mode,'task':task['id'],'repeat':repeat+1,'start_ms':start*1000,'end_ms':end*1000,'wall_ms':(end-start)*1000,'daemon_stop_ms':(stopend-stopstart)*1000,'exit_code':rc,'stop_exit_code':stoprc,'check_exit_code':check,'calls':server.calls,'recorded_calls':len(server.replies),'request_boundaries':server.boundaries,'load':os.getloadavg()}
        if mode=='daemon':
            result['daemon_client']=measured
            result['client_harness_sha256']=hashlib.sha256((core/'runtime/benchmarks/runtime-overhead/daemon-client.ts').read_bytes()).hexdigest()
        (dest/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k!='request_boundaries'}),flush=True)
    server.shutdown()
if __name__=='__main__':main()
