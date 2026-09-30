import {createHash} from "node:crypto";
import {readFileSync,mkdirSync,mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe,test,expect} from "vitest";
import {ConfigStore} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/config/store.js";
import {ExecutionAdmissionKernel} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/budget/execution-admission-kernel.js";
import {OpenAIProvider} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/llm/providers/openai/adapter.js";
import {createManagedFeatures} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/llm/registry/features.js";
import {toOpenAIResponsesTools} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/llm/wire/tools.js";
import {PermissionModeRegistry} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/permissions/permission-mode.js";
import {createEmptyToolPermissionContext} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/permissions/types.js";
import {assembleSystemPromptSnapshot} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/prompts/system-prompt.js";
import {getAttachments} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/prompts/attachments/orchestrator.js";
import {attachmentsToMessages} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/prompts/attachments/messages.js";
import {getAttachmentTrackingState} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/attachment-state.js";
import {builtTools} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/run-turn-sampling-request.js";
import {Session,type SessionOpts,type SessionServices} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/session.js";
import {runTurn} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/run-turn.js";
import {resolveAgentRuntimeOptions} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/runtime-options.js";
import {RolloutStore} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/rollout-store.js";
import {bindExecutionAdmissionJournal} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/execution-admission-journal.js";
import {AsyncQueue} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/utils/async-queue.js";
import {buildToolRegistry} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/tool-registry.js";
import {mkCtx} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/tests/fixtures.js";
import {AsyncLocalStorage} from "node:async_hooks";
import {spawnSync} from "node:child_process";
import type {AttachmentAssemblyEvidence} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/prompts/attachments/assembly-evidence.js";
import {preparedSemanticDigest as digest,type PreparedSamplingEvidence,type PreparedSamplingValidator} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/prepared-sampling-evidence.js";
import type {AdmissionJournalEvent} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/budget/admission-types.js";
import {getSessionPermissionInstructions} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/permission-instructions.js";
import {toAgenCRuntimeMessages,fromAgenCRuntimeMessages} from "/private/tmp/light-clean-prepared-mHtxlR/source/runtime/src/session/runtime-message-conversion.js";

const CORE="/private/tmp/light-clean-prepared-mHtxlR/source/runtime";
const MODEL="gpt-6-luna", TASK="Say Done. Do not invoke any tool.", TURN="root-turn-1";
const sha=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const SOURCE=Object.freeze(JSON.parse(readFileSync(new URL("./source-pins.json",import.meta.url),"utf8"))) as Readonly<Record<string,string>>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRODUCERS=Object.freeze(["plan_mode","verify_plan_reminder","auto_mode","swarm_mode","deferred_tools_delta","requested_tools","agent_listing_delta",
  "mcp_instructions_delta","date_change","instruction_update","critical_reminder","output_style","relevant_memories","changed_files","lsp_diagnostics",
  "agent_mentions","mcp_resources","file_mentions","skill_listing"]);
const environment=Object.freeze({AGENC_CACHE_SESSION_TAIL:"0",AGENC_OPENAI_REASONING_REPLAY:"1"});
const BRIDGE="/private/tmp/light-takeover/fair-confirmation/luna-policy-v1/policy_bridge.py";
const PREDICATE="/private/tmp/light-takeover/fair-confirmation/all-call-policy-v1/policy.py";
const BRIDGE_SHA="0cc7f89c0a5a31b0b45e707350d751bfb744b3caca3ba65178140d634d76fa4a";
const PREDICATE_SHA="c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf";
function check(ok:unknown):asserts ok {if(!ok)throw new Error("Synthetic preflight refused");}
function sourceMatches(pins=SOURCE) {
  return digest(pins)===digest(SOURCE)&&Object.entries(pins).every(([relative,expected])=>sha(readFileSync(join(CORE,relative)))===expected);
}
function freeze<T>(value:T):T {if(value!==null&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
type Body=Record<string,unknown>;
function policyBytes() {
  // Authored here from the approved fixed configuration, never observed data.
  return Buffer.from(JSON.stringify({schema_version:1,profile:"fixed-luna-v1",route:"openai-direct",client:"light",controls:{
    model:MODEL,stream:true,store:false,max_output_tokens:8192,reasoning:{effort:"low",summary:"auto"},
    include:["reasoning.encrypted_content"],parallel_tool_calls:true,prompt_cache_key:"preflight-root"}}));
}
function wirePolicy(bytes:Buffer,policy:Buffer,policyHash:string):boolean {
  check(sha(readFileSync(BRIDGE))===BRIDGE_SHA&&sha(readFileSync(PREDICATE))===PREDICATE_SHA);
  const result=spawnSync("/usr/bin/python3",["-I","-B",BRIDGE],{env:{},encoding:"utf8",timeout:5000,maxBuffer:8192,
    input:JSON.stringify({request:bytes.toString("base64"),policy:policy.toString("base64"),expected_sha256:policyHash,client:"light",ordinal:1})});
  check(!result.error&&result.status===0&&result.stderr==="");
  const verdict=JSON.parse(result.stdout) as {policy_verified?:unknown;request_sha256?:unknown;policy_sha256?:unknown};
  return verdict.policy_verified===true&&verdict.request_sha256===sha(bytes)&&verdict.policy_sha256===policyHash;
}
function emptyOrdinary(report:AttachmentAssemblyEvidence|undefined):boolean {
  return report!==undefined&&report.schemaVersion===1&&report.collection==="ordinary"&&report.inventory==="complete"&&report.unknownReason===null&&
    digest(report.outcomes)===digest(PRODUCERS.map(producer=>({producer,status:"fulfilled",outputCount:0,outputKinds:[]})));
}
type Expected=Readonly<{instructionsDigest:string;tools:readonly {nameDigest:string;definitionDigest:string}[];
  fields:readonly {field:string;present:boolean;digest:string|null}[];messageProjectionDigest:string;wire:Body}>;
type Slot={id:string;taskDigest:string;projectionDigest:string};
function projectIndependentSeed(id:string) {
  return fromAgenCRuntimeMessages(toAgenCRuntimeMessages([{role:"user",content:TASK,runtimeOnly:{userMessageId:id}}]));
}
function selectedMismatch(report:PreparedSamplingEvidence,expected:Expected,slots:readonly Slot[],sourceOk:boolean):string|null {
  if(!sourceOk)return "source";
  if(slots.length!==1||!slots[0]!.id.startsWith("user-msg-")||!UUID.test(slots[0]!.id.slice(9))||slots[0]!.taskDigest!==digest(TASK)||
    slots[0]!.projectionDigest!==expected.messageProjectionDigest)return "event";
  if(report.schemaVersion!==1||report.digestCodec!=="prepared-semantic-v1"||report.inventory!=="complete"||report.unknownReason!==null||
    typeof report.managedRequestId!=="string"||!UUID.test(report.managedRequestId)||report.details===null)return "inventory";
  const d=report.details;
  const checks={root:digest(d.root)===digest({present:true,matchesActiveTurn:true,turnDigest:digest(TURN),textDigest:digest(TASK)}),
    counts:digest(d.counts)===digest({sourceMessages:1,preAttachmentMessages:1,retainedBlocks:0,retainedMessages:0,rawAttachmentOutputs:0}),assembly:emptyOrdinary(d.assembly),
    messages:digest(d.messages)===digest([{role:"user",contentForm:"text",digest:digest({role:"user",content:TASK})}]),
    instructions:d.instructionsDigest===expected.instructionsDigest,tools:digest(d.tools)===digest(expected.tools),fields:digest(d.fields)===digest(expected.fields)};
  return Object.entries(checks).find(([,matches])=>!matches)?.[0]??null;
}
function correlate(id:unknown,accepted:ReadonlySet<string>,rows:readonly AdmissionJournalEvent[]):AdmissionJournalEvent {
  check(typeof id==="string"&&UUID.test(id)&&accepted.has(id));
  const dispatched=rows.filter(row=>row.kind==="model_turn"&&row.event==="dispatched");
  check(dispatched.length===1);
  const row=dispatched[0]!;
  check(row.details?.managedRequestId===id&&typeof row.reservationId==="string"&&row.reservationId.length>0&&row.runId==="preflight-root");
  return row;
}
function response() {
  const event={type:"response.completed",response:{id:"synthetic",model:MODEL,status:"completed",
    output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Done"}]}],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}};
  return new Response("event: response.completed\ndata: "+JSON.stringify(event)+"\n\n",{headers:{"content-type":"text/event-stream"}});
}
type Mutation="task"|"tools"|"auxiliary"|"cap"|"summary"|"effort"|"replay"|"source"|"missing_event"|"duplicate_event"|"malformed_event"|"stale_event"|
  "unknown_inventory"|"rejected_producer"|"duplicate_validation";

async function probe(mutation?:Mutation) {
  const hermetic=Object.getOwnPropertyDescriptor(globalThis,Symbol.for("agenc.test.hermetic-runtime.marker"));
  check(hermetic?.value?.version==="agenc-hermetic-network-tripwire-v1"&&hermetic.configurable===false&&hermetic.writable===false);
  check(sourceMatches());
  const root=mkdtempSync(join(tmpdir(),"light-preflight-v2-")),cwd=join(root,"workspace"),home=join(root,"home");
  mkdirSync(cwd,{mode:0o700});mkdirSync(join(cwd,".git"));mkdirSync(home,{mode:0o700});
  const sessions:Session[]=[],disposers:Array<()=>void>=[];
  let kernel:ExecutionAdmissionKernel|undefined,store:RolloutStore|undefined;
  const chronology:string[]=[],slots:Slot[]=[],accepted=new Set<string>();
  const invocation=new AsyncLocalStorage<{id:string;reservation:string;step:string}>();
  let calls=0,validations=0,selectedRefused=false,wireRefused=false,wireMatched=false;
  let selectedReason:string|null=null;
  let expected:Expected|undefined,expectedHash:string|undefined,acceptedReport:PreparedSamplingEvidence|undefined;
  let capturedDigest:string|undefined,policyHash:string|undefined;
  const policy=policyBytes();
  let rows:readonly AdmissionJournalEvent[]=[];
  let primaryFailed=false,primaryCause:unknown;
  try {
    const configStore=new ConfigStore({home,cwd,env:{AGENC_HOME:home}});
    kernel=new ExecutionAdmissionKernel({agencHome:home,ownerId:"initial-preflight-v2",ownerPid:process.pid});
    const ownedKernel=kernel;
    const admission=kernel.bindClient({cwd,scope:{runId:"preflight-root",sessionId:"preflight-root",autonomous:false}});
    const journal=()=>ownedKernel.listJournal({cwd,runId:"preflight-root"});
    const provider=new OpenAIProvider({apiKey:"synthetic-not-a-key",model:MODEL,useResponsesApi:true,maxTokens:8192,maxRetries:0,
      fetchImpl:async(_url,init)=>{
        calls++;chronology.push("fakefetch");check(calls===1&&expected!==undefined&&expectedHash!==undefined&&policyHash!==undefined);
        // Canonical credential-redirect-fetch forwards a URL object, not the
        // adapter's original string. Check its exact destination immediately.
        check(_url instanceof URL&&_url.href==="https://api.openai.com/v1/responses"&&init?.method==="POST"&&init.redirect==="manual");
        check(digest(expected)===expectedHash&&chronology.indexOf("sealed")<chronology.indexOf("selected"));
        const context=invocation.getStore();check(context!==undefined);
        const row=correlate(context.id,accepted,journal());
        check(row.reservationId===context.reservation&&row.stepId===context.step);
        check(typeof init?.body==="string");
        const bytes=Buffer.from(init.body,"utf8");capturedDigest=sha(bytes);
        if(!wirePolicy(bytes,policy,policyHash)) {
          wireRefused=true;chronology.push("wire_policy_refused");
          // Fake downstream refusal AFTER real admission: no synthetic usage
          // or successful settlement is invented. Core retains its disposition.
          return new Response(JSON.stringify({error:{message:"Synthetic preflight policy refused",type:"invalid_request_error"}}),
            {status:400,headers:{"content-type":"application/json"}});
        }
        wireMatched=digest(JSON.parse(init.body))===digest(expected.wire);check(wireMatched);
        chronology.push("wire_policy_accepted");return response();
      }});
    const originalStream=provider.chatStream.bind(provider);
    provider.chatStream=(messages,callback,options)=>{
      const row=correlate(options?.managedRequestId,accepted,journal());
      chronology.push("sqlite_dispatched","actual_provider");
      return invocation.run({id:options!.managedRequestId!,reservation:row.reservationId!,step:row.stepId},()=>originalStream(messages,callback,options));
    };
    const features=createManagedFeatures();
    const modelInfo={...mkCtx().modelInfo,slug:MODEL,maxOutputTokens:8192,maxOutputTokensExplicit:true};
    const ctx=mkCtx({cwd,subId:TURN,modelProviderId:"openai",reasoningEffort:"low",reasoningSummary:"auto",
      collaborationMode:{model:MODEL},modelInfo,config:{lightReasoningPolicy:"fixed"} as ReturnType<typeof mkCtx>["config"]});
    function session(id:string,validator?:PreparedSamplingValidator) {
      let value:Session;
      const registry=buildToolRegistry({workspaceRoot:cwd,lightMode:true,requireAdmission:true,getSession:()=>value});
      const permissions=new PermissionModeRegistry(createEmptyToolPermissionContext());
      const configuration={cwd,approvalPolicy:{value:"never"},sandboxPolicy:{value:"read_only"},fileSystemSandboxPolicy:ctx.fileSystemSandboxPolicy,
        networkSandboxPolicy:ctx.networkSandboxPolicy,windowsSandboxLevel:"none",collaborationMode:{model:MODEL},dynamicTools:[],sessionSource:"cli_main",provider};
      const selectedEnvironment=id==="preflight-root"&&mutation==="replay"?Object.freeze({...environment,AGENC_OPENAI_REASONING_REPLAY:"0"}):environment;
      value=new Session({conversationId:id,services:{provider,providerEnvironment:selectedEnvironment,registry,configStore,executionAdmission:admission,admissionRequired:true,
        ...(validator?{validatePreparedSampling:validator}:{}),runtimeOptions:resolveAgentRuntimeOptions(environment,{lightMode:true}),permissionModeRegistry:permissions,
        mcpConnectionManager:{setApprovalPolicy:()=>{},setSandboxPolicy:()=>{},requiredStartupFailures:async()=>[]},
        mcpStartupCancellationToken:{cancel:()=>{},isCancelled:()=>false},hooks:{executeStop:async()=>({})},
      } as unknown as SessionServices,initialState:{history:[],sessionConfiguration:configuration} as SessionOpts["initialState"],
        config:{model:MODEL,cwd,features,multiAgentV2:{usageHintEnabled:false,usageHintText:"",hideSpawnAgentMetadata:false},
          permissions:{allowLoginShell:false,shellEnvironmentPolicy:{allowedEnvVars:[],blockedEnvVars:[]},windowsSandboxPrivateDesktop:false},
          ghostSnapshot:{enabled:false},agentRoles:[]} as SessionOpts["config"],features,jsRepl:{id},modelInfo,eventQueue:new AsyncQueue()});
      sessions.push(value);return value;
    }
    const preflight=session("preflight-independent");
    const tools=builtTools(preflight,ctx);
    check(digest(tools.map(tool=>tool.function.name))===digest(["FileRead","MultiEdit","Write","exec_command","system.searchTools"]));
    const assemble=(s:Session)=>assembleSystemPromptSnapshot({session:s,ctx,profile:"light",enabledToolNames:new Set(tools.map(t=>t.function.name)),
      provider:"openai",permissionContext:s.permissionModeRegistry.current(),agentsEnabled:false,outputStyle:null,mcpServers:[]});
    const prompt=await assemble(preflight);
    let preflightAssembly:AttachmentAssemblyEvidence|undefined;
    const attachments=await getAttachments({sessionKey:preflight,lightMode:true,collectAssemblyEvidence:report=>{preflightAssembly=report;},
      turnProvenance:{turnId:TURN,rootHumanTurn:{turnId:TURN,text:TASK}},userInput:TASK,loadedTools:tools,
      catalogToolNames:preflight.services.registry.tools.filter(t=>t.metadata?.source==="builtin").map(t=>t.name),discoveredToolNames:new Set(),
      messages:[{role:"user",content:TASK}],permissionContext:preflight.permissionModeRegistry.current(),cwd,subagentDepth:0,
      signal:new AbortController().signal,agencHome:home,config:configStore.current(),contextWindowTokens:modelInfo.contextWindow});
    check(emptyOrdinary(preflightAssembly)&&attachments.length===0&&attachmentsToMessages(attachments).length===0);
    check(getSessionPermissionInstructions(preflight,ctx,preflight.permissionModeRegistry.current())==="");
    chronology.push("independent_assembly");
    check(typeof modelInfo.contextWindow==="number");
    const semanticFields={parallelToolCalls:true,contextWindowTokens:Math.floor(modelInfo.contextWindow*modelInfo.effectiveContextWindowPercent/100),
      // Fixed policy has no adaptive override: the owned field is explicitly
      // undefined. Effective low comes later from ctx and is checked at wire.
      maxOutputTokens:8192,lightReasoningEffort:undefined,openaiReasoningReplay:true};
    // The normal query conversion drops the source-generated userMessageId;
    // prove the pure projection before observing any live event/report/body.
    const seedTemplateProjection=projectIndependentSeed("user-msg-00000000-0000-4000-8000-000000000001");
    check(digest(seedTemplateProjection)===digest([{role:"user",content:TASK}]));
    expected=freeze({instructionsDigest:digest(prompt.text.trim()),tools:tools.map(tool=>({nameDigest:digest(tool.function.name),definitionDigest:digest(tool)})),
      messageProjectionDigest:digest(seedTemplateProjection),
      fields:["parallelToolCalls","toolChoice","contextWindowTokens","maxOutputTokens","skipCacheWrite","lightReasoningEffort","openaiReasoningReplay"].map(field=>({
        field,present:Object.hasOwn(semanticFields,field),digest:Object.hasOwn(semanticFields,field)?digest(semanticFields[field as keyof typeof semanticFields]):null})),
      wire:{model:MODEL,stream:true,store:false,instructions:prompt.staticPrefix,
        input:[{type:"message",role:"user",content:[{type:"input_text",text:TASK}]},{type:"message",role:"system",content:[{type:"input_text",text:prompt.dynamicSuffix}]}],
        tools:toOpenAIResponsesTools(tools),max_output_tokens:8192,reasoning:{effort:"low",summary:"auto"},include:["reasoning.encrypted_content"],
        parallel_tool_calls:true,prompt_cache_key:"preflight-root"}});
    expectedHash=digest(expected);policyHash=sha(policy);chronology.push("sealed");
    const validate=(report:PreparedSamplingEvidence):undefined=>{
      validations++;
      try {
        check(validations===1&&expected!==undefined&&digest(expected)===expectedHash&&journal().length===0);
        let candidate=report;
        if(mutation==="unknown_inventory"||mutation==="rejected_producer") {
          candidate=structuredClone(report);
          // Synthetic consumer-negative view, NOT a claim that a real producer
          // failed. The actual source report is never modified.
          if(mutation==="unknown_inventory")(candidate as {inventory:string}).inventory="unknown";
          else if(candidate.details)(candidate.details.assembly.outcomes[0] as {status:string}).status="rejected";
        }
        const selectedPins=mutation==="source"?{...SOURCE,[Object.keys(SOURCE)[0]!]:"0".repeat(64)}:SOURCE;
        selectedReason=selectedMismatch(candidate,expected,slots,sourceMatches(selectedPins));check(selectedReason===null);
        check(!accepted.has(report.managedRequestId!));accepted.add(report.managedRequestId!);acceptedReport=report;
        if(mutation==="duplicate_validation")validate(report);
        chronology.push("selected");
      } catch {selectedRefused=true;selectedReason??="validation_state";throw new Error("Synthetic selected preparation refused");}
    };
    const actual=session("preflight-root",validate);
    check(getAttachmentTrackingState(actual).lastEmittedDate===undefined&&getAttachmentTrackingState(preflight).lastEmittedDate!==undefined);
    if(mutation==="tools")actual.services.registry.discoverToolNames?.(["Glob"]);
    if(mutation==="auxiliary")getAttachmentTrackingState(actual).pendingCriticalReminder="Synthetic independently unapproved reminder.";
    disposers.push(actual.eventLog.subscribe(event=>{
      if(event.msg.type!=="user_message")return;
      chronology.push("canonical_user_event");
      if(mutation==="missing_event")return;
      const id=mutation==="malformed_event"?"bad-generated-id":event.id;
      const taskDigest=mutation==="stale_event"?digest("stale"):digest(event.msg.payload.message);
      const slot={id,taskDigest,projectionDigest:digest(projectIndependentSeed(id))};
      slots.push(slot);if(mutation==="duplicate_event")slots.push(slot);
    }));
    const actualPrompt=await assemble(actual);
    store=new RolloutStore({cwd,agencHome:home,sessionId:"preflight-root",agencVersion:"0.18.0",sessionTempRoot:root,autoStartScheduler:false});
    store.open({sessionId:"preflight-root",cwd,timestamp:"2026-09-30T00:00:00.000Z",originator:"initial-preflight-v2",agencVersion:"0.18.0",model:MODEL,modelProvider:"openai"});
    actual.mountRolloutStore(store);disposers.push(bindExecutionAdmissionJournal(actual,admission));
    const actualCtx=mutation==="summary"?{...ctx,reasoningSummary:"none" as const}:
      mutation==="effort"?{...ctx,reasoningEffort:"medium" as const}:
      mutation==="cap"?{...ctx,modelInfo:{...modelInfo,maxOutputTokens:8191}}:ctx;
    const actualTask=mutation==="task"?TASK+" Changed task.":TASK;
    for await(const _ of runTurn(actual,actualCtx,actualTask,{systemPrompt:actualPrompt.text,instructionPolicy:"isolated"})) {}
    rows=journal();
    if(rows.some(row=>row.event==="reconciled"))chronology.push("sqlite_reconciled");
    check(digest(expected)===expectedHash&&sha(policy)===policyHash);
    // No raw wire body/header capture is exported. The mounted RolloutStore
    // retains normal synthetic task/conversation events in the private root.
    return {chronology,calls,validations,selectedRefused,selectedReason,wireRefused,wireMatched,capturedDigest,policyHash,
      selectedId:acceptedReport?.managedRequestId??null,rows,expectedHash};
  } catch(error) {
    primaryFailed=true;primaryCause=error;
    throw error;
  } finally {
    const cleanupErrors:unknown[]=[];
    for(const dispose of disposers.reverse())try{dispose();}catch(error){cleanupErrors.push(error);}
    for(const s of sessions.reverse()) {
      try{await s.shutdown();}catch(error){cleanupErrors.push(error);}
      try{s.mountRolloutStore(null);}catch(error){cleanupErrors.push(error);}
    }
    try{store?.close();}catch(error){cleanupErrors.push(error);}
    try{kernel?.close();}catch(error){cleanupErrors.push(error);}
    if(cleanupErrors.length) {
      if(primaryFailed)throw new AggregateError([primaryCause,...cleanupErrors],"Synthetic preflight and cleanup failed",{cause:primaryCause});
      throw new AggregateError(cleanupErrors,"Synthetic preflight cleanup failed");
    }
    // Only new synthetic private roots are retained. No legacy data is removed.
  }
}

describe("bd88 source-only Luna base selected preflight",()=>{
  test("missing or changed independently retained source inventory refuses",()=>{
    expect(sourceMatches({})).toBe(false);
    expect(sourceMatches({...SOURCE,[Object.keys(SOURCE)[0]!]:"0".repeat(64)})).toBe(false);
  });
  test("independent expected template → canonical event → selected report → SQLite → actual provider → exact fakefetch",async()=>{
    const result=await probe();
    expect(result.selectedReason).toBeNull();
    expect(result.selectedRefused).toBe(false);expect(result.wireMatched).toBe(true);expect(result.wireRefused).toBe(false);
    expect(result.calls).toBe(1);expect(result.validations).toBe(1);
    expect(result.chronology).toEqual(["independent_assembly","sealed","canonical_user_event","selected","sqlite_dispatched","actual_provider","fakefetch","wire_policy_accepted","sqlite_reconciled"]);
    const row=correlate(result.selectedId,new Set([result.selectedId!]),result.rows);
    expect(result.rows.some(r=>r.event==="reconciled"&&r.reservationId===row.reservationId)).toBe(true);
    // Independent negative correlation views; no journal row is changed.
    for(const altered of [[],result.rows.map(r=>r.event==="dispatched"?{...r,details:{}}:r),
      result.rows.map(r=>r.event==="dispatched"?{...r,details:{...r.details,managedRequestId:"00000000-0000-4000-8000-000000000000"}}:r),[...result.rows,row]]) {
      expect(()=>correlate(result.selectedId,new Set([result.selectedId!]),altered)).toThrow("Synthetic preflight refused");
    }
    expect(()=>correlate(result.selectedId,new Set(),result.rows)).toThrow();
  },30000);
  test.each(["task","tools","auxiliary","cap","source","missing_event","duplicate_event","malformed_event","stale_event","unknown_inventory","rejected_producer","duplicate_validation"] as const)(
    "%s refuses selected main before real admission",async mutation=>{
      const result=await probe(mutation);
      expect(result.selectedRefused).toBe(true);expect(result.calls).toBe(0);expect(result.rows).toHaveLength(0);
      expect(result.chronology).not.toContain("actual_provider");
    },30000);
  test.each(["summary","effort","replay"] as const)("%s mutation refuses only at fakefetch AFTER real admission; disposition is preserved",async mutation=>{
    const result=await probe(mutation);
    expect(result.selectedReason).toBeNull();
    expect(result.selectedRefused).toBe(false);expect(result.wireRefused).toBe(true);expect(result.wireMatched).toBe(false);
    expect(result.calls).toBe(1);expect(result.rows.filter(r=>r.event==="dispatched")).toHaveLength(1);
    expect(result.rows.some(r=>r.event==="reconciled")).toBe(false);
    expect(result.rows.some(r=>r.event==="held_unknown")).toBe(true);
  },30000);
});
