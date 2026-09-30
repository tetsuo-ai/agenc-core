"""Scripted local responses verify CLI timing and references without a model service."""
import argparse, hashlib, http.server, json, os, pathlib, re, shlex, subprocess, threading, time
parser=argparse.ArgumentParser()
parser.add_argument('--root',type=pathlib.Path,required=True)
parser.add_argument('--core',required=True)
parser.add_argument('--label',required=True)
parser.add_argument('--wait-ms',type=int,required=True)
parser.add_argument('--catalog',type=int,choices=[0,1],default=0)
parser.add_argument('--retained-check',action='store_true')
args=parser.parse_args()
folder=args.root/'runtime-probes'/args.label
folder.mkdir(parents=True,exist_ok=False)
workspace=folder/'workspace';workspace.mkdir()
home=folder/'home';home.mkdir()
state=home/'agenc';state.mkdir()
(state/'trusted-projects.json').write_text(json.dumps({'version':1,'trustedProjects':[{'path':str(workspace),'trustedAt':'2026-09-29T00:00:00Z'}]}))
arrivals=[];tool_counts=[];catalog_hashes=[];retained_checks=[]
class Scripted(http.server.BaseHTTPRequestHandler):
    def log_message(self,*unused):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tool_counts.append(len(body.get('tools',[])))
        catalog_hashes.append(hashlib.sha256(json.dumps(body.get('tools',[]),separators=(',',':')).encode()).hexdigest())
        arrivals.append(time.time())
        if len(arrivals)==1:
            command={'cmd':'python3 -c "print(123)"','yield_time_ms':args.wait_ms}
            if args.retained_check:
                command={'cmd':'seq 1 3000','yield_time_ms':args.wait_ms,'max_output_tokens':100}
            delta={'tool_calls':[{'index':0,'id':'fixture-call','type':'function','function':{
                'name':'exec_command','arguments':json.dumps(command)}}]}
            finish='tool_calls'
        elif args.retained_check and len(arrivals)==2:
            content='\n'.join(m.get('content','') for m in body['messages'] if m['role']=='tool')
            match=re.search(r'Collected output saved at ("[^"\n]+")',content)
            retained_checks.append(bool(match))
            command='printf missing-reference' if not match else "sed -n '1500p' " + shlex.quote(json.loads(match[1]))
            delta={'tool_calls':[{'index':0,'id':'fixture-read','type':'function','function':{
                'name':'exec_command','arguments':json.dumps({'cmd':command})}}]}
            finish='tool_calls'
        else:
            if args.retained_check:
                content=next((m.get('content','') for m in reversed(body['messages']) if m['role']=='tool'),'')
                retained_checks.append('\n1500\n' in content)
            delta={'content':'Fixture complete.'};finish='stop'
        delta['role']='assistant'
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        for event in [{'choices':[{'index':0,'delta':delta,'finish_reason':None}]},
                      {'choices':[{'index':0,'delta':{},'finish_reason':finish}],
                       'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}]:
            self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Scripted)
threading.Thread(target=server.serve_forever,daemon=True).start()
env={'PATH':os.environ['PATH'],'HOME':str(home),'USER':'benchmark','LOGNAME':'benchmark','AGENC_HOME':str(state),
     'DEEPSEEK_API_KEY':'local-fixture','DEEPSEEK_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','CI':'1',
     'AGENC_LIGHT_FULL_CATALOG':str(args.catalog)}
cli=str(args.root/args.core/'runtime/bin/agenc')
started=time.time()
with (folder/'agent.log').open('w') as log:
    try:
        result=subprocess.run(['node',cli,'--provider','deepseek','--model','deepseek-flash','-p','--output-format','json',
                               '--dangerously-bypass-approvals-and-sandbox','--light','Run the fixture command, then finish.'],
                              env=env,cwd=workspace,stdout=log,stderr=subprocess.STDOUT,timeout=90)
        finished=time.time()
    finally:
        subprocess.run(['node',cli,'daemon','stop'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=25)
        server.shutdown()
metrics={'external_provider_calls':0,'returncode':result.returncode,'requests':len(arrivals),'wait_ms':args.wait_ms,
         'tool_counts':tool_counts,'catalog':args.catalog,'catalog_versions':len(set(catalog_hashes)),
         'wall':finished-started,'startup':arrivals[0]-started if arrivals else None,
         'after_final_request':finished-arrivals[-1] if arrivals else None,
         'request_gaps':[b-a for a,b in zip(arrivals,arrivals[1:])]}
metrics['retained_checks']=retained_checks
(folder/'metrics.json').write_text(json.dumps(metrics,indent=2)+'\n')
print(json.dumps(metrics))
if args.catalog and (not tool_counts or min(tool_counts)<=5 or len(set(catalog_hashes))!=1):
    raise SystemExit('Catalog visibility/stability check failed')
if args.retained_check and retained_checks != [True,True]:
    raise SystemExit('Retained-output retrieval failed')
