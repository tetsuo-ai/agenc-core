import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildToolRegistry } from "../core-converge-cache/runtime/src/tool-registry.js";
import { buildOpenAIResponsesRequest } from "../core-converge-cache/runtime/src/llm/wire/responses-openai.js";
import { buildChatCompletionsRequest } from "../core-converge-cache/runtime/src/llm/wire/chat-completions.js";
import { buildXaiResponsesRequest } from "../core-converge-cache/runtime/src/llm/wire/responses-xai.js";
import { toXaiResponsesTools } from "../core-converge-cache/runtime/src/llm/wire/tools.js";
const registry=buildToolRegistry({workspaceRoot:'/work',lightMode:true,requireAdmission:false});
const initial=registry.toLLMTools();
const search=registry.tools.find(t=>t.name==='system.searchTools');
const result=await search.execute({select:'exec_command'});
const payload=JSON.parse(result.content);
assert(payload.argumentSchemas[0].parameters.properties.yield_time_ms);
assert.deepEqual(registry.toLLMTools(),initial);
const messages=[{role:'system',content:'Fixed instructions.'},{role:'user',content:'Inspect the advanced arguments.'}];
const later=[...messages,{role:'assistant',content:'',toolCalls:[{id:'probe',name:'system.searchTools',arguments:'{"select":"exec_command"}'}]},{role:'tool',toolCallId:'probe',content:result.content}];
const cases=[['Luna',buildOpenAIResponsesRequest,'gpt-6-luna'],['Sol',buildOpenAIResponsesRequest,'gpt-6-sol'],['Flash',buildChatCompletionsRequest,'deepseek-flash'],['Pro',buildChatCompletionsRequest,'deepseek-v4-pro'],['MiniMax',buildChatCompletionsRequest,'MiniMax-M3'],['Grok',(x)=>buildXaiResponsesRequest({...x,tools:toXaiResponsesTools(x.tools)}),'grok-4.7']];
const lcp=(a,b)=>{let n=0;for(;n<Math.min(a.length,b.length)&&a[n]===b[n];n++);return n;};
const summary=[];
for(const [provider,build,model] of cases){
 const a=build({model,messages,tools:initial});
 const b=build({model,messages:later,tools:registry.toLLMTools()});
 assert.deepEqual(a.tools,b.tools);
 assert(JSON.stringify(b).includes('argumentSchemas'));
 summary.push({provider,advanced_schema_prefix_bytes:Buffer.byteLength(JSON.stringify(a.tools)),actual_body_common_prefix_bytes:lcp(Buffer.from(JSON.stringify(a)),Buffer.from(JSON.stringify(b))),advanced_definitions_in_tail:true});
}
await search.execute({select:'TodoWrite'});
assert.deepEqual(registry.toLLMTools().slice(0,initial.length),initial);
console.log(JSON.stringify({provider_calls:0,method:'Actual provider serializers; scripted discovery; network probe separately captured by cache_profile.py',cases:summary},null,2));
