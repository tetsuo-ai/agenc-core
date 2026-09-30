import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import {once} from 'node:events';
const root=path.resolve('.'), cli=process.env.AGENC_CLI||'/core/runtime/bin/agenc', node=process.execPath;
const mode=process.argv[2]||'baseline', count=Number(process.argv[3]||5);
const out=path.join(root,mode);fs.mkdirSync(out,{recursive:true,mode:0o700});
let active, children=new Set();
const now=()=>performance.timeOrigin+performance.now();
const server=http.createServer(async(req,res)=>{
 const t=now();let raw='';for await(const c of req)raw+=c;
 const body=raw?JSON.parse(raw):{};
 active.requests.push({t,path:req.url,method:req.method,model:body.model,tools:body.tools?.length});
 fs.writeFileSync(path.join(active.dir,'request.json'),JSON.stringify(body,null,2));
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'gpt-6-luna',object:'model',owned_by:'openai'}]}));return;}
 if(req.url!=='/v1/responses'){res.writeHead(404);res.end();return;}
 const part={type:'output_text',text:'OK',annotations:[]};const item={id:'msg_fake',type:'message',role:'assistant',status:'completed',content:[part]};const response={id:'resp_fake',object:'response',status:'in_progress',model:'gpt-6-luna',output:[]};
 const events=[{type:'response.created',response},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{...part,text:''}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'OK'},{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:'OK'},{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:1,total_tokens:11,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}];
 res.writeHead(200,{'Content-Type':'text/event-stream'});for(const [sequence_number,e]of events.entries())res.write('data: '+JSON.stringify({...e,sequence_number})+'\n\n');res.end();active.responded=now();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
function launch(args,env,cwd,file){return new Promise(resolve=>{const fd=fs.openSync(file,'w');const c=cp.spawn(node,[cli,...args],{env,cwd,stdio:['ignore',fd,fd]});children.add(c);const timer=setTimeout(()=>c.kill('SIGKILL'),45000);c.once('exit',(code,signal)=>{clearTimeout(timer);children.delete(c);fs.closeSync(fd);resolve({pid:c.pid,code,signal,end:now()});});});}
const results=[];
try{for(let i=1;i<=count;i++){
 const dir=fs.mkdtempSync(path.join(out,'r'+i+'-'));const home=path.join(dir,'home'),agenc=path.join(home,'agenc'),workspace=path.join(dir,'ws'),tmp=path.join(dir,'tmp');for(const p of [home,agenc,workspace,tmp])fs.mkdirSync(p,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(workspace,'README.md'),'Tiny startup benchmark.\n');cp.execFileSync('git',['init','-q'],{cwd:workspace});
 fs.writeFileSync(path.join(agenc,'trusted-projects.json'),JSON.stringify({version:1,trustedProjects:[{path:workspace,trustedAt:'2026-09-30T00:00:00Z'}]}),{mode:0o600});
 const config=path.join(dir,'config.toml');fs.writeFileSync(config,'config_version = 2\nreasoning_summary = "auto"\n');
 const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:home,USER:'benchmark',LOGNAME:'benchmark',LANG:'C.UTF-8',TMPDIR:tmp,AGENC_HOME:agenc,OPENAI_API_KEY:'dummy-local-only',OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,CI:'1',AGENC_EFFORT_LEVEL:'low',AGENC_MAX_OUTPUT_TOKENS:'8192',NODE_OPTIONS:'--import='+path.join(root,'guard.mjs'),PROFILE_EVENTS:path.join(dir,'events.jsonl'),AGENC_RUNTIME_TIMING:path.join(dir,'timing'),...(mode==='cpu'?{PROFILE_CPU:'1'}:{}),...(mode.startsWith('modules')?{PROFILE_MODULES:'1'}:{})};
 active={dir,requests:[],start:now()};
 const run=await launch(['-p','--light','--provider','openai','--model','gpt-6-luna','--config',config,'--permission-mode','acceptEdits','--output-format','json','--','Reply OK without using any tools.'],env,workspace,path.join(dir,'agent.log'));
 const daemonFile=path.join(agenc,'daemon.pid');let daemonPid;try{daemonPid=Number(fs.readFileSync(daemonFile,'utf8').trim());}catch{}
 const stop=await launch(['daemon','stop'],env,workspace,path.join(dir,'stop.log'));
 // Fall back only to PIDs captured from our preload spawn records, never process discovery.
 const records=fs.readFileSync(env.PROFILE_EVENTS,'utf8').trim().split('\n').map(JSON.parse);const owned=records.filter(e=>e.event==='spawn'&&e.args.includes('--foreground')).map(e=>e.child);
 const alive=[];for(const pid of owned){try{process.kill(pid,0);process.kill(pid,'SIGTERM');alive.push(pid);}catch{}}
 const first=active.requests[0];const result={...active,...run,stop,owned,cleanupFallback:alive,launchToRequestMs:first?first.t-active.start:null,launchToExitMs:run.end-active.start};results.push(result);fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(stop.code!==0)throw Error('cleanup failed');
}}finally{for(const c of children)c.kill('SIGKILL');await new Promise(r=>server.close(r));fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(results,null,2));}
