import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {resolveHomeContext,refreshXaiOauthCredentialsIfNeeded} from './grok_credentials.mjs';
const root='/home/paul/claude-agenc-work/light-models';
const home=resolveHomeContext({AGENC_HOME:'/home/paul/claude-agenc-work/router-bench/grok-home',HOME:'/home/paul'});
const ledger=root+'/evidence/grok-admissions.jsonl';
const secrets=new Set();let busy=false;
function append(row){const fd=fs.openSync(ledger,'a',0o600);try{fs.writeSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function count(){return fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.state==='admitted').length:0;}
function scan(){let files=0,hits=0,errors=0;function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())visit(p);else if(e.isFile()){try{const b=fs.readFileSync(p);files++;for(const s of secrets)if(b.includes(Buffer.from(s)))hits++;}catch{errors++;}}}}visit(root);const out={files,hits,errors,knownBearerObserved:secrets.size>0};fs.writeFileSync(root+'/evidence/grok-secret-scan.json',JSON.stringify(out));return out;}
function fail(res,status,code){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code}}));}
const server=http.createServer(async(req,res)=>{
 if(req.url==='/scan'&&req.method==='GET'){res.end(JSON.stringify(scan()));return;}
 if(busy){fail(res,429,'concurrency_limit');return;}busy=true;
 let ordinal=null;
 try{
  if(!((req.method==='GET'&&req.url==='/v1/models')||(req.method==='POST'&&req.url==='/v1/responses'))){fail(res,404,'route_rejected');return;}
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8*1024*1024)throw Error('body_limit');}
  if(req.method==='POST'){
   const obj=JSON.parse(body);if(obj.model!=='grok-4.7'||obj.reasoning?.effort!=='low') {fail(res,400,'model_or_effort_mismatch');return;}
   if(count()>=800){fail(res,429,'request_cap');return;}
  }
  const credential=await refreshXaiOauthCredentialsIfNeeded(home);
  if(!credential?.accessToken){fail(res,401,'credential_unavailable');return;}
  const secret=credential.accessToken;secrets.add(secret);
  if(req.method==='POST'){ordinal=count()+1;append({ordinal,state:'admitted',time:Date.now()/1000,model:'grok-4.7'});}
  const upstream=await fetch('https://api.x.ai'+req.url,{method:req.method,headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:req.method==='POST'?body:undefined,redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!upstream.ok){await upstream.arrayBuffer();fail(res,upstream.status,'provider_http_'+upstream.status);append({ordinal,state:'ended',status:upstream.status,time:Date.now()/1000});return;}
  if(req.method==='GET'){
    const obj=await upstream.json();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:(obj.data??[]).map(x=>({id:x.id}))}));return;
  }
  res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')??'text/event-stream','Connection':'close'});
  let pending=Buffer.alloc(0),bytes=0;const needle=Buffer.from(secret);
  for await(const chunk of upstream.body){
   bytes+=chunk.length;if(bytes>512*1024)throw Error('response_byte_limit');
   pending=Buffer.concat([pending,Buffer.from(chunk)]);
   let at;while((at=pending.indexOf(needle))!==-1)pending=Buffer.concat([pending.subarray(0,at),Buffer.from('[REDACTED]'),pending.subarray(at+needle.length)]);
   const n=Math.max(0,pending.length-needle.length+1);if(n){res.write(pending.subarray(0,n));pending=pending.subarray(n);}
  }
  res.end(pending);append({ordinal,state:'ended',status:200,time:Date.now()/1000});
 }catch(e){if(!res.headersSent)fail(res,502,e.name==='TimeoutError'?'request_timeout':'bridge_failure');else res.destroy();if(ordinal)append({ordinal,state:'error',type:e.name,time:Date.now()/1000});}
 finally{busy=false;}
});
server.listen(8816,'127.0.0.1',()=>console.log(JSON.stringify({bridge:'grok',port:8816,pid:process.pid,cap:800})));
process.on('SIGTERM',()=>{server.close();scan();process.exit(0);});
