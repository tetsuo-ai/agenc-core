import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {FAIR,selection,sha,need,canonical,verifySelection,TASK,NAMES,pick,sealInputs} from './fixture.mjs';

const root=process.env.HOME;
let stage='selection',session,unsubscribe,disposed=false,denied=0,calls=0,cancels=0,eof=false,terminalEvents=0,bridgeCalls=0;
let abortPromise,primary,failed=false;
const write=(name,value)=>fs.writeFileSync(path.join(root,name),value,{flag:'wx',mode:0o600});
const deny=()=>{denied++;throw new Error('external_operation_refused');};
// All package side effects are behind these tripwires. No arbitrary subprocess.
const nativeSpawnSync=cp.spawnSync;
globalThis.fetch=deny;
http.request=http.get=https.request=https.get=deny;
net.connect=net.createConnection=net.Socket.prototype.connect=tls.connect=deny;
dgram.createSocket=deny;
for(const key of ['spawn','exec','execSync','execFile','execFileSync','fork'])cp[key]=deny;
cp.spawnSync=(file,args,opts)=>{
  const candidates=[['shared-luna-binding-v1/bridge.py',2000,16384],['luna-policy-v2/policy_bridge.py',5000,4096]];
  const matched=candidates.find(([name,timeout,maxBuffer])=>{
    const full=path.join(FAIR,name),raw=fs.readFileSync(full);
    const code=`__file__ = ${JSON.stringify(full)}\n`+raw.toString('utf8');
    const binding=name.startsWith('shared-');
    const keys=binding?['input','env','cwd','timeout','killSignal','maxBuffer']:['input','encoding','timeout','maxBuffer','env'];
    return sha(raw)===selection.dependencies[name]&&file===selection.python&&
      JSON.stringify(args)===JSON.stringify(['-I','-S','-B','-c',code])&&
      JSON.stringify(Object.keys(opts??{}).sort())===JSON.stringify(keys.sort())&&
      (binding?opts.cwd===path.join(FAIR,'luna-observer-v6')&&opts.killSignal==='SIGKILL':opts.encoding==='utf8')&&
      opts?.timeout===timeout&&opts?.maxBuffer===maxBuffer&&
      JSON.stringify(opts.env)===JSON.stringify({LANG:'C.UTF-8'})&&
      Buffer.byteLength(opts.input??'')<=2*1024*1024;
  });
  if(!matched)return deny();bridgeCalls++;
  return nativeSpawnSync(file,args,opts);
};
syncBuiltinESMExports();
const ActualDate=Date;
globalThis.Date=class extends ActualDate{
  constructor(...args){super(...(args.length?args:['2026-09-30T12:00:00.000Z']));}
  static now(){return ActualDate.parse('2026-09-30T12:00:00.000Z');}
};
const load=name=>import(pathToFileURL(path.join(selection.install,'node_modules/@mariozechner/pi-coding-agent/dist/core',name)).href);
const spec=JSON.parse(fs.readFileSync(path.join(root,'case.json')));
let sealed,finalMessage;
try{
  verifySelection();need(process.env.TZ==='UTC','timezone_mismatch');
  stage='canonical_imports';
  const {createCodingToolDefinitions}=await load('tools/index.js');
  const {buildSystemPrompt}=await load('system-prompt.js');
  const {createExtensionRuntime}=await load('extensions/loader.js');
  const {AuthStorage}=await load('auth-storage.js');
  const {ModelRegistry}=await load('model-registry.js');
  const {SettingsManager}=await load('settings-manager.js');
  const {SessionManager}=await load('session-manager.js');
  const {createAgentSession}=await load('sdk.js');
  stage='independent_seal';
  const manager=SessionManager.inMemory(root),sessionId=manager.getSessionId();
  const tools=createCodingToolDefinitions(root,{read:{autoResizeImages:false},bash:{shellPath:'/bin/sh'}});
  const system=buildSystemPrompt({cwd:root,selectedTools:NAMES,
    toolSnippets:Object.fromEntries(tools.map(t=>[t.name,t.promptSnippet.trim()])),
    promptGuidelines:tools.flatMap(t=>t.promptGuidelines??[]),contextFiles:[],skills:[]});
  sealed=sealInputs({system,tools,sessionId,root,mode:spec.mode,channel:spec.channel});
  write('contract.json',sealed.contractRaw);write('policy.json',sealed.policyRaw);
  write('seal.json',JSON.stringify({system:sealed.systemHash,tools:sealed.toolsHash,contract:sha(sealed.contractRaw),
    expectedBody:sha(canonical(sealed.expectedBody)),configuration:sealed.expected.configuration_sha256,stage:'before_live_session'}));
  stage='live_session';
  const runtime=createExtensionRuntime();
  const resources={getExtensions:()=>({extensions:[],errors:[],runtime}),getSkills:()=>({skills:[],diagnostics:[]}),
    getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),
    getSystemPrompt:()=>undefined,getAppendSystemPrompt:()=>[],extendResources:deny,reload:deny};
  const auth=AuthStorage.inMemory();auth.setRuntimeApiKey('openai','synthetic-not-a-real-key');
  const settings=SettingsManager.inMemory({images:{autoResize:false},shellPath:'/bin/sh',compaction:{enabled:false},retry:{enabled:false,provider:{maxRetries:0}}});
  const model={id:'gpt-6-luna',name:'Synthetic Luna fixture',api:'openai-responses',provider:'openai',baseUrl:'https://api.openai.com/v1',
    reasoning:true,input:['text'],contextWindow:1050000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  fs.mkdirSync(path.join(root,'agent'));
  ({session}=await createAgentSession({cwd:root,agentDir:path.join(root,'agent'),authStorage:auth,modelRegistry:ModelRegistry.inMemory(auth),
    settingsManager:settings,sessionManager:manager,resourceLoader:resources,model,thinkingLevel:'low',tools:NAMES}));
  need(sha(session.systemPrompt)===sealed.systemHash&&sha(canonical(NAMES.map(n=>pick(session.getToolDefinition(n)))))===sealed.toolsHash,'prepared_state_mismatch');
  need(JSON.stringify(session.getActiveToolNames())===JSON.stringify(NAMES)&&session.messages.length===0&&manager.buildSessionContext().messages.length===0,'nonempty_initial_state');
  need(runtime.pendingProviderRegistrations.length===0&&!settings.getRetryEnabled()&&settings.getProviderRetrySettings().maxRetries===0,'runtime_settings_mismatch');
  need(session.model.id==='gpt-6-luna'&&session.thinkingLevel==='low'&&session.sessionId===sessionId,'initial_model_mismatch');
  stage='observer_install';
  write('luna-api-ledger.jsonl','');
  const {financialPolicyId}=await import('../luna-finance-mode-v2/journal.mjs');
  const rs=fs.statSync(root,{bigint:true}),js=fs.statSync(path.join(root,'luna-api-ledger.jsonl'),{bigint:true});
  const spendPolicy=spec.mode==='positive_cap'?{mode:'positive_cap',capUsd:'0.1'}:{mode:'credit_exhaustion'};
  const meta={schema_version:11,contract:'prospective-shared-source-finance-v6',client:'pi',binding_profile_id:'pi-luna-v0731-shared-v1',
    protocol_id:'pi-source-observer-v1',run_id:'synthetic',root_turn_id:sessionId,route:'openai-direct',task_prompt_sha256:sha(TASK),
    observer_source_sha256:selection.dependencies['luna-observer-v6/direct.mjs'],installed_adapter_sha256:selection.dependencies['stream_adapters.py'],
    installed_adapter_path:path.join(FAIR,'stream_adapters.py'),publication_channel_id:spec.channel,
    binding:{contract_path:path.join(root,'contract.json'),expected:sealed.expected,deployed_source_pins:selection.pi_sources,
      binding_source_sha256:selection.dependencies['shared-luna-binding-v1/binding.py'],bridge_source_sha256:selection.dependencies['shared-luna-binding-v1/bridge.py'],python_path:selection.python,python_sha256:selection.python_sha256},
    fixed_policy:{policy_path:path.join(root,'policy.json'),policy_sha256:sha(sealed.policyRaw),bridge_sha256:selection.dependencies['luna-policy-v2/policy_bridge.py']},
    financial:{schema_version:2,spend_policy:spendPolicy,policy_id:financialPolicyId(spendPolicy),inventory:{rootDev:String(rs.dev),rootIno:String(rs.ino),journalDev:String(js.dev),journalIno:String(js.ino),prefixBytes:0,prefixSha256:sha('')}}};
  const metadata=JSON.stringify(meta);write('metadata.json',metadata);
  Object.assign(process.env,{LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'synthetic',LUNA_TASK_CALL_CAP:'1',LUNA_CAPTURE_METADATA:path.join(root,'metadata.json'),LUNA_CAPTURE_METADATA_SHA256:sha(metadata)});
  globalThis.fetch=async request=>{
    calls++;need(calls===1,'duplicate_native_send');
    const rows=fs.readFileSync(path.join(root,'luna-api-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    need(rows.length===1&&rows[0].event==='admit','missing_financial_admission');
    need(request instanceof Request&&request.url==='https://api.openai.com/v1/responses'&&request.method==='POST'&&request.redirect==='manual','native_request_shape');
    const raw=Buffer.from(await request.arrayBuffer());need(sha(raw)===rows[0].request_sha256,'admission_bytes_mismatch');
    need(sha(canonical(JSON.parse(raw)))===sha(canonical(sealed.expectedBody)),'independent_wire_mismatch');
    const response={id:'resp_synthetic',model:'gpt-6-luna',status:'in_progress'};
    const item={type:'message',id:'msg_synthetic',role:'assistant',status:'completed',content:[{type:'output_text',text:'Done.',annotations:[]}]};
    const events=[{type:'response.created',response},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'Done.'},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0}}}}];
    const bytes=new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
    let pulled=false;
    return new Response(new ReadableStream({pull(controller){
      if(!pulled){pulled=true;controller.enqueue(bytes);return;}
      if(spec.case==='abort'){
        if(!abortPromise){abortPromise=Promise.resolve().then(()=>session.abort());abortPromise.catch(()=>{});}
        return new Promise(()=>{});
      }
      eof=true;controller.close();
    },cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
  };
  await import('../luna-observer-v6/direct.mjs');
  unsubscribe=session.subscribe(event=>{if(event.type==='agent_end')terminalEvents++;});
  stage='prompt';
  if(spec.case==='policy')session.setThinkingLevel('medium');
  await session.prompt(spec.case==='task'?TASK+' Mutated.':TASK,{expandPromptTemplates:false});
  stage='idle';await session.agent.waitForIdle();if(abortPromise)await abortPromise;
  need(!session.isStreaming&&terminalEvents===1,'terminal_lifecycle_missing');
  const assistant=session.messages.findLast(m=>m.role==='assistant');
  need(assistant,'assistant_missing');
  if(spec.case==='normal')need(assistant.stopReason==='stop'&&assistant.content.map(b=>b.type==='text'?b.text:'').join('')==='Done.'&&eof,'assistant_success_missing');
  else if(spec.case==='abort')need(assistant.stopReason==='aborted'&&!eof&&calls===1&&cancels===1,'abort_outcome_mismatch');
  else need(assistant.stopReason==='error'&&calls===0,'refusal_missing');
  finalMessage={kind:'pi.source.observer.final.v1',channel:spec.channel,case:spec.case,calls,cancels,eof,terminalEvents,
    stopReason:assistant.stopReason,contentMatched:assistant.content.map(b=>b.type==='text'?b.text:'').join('')==='Done.',
    bridgeCalls,externalAttempts:denied,rootTurnId:sessionId};
}catch(error){failed=true;primary=error;}
finally{
  try{if(session?.isStreaming)await session.abort();}catch(error){if(!failed){failed=true;primary=error;}}
  try{unsubscribe?.();session?.dispose();disposed=true;}catch(error){if(!failed){failed=true;primary=error;}}
}
if(failed){
  const reason=typeof primary?.message==='string'&&/^[a-z_]{1,96}$/.test(primary.message)?primary.message:'fixture_failed';
  const errorName=typeof primary?.name==='string'&&/^[A-Za-z]{1,32}$/.test(primary.name)?primary.name:'UnknownError';
  write('failure.json',JSON.stringify({stage,reason,errorName,externalAttempts:denied}));process.exitCode=1;
}
else{
  need(denied===0&&disposed,'cleanup_or_external_failure');
  finalMessage.disposed=disposed;write('outcome.json',JSON.stringify(finalMessage));
  await new Promise((resolve,reject)=>process.send(finalMessage,error=>error?reject(new Error('final_ipc_failed')):resolve()));
}
if(process.connected)process.disconnect();
