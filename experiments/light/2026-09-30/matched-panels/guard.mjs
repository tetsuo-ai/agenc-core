import fs from 'node:fs';
import net from 'node:net';
import cp from 'node:child_process';
import {syncBuiltinESMExports,registerHooks} from 'node:module';
import inspector from 'node:inspector';
const file=process.env.PROFILE_EVENTS;
const mark=(event,extra={})=>fs.appendFileSync(file,JSON.stringify({event,pid:process.pid,t:performance.timeOrigin+performance.now(),...extra})+'\n');
mark('preload',{argv:process.argv});
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let a=args[0]; if(Array.isArray(a)) a=a[0];
 const host=typeof a==='object'?a.host:(typeof args[1]==='string'?args[1]:undefined);
 const unix=typeof a==='object'?a.path:typeof a==='string'&&!/^\d+$/.test(a);
 if(!unix && host && !['127.0.0.1','localhost','::1'].includes(host)) {mark('blocked_network',{host});throw Error('loopback-only guard: '+host);}
 return connect.apply(this,args);
};
const origFetch=globalThis.fetch;
globalThis.fetch=function(input,...args){let u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname)){mark('blocked_fetch',{url:u.origin});throw Error('loopback-only guard: '+u.origin);}mark('fetch',{url:u.pathname});return origFetch.call(this,input,...args);};
for(const name of ['spawn','spawnSync','execFile','execFileSync']){const orig=cp[name];cp[name]=function(...args){const t=performance.timeOrigin+performance.now();const result=orig.apply(this,args);mark(name,{command:args[0],args:Array.isArray(args[1])?args[1]:[],child:result?.pid,start:t});return result;};for(const symbol of Object.getOwnPropertySymbols(orig))Object.defineProperty(cp[name],symbol,Object.getOwnPropertyDescriptor(orig,symbol));}
syncBuiltinESMExports();
let session;
if(process.env.PROFILE_CPU==='1'){session=new inspector.Session();session.connect();session.post('Profiler.enable');session.post('Profiler.setSamplingInterval',{interval:1000});session.post('Profiler.start');}
process.once('exit',()=>{mark('exit');if(session){session.post('Profiler.stop',(e,r)=>{if(!e)fs.writeFileSync(file+'.'+process.pid+'.cpuprofile',JSON.stringify(r.profile));});session.disconnect();}});

if(process.env.PROFILE_MODULES==='1') {
 const loads=[];globalThis.__profileMark=mark;
 registerHooks({load(url,context,next){const result=next(url,context);loads.push({url,t:performance.timeOrigin+performance.now()});if(url.endsWith('/bin/agenc-main.js')||(/\/daemon-cli-[^/]+\.js$/.test(url)))return {...result,source:'globalThis.__profileMark("module_evaluated",{url:'+JSON.stringify(url)+'});\n'+result.source};return result;}});
 process.on('exit',()=>fs.writeFileSync(file+'.'+process.pid+'.modules.json',JSON.stringify(loads)));
}
