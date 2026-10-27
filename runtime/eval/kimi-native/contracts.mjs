/** Small API contract probes, separate from the CLI task matrix. Uses wire.mjs's owner ledger. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const evidence = process.argv[2];
const split = process.argv[3] === '--split';
if (!evidence || !process.env.KIMI_SWEEP_CONTROL) throw new Error('Evidence and guarded wire preload are required');
const control = { run: split ? 'documented-split-schema-tools-contract' : 'documented-schema-tools-contract', wire: join(evidence, 'wire.jsonl'), ledger: join(evidence, 'ledger.json') };
if (JSON.parse(readFileSync(control.ledger)).pending) throw new Error('Existing request must settle first');
writeFileSync(process.env.KIMI_SWEEP_CONTROL, JSON.stringify(control));
const models = ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'];
const tools = [{ type:'function', function:{name:'echo', description:'Echo the supplied value.', parameters:{type:'object', properties:{value:{type:'string'}}, required:['value'], additionalProperties:false}} }];
const response_format = {type:'json_schema',json_schema:{name:'answer',strict:true,schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}}};
const results = [];
for (const model of models) {
  const messages = [{role:'user',content:'Call echo with value test. After receiving its result, return an object with ok true.'}];
  const result = {model, statuses:[], solve:false};
  for (let turn=0; turn<2; turn++) {
    const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method:'POST', headers:{Authorization:'Bearer '+process.env.MOONSHOT_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({model,messages,...(split ? (turn===0 ? {tools} : {response_format}) : {tools,response_format}),max_completion_tokens:4096,
        ...(model.startsWith('kimi-k3') ? {reasoning_effort:'low'} : model==='kimi-k2.6' ? {thinking:{type:'enabled',keep:'all'}} : {})}),
    });
    const data = await response.json();
    // Capture drains the cloned response and commits usage before another call.
    for (let n=0; n<120 && JSON.parse(readFileSync(control.ledger)).pending; n++) await new Promise(r=>setTimeout(r,250));
    if (JSON.parse(readFileSync(control.ledger)).pending) throw new Error('Probe accounting did not settle');
    result.statuses.push(response.status);
    if (!response.ok) {
      result.error = {type:data.error?.type, message:String(data.error?.message ?? '').replaceAll(process.env.MOONSHOT_API_KEY,'[redacted]').replace(/org-[a-z0-9]+|<ak-[^>]+>/gi,'[account]')};
      break;
    }
    const choice = data.choices?.[0];
    if (turn===0) {
      if (choice?.finish_reason!=='tool_calls' || choice.message.tool_calls?.length!==1 || choice.message.tool_calls[0].function?.name!=='echo') {
        result.error = {type:'unexpected-tool-contract'};break;
      }
      messages.push(choice.message, {role:'tool',tool_call_id:choice.message.tool_calls[0].id,content:'test'});
      if (split) messages.push({role:'user',content:'Tool work is complete. Return only a raw JSON object matching the supplied schema.'});
    } else {
      try { result.solve = choice?.finish_reason==='stop' && JSON.parse(choice.message.content).ok===true; }
      catch { result.error = {type:'invalid-schema-content'}; }
    }
  }
  results.push(result);
  writeFileSync(join(evidence,split ? 'split-schema-tools-contract.json' : 'schema-tools-contract.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(result));
}
