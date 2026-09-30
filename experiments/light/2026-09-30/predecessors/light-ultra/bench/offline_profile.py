"""Linux-only synthetic transport/tool profile. No upstream or real credentials."""
import argparse,http.server,json,os,pathlib,subprocess,threading,time,statistics
assert os.uname().sysname=='Linux'
p=argparse.ArgumentParser();p.add_argument('--root',type=pathlib.Path,default=pathlib.Path('/work'));p.add_argument('--label',required=True);p.add_argument('--core',default='core-batch');p.add_argument('--agent',choices=('light','pi'),default='light');p.add_argument('--cpu',action='store_true');p.add_argument('--stream-chunks',type=int,default=0);a=p.parse_args()
d=a.root/'offline-profiles'/a.label;d.mkdir(parents=True,exist_ok=False);repo=d/'repo';repo.mkdir();home=d/'home';home.mkdir();agenc=home/'agenc';agenc.mkdir();pi=home/'pi';pi.mkdir();profiles=d/'profiles';profiles.mkdir();traces=d/'traces';traces.mkdir()
(repo/'fixture.txt').write_text('\n'.join('line '+str(i) for i in range(100))+'\n')
subprocess.run(['git','init','-q',str(repo)],check=True)
(agenc/'trusted-projects.json').write_text(json.dumps({'version':1,'trustedProjects':[{'path':str(repo),'trustedAt':'2026-09-29T00:00:00Z'}]}))
samples=[];ended=[];calls=[]
class Proxy(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"data":[{"id":"deepseek-flash"}]}')
 def do_POST(self):
  n=len(samples);now=time.time();samples.append(now)
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  (d/f'wire-{n+1:03}.json').write_text(json.dumps({'sent_at':now,'body':body}))
  # Fixed alternating read / command work. Identical tool effects, zero model time.
  if n<12:
   read=n%2==0
   name=('read' if read else 'bash') if a.agent=='pi' else ('FileRead' if read else 'exec_command')
   args=({'path':'fixture.txt','offset':n+1,'limit':20} if read else {'command':f'printf step-{n}'}) if a.agent=='pi' else ({'file_path':str(repo/'fixture.txt'),'offset':n+1,'limit':20} if read else {'cmd':f'printf step-{n}'})
   delta={'role':'assistant','tool_calls':[{'index':0,'id':f'offline-{n}','type':'function','function':{'name':name,'arguments':json.dumps(args)}}]};reason='tool_calls'
   calls.append(name)
  else:delta={'role':'assistant','content':'Done.'};reason='stop'
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if a.stream_chunks:
   for index in range(a.stream_chunks):
    chunk={'id':str(n),'object':'chat.completion.chunk','choices':[{'index':0,'delta':{'reasoning_content':'Inspect the observed result. '},'finish_reason':None}]}
    self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode());self.wfile.flush()
  for event in [{'id':str(n),'object':'chat.completion.chunk','choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'id':str(n),'object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':reason}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}]:
   self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush();ended.append(time.time())
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}/v1'
env={'PATH':os.environ['PATH'],'HOME':str(home),'USER':'benchmark','LOGNAME':'benchmark','AGENC_HOME':str(agenc),'PI_CODING_AGENT_DIR':str(pi),'DEEPSEEK_API_KEY':'offline-fixture','DEEPSEEK_BASE_URL':base,'AGENC_EFFORT_LEVEL':'high','AGENC_MAX_OUTPUT_TOKENS':'8192','PI_SKIP_VERSION_CHECK':'1','PI_TELEMETRY':'0','PI_OFFLINE':'1','CI':'1','AGENC_ROLLOUT_TRACE_ROOT':str(traces)}
cli=a.root/a.core/'runtime/bin/agenc';daemon=None
if a.agent=='pi':
 (pi/'models.json').write_text(json.dumps({'providers':{'deepseek':{'baseUrl':base,'api':'openai-completions','apiKey':'DEEPSEEK_API_KEY','models':[{'id':'deepseek-flash','reasoning':True,'contextWindow':1048576,'maxTokens':8192,'compat':{'supportsDeveloperRole':False,'supportsStore':False,'maxTokensField':'max_tokens','thinkingFormat':'deepseek','requiresReasoningContentOnAssistantMessages':True}}]}}}))
 args=[str(a.root/'pi/node_modules/.bin/pi'),'--provider','deepseek','--model','deepseek-flash','--thinking','high','--mode','json','--no-session','-p','Read fixture.txt and run the requested validation.']
else:
 if a.cpu:
  log=(d/'daemon-profile.log').open('w')
  daemon=subprocess.Popen(['node','--cpu-prof','--cpu-prof-dir='+str(profiles),str(cli),'daemon','start','--foreground'],env=env,stdout=log,stderr=subprocess.STDOUT,cwd=repo)
  for _ in range(100):
   if (agenc/'daemon.pid').exists():break
   if daemon.poll() is not None:raise RuntimeError('Profile daemon exited')
   time.sleep(.05)
 args=['node',str(cli),'--provider','deepseek','--model','deepseek-flash','-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox','--light','Read fixture.txt and run the requested validation.']
start=time.time()
with (d/'agent.log').open('w') as log:
 try:
  run=subprocess.run(args,cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90)
  wall=time.time()-start
 finally:
  if a.agent!='pi':subprocess.run(['node',str(cli),'daemon','stop'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=25)
if daemon:
 try:daemon.wait(timeout=10)
 except subprocess.TimeoutExpired:daemon.terminate();daemon.wait(timeout=10)
server.shutdown()
gaps=[samples[i+1]-ended[i] for i in range(min(len(ended),len(samples)-1))]
result={'stream_chunks_per_request':a.stream_chunks,'provider_calls':0,'agent':a.agent,'core':a.core,'scripted_requests':len(samples),'exit_code':run.returncode,'wall':wall,'first_request_delay':samples[0]-start if samples else None,'gaps':gaps,'median_gap':statistics.median(gaps) if gaps else None,'tool_names':calls}
(d/'metrics.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
