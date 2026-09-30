import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const core='/private/tmp/light-takeover/startup-core';
const adapter=fs.readFileSync(core+'/runtime/src/llm/providers/openai/adapter.ts','utf8');
assert.equal(createHash('sha256').update(adapter).digest('hex'),'50c7818507d88b16abbe8b0e949621aa736ea350485d785bbf68ae4b734505a3');
const require=createRequire(core+'/runtime/package.json');
const ts=require('typescript');
const transpile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
class LLMInvalidResponseError extends Error{constructor(provider,message){super(message);this.provider=provider;}}
const sse=fs.readFileSync(core+'/runtime/src/llm/_deps/sse.ts','utf8');
const parseSSEFrames=new Function('LLMInvalidResponseError',transpile(sse.replace(/^import .*;\n/gm,'').replace(/^export /gm,''))+';return parseSSEFrames;')(LLMInvalidResponseError);
const method=adapter.slice(adapter.indexOf('  private async *readResponsesSseEvents('),adapter.indexOf('  private async *readSseEvents('));
const Probe=new Function('LLMInvalidResponseError','parseSSEFrames',transpile('class Probe { name="openai";\n'+method+'\n}')+';return Probe;')(LLMInvalidResponseError,parseSSEFrames);
const encode=x=>new TextEncoder().encode(x);
const terminal='data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[]}})+'\n\n';
async function collect(chunks){
 let ended=false;
 async function* stream(){for(const value of chunks)yield {value:typeof value==='string'?encode(value):value};ended=true;}
 const events=[];for await(const event of new Probe().readResponsesSseEvents(stream()))events.push(event);
 return {events,ended};
}
test('control: normal CRLF stream, comments and DONE wait for actual EOF',async()=>{
 const r=await collect([terminal.replaceAll('\n','\r\n'),'data: [DONE]\r\n\r\n',': comment\r\n\r\n']);
 assert.equal(r.ended,true);assert.equal(r.events.length,1);
});
test('literal CR inside JSON cannot be silently removed into a valid terminal',async()=>{
 await assert.rejects(collect([terminal.replace('response.completed','respon\rse.completed')]),/malformed|invalid|SSE/i);
});
test('a final terminated comment line is not an unterminated data event',async()=>{
 const r=await collect([terminal,': final keepalive\n']);assert.equal(r.ended,true);assert.equal(r.events.length,1);
});
test('control: an actual unterminated data frame is rejected',async()=>{
 await assert.rejects(collect([terminal,'data: {"type":"error"}']),/unterminated/);
});
test('control: data after DONE and incomplete UTF8 at physical EOF are rejected',async()=>{
 await assert.rejects(collect([terminal,'data: [DONE]\n\n','data: {}\n\n']),/after \[DONE\]/);
 await assert.rejects(collect([terminal,new Uint8Array([0xe2,0x82])]),/encoded|encoding|UTF/i);
});
