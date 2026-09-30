import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=process.argv[2];
if(!/^\/private\/tmp\/light-darwin-containment-[A-Za-z0-9]+$/.test(root??''))throw new Error('invalid_root');
const denied=code=>code==='EPERM'||code==='EACCES';
async function blockedConnect(options){
  return await new Promise(resolve=>{
    const socket=net.createConnection(options);
    const timer=setTimeout(()=>{socket.destroy();resolve({pass:false,code:'timeout'});},1500);
    socket.once('connect',()=>{clearTimeout(timer);socket.destroy();resolve({pass:false,code:'connected'});});
    socket.once('error',error=>{clearTimeout(timer);socket.destroy();resolve({pass:denied(error.code),code:error.code});});
  });
}
if(process.argv[3]==='descendant'){
  const check=await blockedConnect({host:'127.0.0.1',port:9});
  console.log(JSON.stringify(check));process.exitCode=check.pass?0:1;
}else{
  const facts={};
  facts.ipv4=await blockedConnect({host:'127.0.0.1',port:9});
  facts.ipv6=await blockedConnect({host:'::1',port:9});
  const socketPath=path.join(root,'sockets','allowed.sock');
  const server=net.createServer(socket=>socket.end('ok'));
  facts.unix_allowed=await new Promise(resolve=>{
    const timer=setTimeout(()=>{server.close();resolve({pass:false,code:'timeout'});},1500);
    server.once('error',error=>{clearTimeout(timer);resolve({pass:false,code:error.code});});
    server.listen(socketPath,()=>{
      const client=net.createConnection(socketPath);let data='';
      client.on('data',chunk=>{data+=chunk;});
      client.once('error',error=>{clearTimeout(timer);client.destroy();server.close();resolve({pass:false,code:error.code});});
      client.once('end',()=>{clearTimeout(timer);client.destroy();server.close(()=>resolve({pass:data==='ok'}));});
    });
  });
  facts.unix_outside=await blockedConnect({path:path.join(root,'outside.sock')});
  const ps=spawnSync('/bin/ps',['-o','lstart=','-p',String(process.pid)],{
    cwd:'/',env:{LANG:'C',LC_ALL:'C',PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000,maxBuffer:4096});
  facts.canonical_identity_helper={pass:ps.status===0&&Boolean(ps.stdout?.trim()),status:ps.status,error:ps.error?.code??null};
  const nested=spawnSync('/usr/bin/sandbox-exec',['-p',
    '(version 1) (deny default) (allow process-exec) (allow file-read*)','/usr/bin/true'],{
    env:{PATH:'/usr/bin:/bin',HOME:root},encoding:'utf8',timeout:3000,maxBuffer:4096});
  facts.canonical_sandbox_probe={pass:nested.status===0,status:nested.status,error:nested.error?.code??null,stderr:nested.stderr};
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),root,'descendant'],{
    env:{PATH:'/usr/bin:/bin',HOME:root},encoding:'utf8',timeout:4000,maxBuffer:4096});
  facts.inherited_network_denial={pass:child.status===0,status:child.status,output:child.stdout,error:child.error?.code??null};
  const all=Object.values(facts).every(f=>f.pass);
  fs.writeFileSync(path.join(root,'checks.json'),JSON.stringify(facts,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({all,facts}));process.exitCode=all?0:1;
}
