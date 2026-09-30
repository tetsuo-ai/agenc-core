// Invoked only by parent_fixture.mjs with isolated temp paths and fake fetch.
import fs from 'node:fs';
import path from 'node:path';
const dir=process.env.LUNA_RUN_DIR,fault=process.env.SYNTHETIC_FAULT;
let calls=0;
const plan='- [ ] Implement the change\n- [ ] Run validation\n';
const part={type:'output_text',text:plan};
const item={type:'message',id:'m',role:'assistant',content:[part]};
const common={item_id:'m',output_index:0,content_index:0};
const events=[
  {type:'response.created',response:{id:'r',status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,content:[]}},
  {type:'response.content_part.added',...common,part:{type:'output_text',text:''}},
  {type:'response.output_text.delta',...common,delta:plan},
  {type:'response.output_text.done',...common,text:plan},
  {type:'response.content_part.done',...common,part},
  {type:'response.output_item.done',output_index:0,item},
  {type:'response.completed',response:{id:'r',status:'completed',output:[item],
    usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:0}}}},
];
if(fault==='upstream-error')events.splice(1,0,{type:'error',message:'synthetic upstream failure'});
const bytes=Buffer.from(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
globalThis.fetch=async()=>{calls++;return new Response(bytes,{headers:{'content-type':'text/event-stream'}});};
const open=fs.openSync,close=fs.closeSync,write=fs.writeSync,sync=fs.fsyncSync,link=fs.linkSync,unlink=fs.unlinkSync;
const names=new Map();let published=false;
fs.openSync=(name,...args)=>{
  if(fault==='legacy-open'&&String(name).endsWith('/response-001.txt'))throw new Error('legacy open fault');
  const fd=open(name,...args);names.set(fd,String(name));return fd;
};
fs.closeSync=fd=>{
  if(fault==='legacy-close'&&names.get(fd)?.endsWith('/response-001.txt'))throw new Error('legacy close fault');
  names.delete(fd);return close(fd);
};
fs.writeSync=(fd,data,...args)=>{
  if(fault==='settlement-append'&&names.get(fd)?.endsWith('luna-api-ledger.jsonl')&&String(data).includes('"event":"settle"'))throw new Error('settlement append fault');
  return write(fd,data,...args);
};
fs.linkSync=(...args)=>{
  if(fault==='crash-before-link')process.exit(91);
  const result=link(...args);published=true;
  if(fault==='crash-after-link')process.exit(92);
  return result;
};
fs.fsyncSync=fd=>{
  if(fault==='double-fault'&&published&&fs.fstatSync(fd).isDirectory())throw new Error('publication sync fault');
  return sync(fd);
};
fs.unlinkSync=(...args)=>{
  if(fault==='double-fault')throw new Error('publication withdrawal fault');return unlink(...args);
};
const send=process.send.bind(process);
process.send=(message,callback)=>{
  if(fault==='crash-before-ack')process.exit(93);
  if(fault==='forged-channel')message={...message,channel_id:'not-the-parent-channel'};
  if(fault==='wrong-hash')message={...message,receipt_sha256:'a'.repeat(64)};
  if(fault==='duplicate-ack')send(message);
  return send(message,error=>{
    if(fault==='crash-after-ack')process.exit(94);
    callback?.(error);
  });
};
try {
  await import('./direct.mjs');
  const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',body:JSON.stringify({
    model:'gpt-6-luna',stream:true,max_output_tokens:8192,reasoning:{effort:'low'},
    input:[{role:'user',content:'Synthetic task.'}]})});
  await response.text();
  // Let IPC callbacks finish before clean close; no sleeps/timing benchmark.
  await new Promise(resolve=>setImmediate(resolve));
}catch{process.exitCode=2;}
fs.writeFileSync(path.join(dir,'fixture-send-count.json'),JSON.stringify({calls}));
if(process.connected)process.disconnect();

