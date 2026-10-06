import {test,expect,vi} from 'vitest';
import {runToolUse} from '../../src/tools/execution.js';
import {ToolRouter} from '../../src/tools/router.js';
import {EventLog} from '../../src/session/event-log.js';
import {resolveAgentRuntimeOptions} from '../../src/session/runtime-options.js';
const schema={type:'object',properties:{paths:{type:'array',items:{type:'string'}}},required:['paths']};
function fixture(){
 const raw=JSON.stringify({paths:JSON.stringify(['/blocked/review-fixture'])});
 const eventLog=new EventLog();
 const invocation:any={session:{eventLog,services:{admissionRequired:false,runtimeOptions:resolveAgentRuntimeOptions({})}},turn:{subId:'t'},tracker:{appendFileDiff(){},snapshot(){return []},clear(){}},callId:'c',toolName:{name:'Probe'},payload:{kind:'function',arguments:raw},source:'direct'};
 const execute=vi.fn(async()=>({content:'executed'}));
 const tool:any={name:'Probe',description:'review mock, no IO',inputSchema:schema,execute};
 return {raw,invocation,execute,tool};
}

test('round2: permission updatedInput cannot restore a string after next-hook normalization', async () => {
 const {invocation,execute,tool}=fixture();
 const raw=JSON.stringify({paths:[]}); invocation.payload.arguments=raw;
 const seen:any[]=[];
 const result=await runToolUse(raw,{tool,invocation,currentTurnId:'t',permissionContext:{} as any,
  preHooks:[
   async()=>({kind:'continue',hookPermissionResult:{behavior:'allow',updatedInput:{paths:'["/blocked/review-fixture"]'}}}),
   async({args,invocation}:any)=>{seen.push({hook:JSON.parse(invocation.payload.arguments)});return {kind:'continue'};}
  ],
  canUseTool:async(_tool:any,args:any)=>{seen.push({evaluator:JSON.parse(JSON.stringify(args))});return Array.isArray(args.paths)?{behavior:'deny',message:'blocked array'}:{behavior:'allow',updatedInput:args};}
 } as any);
 console.log('round2 permission ordering',JSON.stringify({seen,result,executed:execute.mock.calls}));
 expect(execute).not.toHaveBeenCalled();
 expect(result.isError).toBe(true);
 if(seen.length > 1) expect(seen[1].evaluator).toEqual(seen[0].hook);
});
test('round2: last-hook rewrite reaches legacy approval and post hook', async()=>{
 const {raw,invocation,execute,tool}=fixture();
 const seen:any[]=[];
 const result=await runToolUse(raw,{tool,invocation,currentTurnId:'t',
  preHooks:[async()=>({kind:'rewrite',args:{paths:['/last-rewrite']}})],
  requestApproval:async(ctx:any)=>{seen.push({args:ctx.args,payload:JSON.parse(ctx.invocation.payload.arguments)});return {behavior:'allow',decisionAtTurnId:'t'};},
  postHooks:[async(ctx:any)=>{seen.push({args:ctx.args,payload:JSON.parse(ctx.invocation.payload.arguments)});return {kind:'continue'};}]
 } as any);
 console.log('round2 legacy post',JSON.stringify({seen,result}));
 expect(execute).toHaveBeenCalledOnce();
 expect(seen).toHaveLength(2);
 for(const item of seen){expect(item.payload).toEqual({paths:['/last-rewrite']});expect(item.args).toEqual(item.payload);}
 expect(result.payload).toEqual(invocation.payload);
});
test('round2: failed execution exposes last rewritten MCP payload to failure hook',async()=>{
 const {raw,invocation,tool}=fixture();
 invocation.payload={kind:'mcp',server:'fixture',tool:'Probe',rawArguments:raw};
 tool.execute=vi.fn(async()=>{throw new Error('fixture failure')});
 const seen:any[]=[];
 await runToolUse(raw,{tool,invocation,currentTurnId:'t',preHooks:[async()=>({kind:'rewrite',args:{paths:['/failure-rewrite']}})],failureHooks:[async(ctx:any)=>{seen.push({args:ctx.args,payload:JSON.parse(ctx.invocation.payload.rawArguments)});return {kind:'continue'};}] } as any);
 expect(seen).toEqual([{args:{paths:['/failure-rewrite']},payload:{paths:['/failure-rewrite']}}]);
 expect(invocation.payload.rawArguments).toBe(raw);
});
test('round2: transaction guard sees final rewrite in both docket fields',async()=>{
 const {raw,invocation,tool,execute}=fixture();
 tool.metadata={family:'solana',mutating:true};
 const seen:any[]=[];
 const result=await runToolUse(raw,{tool,invocation,currentTurnId:'t',
  preHooks:[async()=>({kind:'rewrite',args:{paths:['/guard-rewrite']}})],
  transactionGuardContext:{policy:{enabled:true},guard:{evaluate:async(input:any)=>{seen.push(input);return {allowed:true,provider:'fixture',model:'fixture',verdict:'allow',inputHash:'fixture'};}}}
 } as any);
 expect(result.isError).not.toBe(true);
 expect(execute).toHaveBeenCalledOnce();
 expect(seen).toHaveLength(1);
 expect(seen[0].metadata.args).toEqual({paths:['/guard-rewrite']});
 expect(seen[0].userText).toContain('"paths":["/guard-rewrite"]');
});
test('round2: MCP authorization, observer and forwarding see normalized final rewrite',async()=>{
 const {createToolBridge}=await import('../../src/mcp-client/tools.js');
 const {createEmptyToolPermissionContext}=await import('../../src/permissions/types.js');
 const {freshDenialTracking}=await import('../../src/permissions/denial-tracking.js');
 const {raw,invocation}=fixture();
 const seen:any[]=[];
 const callTool=vi.fn(async()=>({content:[{type:'text',text:'fixture'}]}));
 const bridge=await createToolBridge({listTools:async()=>({tools:[{name:'Probe',description:'fixture',inputSchema:schema}]}),callTool,close:async()=>{}} as any,'fixture',undefined,{
  environment:{},callObserver:{onBegin:(input:any)=>seen.push({observer:JSON.parse(input.args)})},
  permissions:{canUseTool:async(_tool:any,args:any)=>{seen.push({permission:JSON.parse(JSON.stringify(args))});return {behavior:'allow',updatedInput:args};},permissionContext:{session:{services:{}},getAppState:()=>({toolPermissionContext:createEmptyToolPermissionContext(),denialTracking:freshDenialTracking(),autoModeActive:false})}}
 } as any);
 invocation.toolName={name:bridge.tools[0].name};
 invocation.payload={kind:'mcp',server:'fixture',tool:'Probe',rawArguments:raw};
 const result=await runToolUse(raw,{tool:bridge.tools[0],invocation,currentTurnId:'t',preHooks:[async()=>({kind:'rewrite',args:{paths:['/mcp-rewrite']}})]} as any);
 console.log('round2 MCP end-to-end',JSON.stringify({seen,result,calls:callTool.mock.calls}));
 expect(result.isError).not.toBe(true);
 expect(seen).toEqual([{permission:{paths:['/mcp-rewrite']}},{observer:{paths:['/mcp-rewrite']}}]);
 expect(callTool.mock.calls[0]?.[0]?.arguments).toEqual({paths:['/mcp-rewrite']});
 expect(invocation.payload.rawArguments).toBe(raw);
});
test('round2: model router must not restore first permission rewrite after later hooks approve different args',async()=>{
 const {invocation,tool,execute}=fixture();
 const raw=JSON.stringify({paths:[]}); invocation.payload.arguments=raw;
 let inspected:any;
 const router=new ToolRouter([{tool,supportsParallelToolCalls:false}]);
 const result=await router.dispatchModelToolCall({id:'c',name:'Probe',arguments:raw},{...invocation,approvalPolicy:'never',sandboxMode:'workspace_write',preHooks:[
  async()=>({kind:'continue',hookPermissionResult:{behavior:'allow',updatedInput:{paths:'["/blocked/review-fixture"]'}}}),
  async()=>({kind:'rewrite',args:{paths:'["/safe/review-fixture"]'}}),
  async({args,invocation}:any)=>{inspected=JSON.parse(invocation.payload.arguments);return inspected.paths.includes('/blocked/review-fixture')?{kind:'deny',reason:'blocked'}:{kind:'continue'};}
 ]} as any);
 console.log('round2 model restore',JSON.stringify({inspected,result,executed:execute.mock.calls}));
 expect(execute).not.toHaveBeenCalled();
 expect(result.isError).toBe(true);
});
test('round2: invalid batch inputs are separate exclusive blocks without predicate calls',async()=>{
 const {partitionToolCalls}=await import('../../src/tools/orchestration.js');
 const {tool}=fixture();
 const predicate=vi.fn(()=>true);
 const blocks:any[]=['[broken','42'].map((paths,i)=>({type:'tool_use',id:String(i),name:'Probe',input:{paths}}));
 const before=JSON.stringify(blocks);
 const batches=partitionToolCalls(blocks,{tools:[{...tool,isConcurrencySafe:predicate}]} as any);
 expect(batches.map(b=>b.isConcurrencySafe)).toEqual([false,false]);
 expect(batches.map(b=>b.blocks.length)).toEqual([1,1]);
 expect(predicate).not.toHaveBeenCalled();
 expect(JSON.stringify(blocks)).toBe(before);
});

test.each(['standalone', 'model', 'direct'] as const)('round2: %s evaluator replacements are strictly validated after model repair', async (entry) => {
 const {raw,invocation,execute,tool}=fixture();
 const warnings:any[]=[];
 invocation.session.eventLog.subscribe((event:any)=>{if(event.msg.type==='warning')warnings.push(event.msg.payload);});
 const canUseTool=vi.fn(async (_tool:any,args:any)=>{
  expect(args.paths).toEqual(['/blocked/review-fixture']);
  return {behavior:'allow',updatedInput:{paths:'["/replacement"]'}};
 });
 const options:any={canUseTool,permissionContext:{},approvalPolicy:'never',sandboxMode:'workspace_write'};
 const router=new ToolRouter([{tool,supportsParallelToolCalls:false}]);
 const result=entry==='standalone'
  ? await runToolUse(raw,{...options,tool,invocation,currentTurnId:'t',eventLog:invocation.session.eventLog})
  : entry==='model'
   ? await router.dispatchModelToolCall({id:'c',name:'Probe',arguments:raw},{...invocation,...options})
   : await router.dispatchToolCall(invocation,JSON.parse(raw),options);
 expect(canUseTool).toHaveBeenCalledOnce();
 expect(result.isError).toBe(true);
 expect(execute).not.toHaveBeenCalled();
 expect(warnings.filter(w=>w.cause==='tool_input_json_coercion')).toHaveLength(1);
 expect(invocation.payload.arguments).toBe(raw);
});

test.each(['rewrite', 'updatedInput'] as const)('round2: hook %s is never repaired, even after successful model repair', async (kind) => {
 const {raw,invocation,execute,tool}=fixture();
 const args={paths:'["/replacement"]'};
 const result=await runToolUse(raw,{tool,invocation,currentTurnId:'t',preHooks:[async()=>kind==='rewrite'
  ? {kind:'rewrite',args}
  : {kind:'continue',hookPermissionResult:{behavior:'allow',updatedInput:args}}] } as any);
 expect(result.isError).toBe(true);
 expect(execute).not.toHaveBeenCalled();
 expect(args.paths).toBe('["/replacement"]');
});

test('round2: approval-modified input is strictly validated',async()=>{
 const {raw,invocation,execute,tool}=fixture();
 const result=await runToolUse(raw,{tool,invocation,currentTurnId:'t',requestApproval:async({args}:any)=>{
  expect(args.paths).toEqual(['/blocked/review-fixture']);
  args.paths='["/approval-replacement"]';
  return {behavior:'allow',decisionAtTurnId:'t'};
 }} as any);
 expect(result.isError).toBe(true);
 expect(execute).not.toHaveBeenCalled();
});

test('round2: dispatched parsedArgs cannot re-enter model repair',async()=>{
 const {raw,invocation,execute,tool}=fixture();
 const result=await runToolUse(raw,{tool,invocation,currentTurnId:'t',parsedArgs:{paths:'["/already-dispatched"]'}});
 expect(result.isError).toBe(true);
 expect(execute).not.toHaveBeenCalled();
});
