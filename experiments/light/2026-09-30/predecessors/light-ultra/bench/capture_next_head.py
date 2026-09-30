"""Linux-only offline first-request capture. No provider or real credential access."""
import json,pathlib,os,subprocess,threading,http.server,sys
assert sys.platform=='linux'
root=pathlib.Path('/work');folder=root/'offline-head-next';folder.mkdir(exist_ok=False)
repo=folder/'repo';repo.mkdir();home=folder/'home';home.mkdir();agenc=home/'agenc';agenc.mkdir()
subprocess.run(['git','init','-q',str(repo)],check=True)
(agenc/'trusted-projects.json').write_text(json.dumps({'version':1,'trustedProjects':[{'path':str(repo),'trustedAt':'2026-09-29T00:00:00Z'}]}))
class Proxy(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  (folder/'request.json').write_text(json.dumps(body,indent=2))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  for item in [dict(choices=[dict(index=0,delta={'role':'assistant','content':'Offline head capture complete.'},finish_reason=None)]),dict(choices=[dict(index=0,delta={},finish_reason='stop')],usage={'prompt_tokens':0,'completion_tokens':0,'total_tokens':0})]:
   self.wfile.write(('data: '+json.dumps(item)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Proxy);threading.Thread(target=server.serve_forever,daemon=True).start()
env={'PATH':os.environ['PATH'],'HOME':str(home),'USER':'benchmark','LOGNAME':'benchmark','AGENC_HOME':str(agenc),'DEEPSEEK_API_KEY':'offline-fixture','DEEPSEEK_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','AGENC_EFFORT_LEVEL':'high','AGENC_MAX_OUTPUT_TOKENS':'8192','CI':'1'}
cli=root/'core-next/runtime/bin/agenc';prompt=json.loads((root/'packaged-next/tasks/manifest.json').read_text())['tasks'][0]['prompt']
with (folder/'agent.log').open('w') as log:
 try:subprocess.run(['node',str(cli),'--provider','deepseek','--model','deepseek-flash','-p','--output-format','json','--dangerously-bypass-approvals-and-sandbox','--light',prompt],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90,check=True)
 finally:subprocess.run(['node',str(cli),'daemon','stop'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=25)
server.shutdown()
body=json.loads((folder/'request.json').read_text());pi=json.loads((root/'runs/baseline-deepseek-flash-01-chunked-strict-pi-r1/wire-001.json').read_text())['body']
def measure(b):
 compact=lambda v:len(json.dumps(v,separators=(',',':'),ensure_ascii=False))
 system=sum(len(m.get('content','')) for m in b['messages'] if m['role']=='system')
 schema=compact(b['tools'])
 return {'system_chars':system,'schema_json_chars':schema,'head_chars':system+schema,'body_chars':compact(b),'message_char_lengths':[[m['role'],len(m.get('content',''))] for m in b['messages']]}
result={'provider_calls':0,'candidate':measure(body),'pi':measure(pi),'pi_provider_first_input_tokens':1616,'candidate_provider_tokens':None}
(folder/'metrics.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
