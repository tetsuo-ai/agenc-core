// Offline only: install fake transport before the observer. No inherited key.
import fs from 'node:fs';
import path from 'node:path';
const root=process.env.LUNA_RUN_DIR;
const spec=JSON.parse(fs.readFileSync(path.join(root,'requests.json')));
let calls=0; const forwarded=[],errors=[];
globalThis.fetch=async(input,init)=>{
  calls++; forwarded.push(JSON.parse(Buffer.from(init.body).toString()));
  const event={type:'response.completed',response:{usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:0}}}};
  return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}});
};
await import('./direct.mjs');
for(const body of spec.bodies){
  try {
    const init={method:'POST',body:typeof body==='string'?body:JSON.stringify(body)};
    const pending=fetch('https://api.openai.com/v1/responses',init);
    if(spec.mutateCaller)init.body='{}';
    await (await pending).text(); errors.push(null);
  } catch(error){errors.push(error.message);}
}
await new Promise(resolve=>setImmediate(resolve));
fs.writeFileSync(path.join(root,'outcome.json'),JSON.stringify({calls,forwarded,errors}),{flag:'wx',mode:0o600});
if(process.connected)process.disconnect();
