import {createHash} from "node:crypto";
import {readFileSync,mkdirSync,mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,test,expect} from "vitest";
import {ConfigStore} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/config/store.js";
import {ExecutionAdmissionKernel} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/budget/execution-admission-kernel.js";
import {OpenAIProvider} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/llm/providers/openai/adapter.js";
import {createManagedFeatures} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/llm/registry/features.js";
import {toOpenAIResponsesTools} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/llm/wire/tools.js";
import {PermissionModeRegistry} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/permissions/permission-mode.js";
import {createEmptyToolPermissionContext} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/permissions/types.js";
import {assembleSystemPromptSnapshot} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/prompts/system-prompt.js";
import {getAttachments,__INTERNAL} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/prompts/attachments/orchestrator.js";
import {attachmentsToMessages} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/prompts/attachments/messages.js";
import {getAttachmentTrackingState} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/attachment-state.js";
import {builtTools} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/run-turn-sampling-request.js";
import {Session,type SessionOpts,type SessionServices} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/session.js";
import {runTurn} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/run-turn.js";
import {resolveAgentRuntimeOptions} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/runtime-options.js";
import {RolloutStore} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/rollout-store.js";
import {bindExecutionAdmissionJournal} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/session/execution-admission-journal.js";
import {AsyncQueue} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/utils/async-queue.js";
import {buildToolRegistry} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/src/tool-registry.js";
import {mkCtx} from "/private/tmp/light-clean-recovery-CDlDMw/source/runtime/tests/fixtures.js";

// No wire builder is called for expectations. Actual fetch is synthetic only.
const CORE="/private/tmp/light-clean-recovery-CDlDMw/source/runtime";
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const MODEL="gpt-6-luna", TASK="Say Done. Do not invoke any tool.";
const SOURCE=Object.freeze(JSON.parse(readFileSync(new URL("./source-pins.json",import.meta.url),"utf8"))) as Readonly<Record<string,string>>;
function sourceMatches(pins=SOURCE) {
  if(canonical(pins)!==canonical(SOURCE))return false;
  return Object.entries(pins).every(([relative,digest])=>sha(readFileSync(join(CORE,relative)))===digest);
}
const environment=Object.freeze({AGENC_CACHE_SESSION_TAIL:"0",AGENC_OPENAI_REASONING_REPLAY:"1"});
function canonical(value:unknown):string {
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  if(value!==null&&typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>JSON.stringify(k)+":"+canonical(v)).join(",")+"}";
  return JSON.stringify(value);
}
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
type Body=Record<string,any>;
function compare(body:Body,expected:Body,pins=SOURCE) {
  if(!sourceMatches(pins))return {assembly_matches:false,binding_verified:null,reason:"source_pin_mismatch"};
  const names=new Set([...Object.keys(body),...Object.keys(expected)]);
  const differences=[...names].filter(key=>canonical(body[key])!==canonical(expected[key])).sort();
  return {assembly_matches:differences.length===0,binding_verified:null,
    reason:differences.length ? "assembly_mismatch" : "live_producer_outcomes_unavailable",
    mismatched_fields:differences,request_sha256:sha(canonical(body)),expectation_sha256:sha(canonical(expected))};
}
function response() {
  const event={type:"response.completed",response:{id:"synthetic",model:MODEL,status:"completed",
    output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Done"}]}],
    usage:{input_tokens:10,output_tokens:5,total_tokens:15}}};
  return new Response("event: response.completed\ndata: "+JSON.stringify(event)+"\n\n",
    {headers:{"content-type":"text/event-stream"}});
}

async function probe(mutation?:"task"|"tools"|"auxiliary"|"policy") {
  expect(sourceMatches()).toBe(true);
  const root=mkdtempSync(join(tmpdir(),"light-initial-preflight-"));
  const cwd=join(root,"workspace"),home=join(root,"home");
  mkdirSync(cwd,{mode:0o700});mkdirSync(join(cwd,".git"));mkdirSync(home,{mode:0o700});
  const configStore=new ConfigStore({home,cwd,env:{AGENC_HOME:home}});
  const kernel=new ExecutionAdmissionKernel({agencHome:home,ownerId:"initial-preflight",ownerPid:process.pid});
  const admission=kernel.bindClient({cwd,scope:{runId:"preflight-root",sessionId:"preflight-root",autonomous:false}});
  const chronology:string[]=[];
  let expected:Body|undefined,sealedHash:string|undefined,captured:Body|undefined,calls=0;
  let actualSession:Session|undefined,rootAtCapture:{turn_id:string;task_sha256:string}|undefined;
  const provider=new OpenAIProvider({apiKey:"synthetic-not-a-key",model:MODEL,useResponsesApi:true,
    maxTokens:8192,maxRetries:0,
    fetchImpl:async(_url,init)=>{
      calls++;chronology.push("capture");
      expect(calls).toBe(1);expect(expected).toBeDefined();
      expect(sha(canonical(expected))).toBe(sealedHash);
      expect(chronology.indexOf("sealed")).toBeLessThan(chronology.indexOf("capture"));
      const rootHuman=actualSession?.currentRootHumanTurn();
      expect(rootHuman?.turnId).toBe("root-turn-1");
      rootAtCapture={turn_id:rootHuman!.turnId,task_sha256:sha(rootHuman!.text)};
      captured=JSON.parse(String(init?.body));
      return response();
    }});
  const features=createManagedFeatures();
  const modelInfo={...mkCtx().modelInfo,slug:MODEL,maxOutputTokens:8192,maxOutputTokensExplicit:true};
  const ctx=mkCtx({cwd,subId:"root-turn-1",modelProviderId:"openai",reasoningEffort:"low",reasoningSummary:"auto",
    collaborationMode:{model:MODEL},modelInfo,config:{lightReasoningPolicy:"fixed"} as any});
  const sessions:Session[]=[];
  function session(id:string) {
    let value:Session;
    const registry=buildToolRegistry({workspaceRoot:cwd,lightMode:true,requireAdmission:true,getSession:()=>value});
    const permissions=new PermissionModeRegistry(createEmptyToolPermissionContext());
    const configuration={cwd,approvalPolicy:{value:"never"},sandboxPolicy:{value:"read_only"},
      fileSystemSandboxPolicy:ctx.fileSystemSandboxPolicy,networkSandboxPolicy:ctx.networkSandboxPolicy,
      windowsSandboxLevel:"none",collaborationMode:{model:MODEL},dynamicTools:[],sessionSource:"cli_main",provider};
    value=new Session({conversationId:id,services:{
      provider,providerEnvironment:environment,registry,configStore,executionAdmission:admission,admissionRequired:true,
      runtimeOptions:resolveAgentRuntimeOptions(environment,{lightMode:true}),permissionModeRegistry:permissions,
      mcpConnectionManager:{setApprovalPolicy:()=>{},setSandboxPolicy:()=>{},requiredStartupFailures:async()=>[]},
      mcpStartupCancellationToken:{cancel:()=>{},isCancelled:()=>false},hooks:{executeStop:async()=>({})},
    } as unknown as SessionServices,
      initialState:{history:[],sessionConfiguration:configuration} as SessionOpts["initialState"],
      config:{model:MODEL,cwd,features,multiAgentV2:{usageHintEnabled:false,usageHintText:"",hideSpawnAgentMetadata:false},
        permissions:{allowLoginShell:false,shellEnvironmentPolicy:{allowedEnvVars:[],blockedEnvVars:[]},windowsSandboxPrivateDesktop:false},
        ghostSnapshot:{enabled:false},agentRoles:[]} as SessionOpts["config"],
      features,jsRepl:{id},modelInfo,eventQueue:new AsyncQueue()});
    sessions.push(value);return value;
  }
  let store:RolloutStore|undefined,unbind:(()=>void)|undefined;
  try {
    const preflight=session("preflight-assembly");
    const tools=builtTools(preflight,ctx);
    expect(tools.map(t=>t.function.name)).toEqual(["FileRead","MultiEdit","Write","exec_command","system.searchTools"]);
    const assemble=(s:Session)=>assembleSystemPromptSnapshot({session:s,ctx,profile:"light",
      enabledToolNames:new Set(tools.map(t=>t.function.name)),provider:"openai",
      permissionContext:s.permissionModeRegistry.current(),agentsEnabled:false,outputStyle:null,mcpServers:[]});
    const prompt=await assemble(preflight);
    const attachments=await getAttachments({sessionKey:preflight,lightMode:true,
      turnProvenance:{turnId:ctx.subId,rootHumanTurn:{turnId:ctx.subId,text:TASK}},
      userInput:TASK,loadedTools:tools,catalogToolNames:preflight.services.registry.tools
        .filter(t=>t.metadata?.source==="builtin").map(t=>t.name),discoveredToolNames:new Set(),
      messages:[{role:"user",content:TASK}],permissionContext:preflight.permissionModeRegistry.current(),
      cwd,subagentDepth:0,signal:new AbortController().signal,agencHome:home,config:configStore.current(),
      contextWindowTokens:modelInfo.contextWindow});
    expect(attachmentsToMessages(attachments)).toEqual([]);
    chronology.push("independent_assembly");
    expected=freeze({model:MODEL,stream:true,store:false,
      instructions:prompt.staticPrefix,
      input:[{type:"message",role:"user",content:[{type:"input_text",text:TASK}]},
        {type:"message",role:"system",content:[{type:"input_text",text:prompt.dynamicSuffix}]}],
      tools:toOpenAIResponsesTools(tools),max_output_tokens:8192,
      reasoning:{effort:"low",summary:"auto"},include:["reasoning.encrypted_content"],
      parallel_tool_calls:true,prompt_cache_key:"preflight-root"});
    sealedHash=sha(canonical(expected));chronology.push("sealed");
    const actual=session("preflight-root");
    actualSession=actual;
    expect(getAttachmentTrackingState(actual).lastEmittedDate).toBeUndefined();
    expect(getAttachmentTrackingState(preflight).lastEmittedDate).toBeDefined();
    if(mutation==="tools")actual.services.registry.discoverToolNames?.(["Glob"]);
    if(mutation==="auxiliary")getAttachmentTrackingState(actual).pendingCriticalReminder="Synthetic independently unapproved reminder.";
    const actualPrompt=await assemble(actual);
    chronology.push("actual_source_assembly");
    store=new RolloutStore({cwd,agencHome:home,sessionId:"preflight-root",agencVersion:"0.18.0",
      sessionTempRoot:root,autoStartScheduler:false});
    store.open({sessionId:"preflight-root",cwd,timestamp:"2026-09-30T00:00:00.000Z",
      originator:"initial-preflight",agencVersion:"0.18.0",model:MODEL,modelProvider:"openai"});
    actual.mountRolloutStore(store);unbind=bindExecutionAdmissionJournal(actual,admission);
    const actualCtx=mutation==="policy"?{...ctx,reasoningSummary:"none" as const}:ctx;
    const actualTask=mutation==="task"?TASK+" Synthetic changed task.":TASK;
    for await(const _ of runTurn(actual,actualCtx,actualTask,{systemPrompt:actualPrompt.text,instructionPolicy:"isolated"})) {}
    expect(calls).toBe(1);
    expect(kernel.listJournal({cwd,runId:"preflight-root"}).filter(r=>r.kind==="model_turn"&&r.event==="dispatched")).toHaveLength(1);
    expect(getAttachmentTrackingState(actual).lastEmittedDate).toBeDefined();
    expect(sha(canonical(expected))).toBe(sealedHash);
    return {expected,captured:captured!,chronology,rootAtCapture,producers:[...__INTERNAL.ordinaryProducerNames]};
  } finally {
    unbind?.();
    for(const s of sessions.reverse()){await s.shutdown();s.mountRolloutStore(null);}
    store?.close();kernel.close();
  }
  // Task-owned synthetic roots are retained; no user/accounting artifact is read.
}

describe("exact79b Light Luna base independent source assembly",()=>{
  test("independent assembly precedes one real admitted request; producer provenance stays unknown",async()=>{
    const result=await probe();
    const verdict=compare(result.captured,result.expected);
    expect(verdict.assembly_matches,JSON.stringify(verdict)).toBe(true);
    expect(verdict.binding_verified).toBeNull();expect(verdict.reason).toBe("live_producer_outcomes_unavailable");
    expect(result.producers.length).toBe(19);
    expect(result.rootAtCapture).toEqual({turn_id:"root-turn-1",task_sha256:sha(TASK)});
    expect(result.chronology).toEqual(["independent_assembly","sealed","actual_source_assembly","capture"]);
    // Negative requests never regenerate expected hashes.
    for(const mutate of [
      (b:Body)=>{b.input[0].content[0].text+=" changed";},
      (b:Body)=>{b.tools[0].description+=" changed";},
      (b:Body)=>{b.input[1].content[0].text+=" changed";},
      (b:Body)=>{b.reasoning.effort="medium";},
      (b:Body)=>{b.reasoning.summary="none";},
      (b:Body)=>{b.max_output_tokens=8191;},
      (b:Body)=>{delete b.include;},
      (b:Body)=>{b.input.unshift(b.input[0]);},
    ]) {
      const changed=structuredClone(result.captured);mutate(changed);
      expect(compare(changed,result.expected).assembly_matches).toBe(false);
    }
    const badPins={...SOURCE,[Object.keys(SOURCE)[0]!]: "0".repeat(64)};
    expect(compare(result.captured,result.expected,badPins).reason).toBe("source_pin_mismatch");
    expect(compare(result.captured,result.expected,{}).reason).toBe("source_pin_mismatch");
  },30000);
  for(const mutation of ["task","tools","auxiliary","policy"] as const) {
    test(`real source assembly ${mutation} mutation refuses the presealed base expectation`,async()=>{
      const result=await probe(mutation);
      const verdict=compare(result.captured,result.expected);
      expect(verdict.assembly_matches).toBe(false);
      expect(verdict.binding_verified).toBeNull();expect(verdict.reason).toBe("assembly_mismatch");
    },30000);
  }
});
