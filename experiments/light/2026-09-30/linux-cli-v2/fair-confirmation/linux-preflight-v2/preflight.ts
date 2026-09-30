/** Never imports or calls runTurn, Session.runTurn, or a wire request builder.
 * Root-owned isolated child/loader must pin this module and dependencies BEFORE import.
 * Raw return material is private expected input, not a public report or approval.
 */
import { bootstrapLocalRuntimeSession, type LocalRuntimeBootstrap } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/bin/bootstrap.js";
import { buildStructuredSessionBootstrapArgv } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/app-server/session-bootstrap-argv.js";
import { resolveAgentRuntimeOptions } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/runtime-options.js";
import { trustProjectSync } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/permissions/trust/project-trust.js";
import { resolveManagedRootPath } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/utils/settings/managedPath.js";
import { runWithCanonicalSettingsAuthority } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/utils/settings/canonicalAuthority.js";
import { runWithCurrentRuntimeSession } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/current-session.js";
import { prepareUserPromptForTurn } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/hooks/user-prompt-ingress.js";
import { resolveLiveInstructionEnvelope } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/prompts/live-instructions.js";
import { resolveModelInstructionsForTurn } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/run-turn-messages.js";
import { builtTools, buildPrompt } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/run-turn-sampling-request.js";
import { getSessionPermissionInstructions } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/permission-instructions.js";
import { getAttachments } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/prompts/attachments/orchestrator.js";
import { attachmentsToMessages } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/prompts/attachments/messages.js";
import type { AttachmentAssemblyEvidence } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/prompts/attachments/assembly-evidence.js";
import { createAdmittedMemorySelector } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/memory/admitted-selector.js";
import { preparedSemanticDigest as digest } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/session/prepared-sampling-evidence.js";
import { toOpenAIResponsesTools } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/llm/wire/tools.js";
import { splitSystemPromptOnDynamicBoundary } from "/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/llm/wire/shared.js";
import { emptyResources, assertTargetUnchanged, pinnedBytes } from "../current-cli-observer-v1/empty-resources.mjs";
import { PREFLIGHT_EXECUTION_APPROVED, CORE, SOURCE_PINS } from "../current-cli-observer-v1/preflight-selection.mjs";

import { createPreflightFetchGuard } from "./fetch-classifier.mjs";

export const TASK = "Say Done. Do not invoke any tool.";
export const CONFIG = 'config_version = 2\nmodel = "gpt-6-luna"\nmodel_provider = "openai"\nreasoning_effort = "low"\nreasoning_summary = "auto"\nlight_reasoning_policy = "fixed"\nmax_output_tokens = 8192\n';
const PRODUCERS = ["plan_mode","verify_plan_reminder","auto_mode","swarm_mode","deferred_tools_delta","requested_tools","agent_listing_delta","mcp_instructions_delta","date_change","instruction_update","critical_reminder","output_style","relevant_memories","changed_files","lsp_diagnostics","agent_mentions","mcp_resources","file_mentions","skill_listing"];
function need(ok:unknown,reason:string):asserts ok {if(!ok)throw new Error(reason);}
export type Inputs = Readonly<{ workspace:string;targetHome:string;preflightHome:string;configPath:string;configSha256:string;fixedIso:string;signal:AbortSignal }>;

/** This successor denies every network request. Exact bodyless GET /models is
 * separately classified as a denied metadata/health lookup, not sampling.
 * Dynamic observations (not this source trace) establish which path actually ran.
 */
export async function prepareIndependent(input:Inputs) {
  const fetchGuard=createPreflightFetchGuard(),state={validations:0,collections:0};
  try { return await prepareIndependentInner(input,fetchGuard,state); }
  catch(error) {
    const failure=new AggregateError([error],"preflight_failed");
    Object.defineProperty(failure,"preflightDiagnostics",{enumerable:true,configurable:false,writable:false,
      value:Object.freeze({version:1,...fetchGuard.snapshot(),validations:state.validations,producerCollections:state.collections})});
    throw failure;
  }
}
async function prepareIndependentInner(input:Inputs,fetchGuard:ReturnType<typeof createPreflightFetchGuard>,state:{validations:number;collections:number}) {
  need(PREFLIGHT_EXECUTION_APPROVED,"preflight_execution_not_approved");
  input.signal.throwIfAborted();
  for(const [relative,hash] of Object.entries(SOURCE_PINS))pinnedBytes(CORE+"/"+relative,hash);
  need(pinnedBytes(input.configPath,input.configSha256).toString("utf8")===CONFIG,"config_not_independent_literal");
  need(new Date().toISOString()===input.fixedIso,"fixed_clock_missing");
  need(process.env.HOME===input.preflightHome&&process.env.AGENC_HOME===input.preflightHome,"private_process_home_required");
  need(process.env.AGENC_CACHE_SESSION_TAIL==="0"&&process.env.AGENC_OPENAI_REASONING_REPLAY==="1","declared_environment_missing");
  const marker=Object.getOwnPropertyDescriptor(globalThis,Symbol.for("agenc.test.hermetic-runtime.marker"));
  need(marker?.value?.version==="agenc-hermetic-network-tripwire-v1"&&marker.configurable===false&&marker.writable===false,"network_tripwire_missing");
  const env={PATH:process.env.PATH,HOME:input.preflightHome,AGENC_HOME:input.preflightHome,AGENC_WORKSPACE:input.workspace,
    AGENC_CACHE_SESSION_TAIL:"0",AGENC_OPENAI_REASONING_REPLAY:"1",TZ:"UTC"};
  const identity=emptyResources({...input,managedRoot:resolveManagedRootPath(env)});
  // Trust only the private preflight home. Measured-home trust is a separate
  // root-created input, never written here or inferred from this marker.
  trustProjectSync({agencHome:input.preflightHome,cwd:input.workspace,env});
  let boot:LocalRuntimeBootstrap|undefined,primary=false,cause:unknown,result:unknown;
  try {
    boot=await bootstrapLocalRuntimeSession({
      cwd:input.workspace,conversationId:"cli-independent-preflight",apiKey:"synthetic-unused",env,
      argv:buildStructuredSessionBootstrapArgv({provider:"openai",model:"gpt-6-luna",configPath:input.configPath,permissionMode:"default"},[process.execPath,"agenc"]),
      runtimeOptions:resolveAgentRuntimeOptions(env,{lightMode:true,nonInteractive:true}),
      executionAdmissionAutonomous:true,requireSandboxReadyAtStartup:true,costSummaryOnExit:false,
      deferSessionStartHooks:true,deferAgentStartupSideEffects:true,deferDurableTurnResume:true,signal:input.signal,
      validatePreparedSampling:()=>{state.validations++;throw new Error("preflight_sampling_forbidden");},
      fetchImpl:fetchGuard.fetchImpl,
    });
    const prepared=boot;
    result=await runWithCurrentRuntimeSession(prepared.session,()=>runWithCanonicalSettingsAuthority(prepared.configStore,async()=>{
      const ctx=prepared.session.newDefaultTurnWithSubId("independent-root-template");
      need(ctx.cwd===input.workspace&&ctx.depth===0&&ctx.config.lightReasoningPolicy==="fixed","context_mismatch");
      need(ctx.reasoningEffort==="low"&&ctx.reasoningSummary==="auto"&&ctx.modelInfo.maxOutputTokens===8192,"policy_mismatch");
      need(prepared.session.services.runtimeOptions?.nonInteractive===true&&prepared.session.services.runtimeOptions?.lightMode===true,"runtime_options_mismatch");
      // Assert canonical fresh defaults; do not disable resources to make the
      // preflight agree. This is necessary, not sufficient, for equivalence
      // with the measured daemon's ordinary startup (which remains untested).
      const config=prepared.configStore.current();
      need(Object.keys(config.hooks??{}).length===0&&Object.keys(config.mcp_servers??{}).length===0,"nonempty_startup_configuration");
      need(config.plugins?.enabled===false&&(config.plugins.dirs??[]).length===0&&
        (config.plugins.allowlist??[]).length===0&&Object.keys(config.plugins.plugins??{}).length===0,"nonempty_plugin_configuration");
      need(config.outputStyle===undefined&&Object.keys(config.lsp_servers??{}).length===0,"nonempty_style_or_lsp_configuration");
      const permission=prepared.session.permissionModeRegistry.current();need(permission.mode==="default","permission_mismatch");
      const ingress=await prepareUserPromptForTurn({session:prepared.session,configStore:prepared.configStore,input:TASK});
      need(!ingress.blocked&&ingress.input===TASK,"unexpected_ingress_context");
      const envelope=await resolveLiveInstructionEnvelope({session:prepared.session,ctx,baseInstructions:ctx.baseInstructions??""});
      need(envelope.sources.length===0&&envelope.warnings.length===0&&envelope.workspaceText===""&&envelope.memoryText==="","nonempty_instruction_inventory");
      const instructions=[resolveModelInstructionsForTurn(ctx,envelope.text),getSessionPermissionInstructions(prepared.session,ctx,permission)]
        .map(part=>part.trim()).filter((part,index,all)=>part.length>0&&all.indexOf(part)===index).join("\n\n");
      const tools=builtTools(prepared.session,ctx);
      need(digest(tools.map(tool=>tool.function.name))===digest(["FileRead","MultiEdit","Write","exec_command","system.searchTools"]),"unexpected_initial_tools");
      const unavailable=prepared.registry.getUnavailableToolNames?.();
      let evidence:AttachmentAssemblyEvidence|undefined;
      const attachments=await getAttachments({sessionKey:prepared.session,lightMode:true,
        collectAssemblyEvidence:(report):undefined=>{state.collections++;evidence=report;return undefined;},
        admittedMemorySelector:createAdmittedMemorySelector(prepared.session),
        turnProvenance:{turnId:ctx.subId,rootHumanTurn:{turnId:ctx.subId,text:TASK}},userInput:TASK,loadedTools:tools,
        ...(unavailable===undefined?{}:{catalogToolNames:prepared.registry.tools.filter(tool=>tool.metadata?.source==="builtin"&&!unavailable.has(tool.name)).map(tool=>tool.name)}),
        discoveredToolNames:prepared.registry.getDiscoveredToolNames?.()??new Set(),messages:[{role:"user",content:TASK}],
        permissionContext:permission,cwd:input.workspace,
        ...(prepared.session.services.sandboxExecutionBroker===undefined?{}:{sandboxExecutionBroker:prepared.session.services.sandboxExecutionBroker}),
        subagentDepth:0,signal:input.signal,agencHome:input.preflightHome,skillsManager:prepared.session.services.skillsManager,
        config,...(ctx.modelInfo.contextWindow===undefined?{}:{contextWindowTokens:ctx.modelInfo.contextWindow})});
      need(state.collections===1&&evidence?.inventory==="complete"&&evidence.collection==="ordinary"&&evidence.unknownReason===null,"producer_evidence_unknown");
      need(digest(evidence.outcomes)===digest(PRODUCERS.map(producer=>({producer,status:"fulfilled",outputCount:0,outputKinds:[]}))),"nonempty_producer_inventory");
      need(attachments.length===0&&attachmentsToMessages(attachments).length===0,"unexpected_auxiliary_layout");
      const prompt=buildPrompt([{role:"user",content:TASK}],tools,ctx,instructions);
      // Encode semantic presence separately, including the deliberate present
      // undefined fixed-policy field. Raw JSON persistence must not erase it.
      const fields=["parallelToolCalls","toolChoice","contextWindowTokens","maxOutputTokens","skipCacheWrite","lightReasoningEffort","openaiReasoningReplay"].map(field=>{
        if(field==="lightReasoningEffort")return {field,present:true,digest:digest(undefined)};
        if(field==="openaiReasoningReplay")return {field,present:true,digest:digest(true)};
        const descriptor=Object.getOwnPropertyDescriptor(prompt,field);
        return {field,present:descriptor!==undefined,digest:descriptor===undefined?null:digest(descriptor.value)};
      });
      const split=splitSystemPromptOnDynamicBoundary(instructions);
      need(split.staticPrefix&&split.dynamicSuffix&&split.sessionSuffix===undefined,"unsupported_instruction_split");
      const material={version:1,task:TASK,instructions,tools,assembly:evidence,
        semantic:{instructionsDigest:digest(instructions),messages:[{role:"user",contentForm:"text",digest:digest({role:"user",content:TASK})}],
          tools:tools.map(tool=>({nameDigest:digest(tool.function.name),definitionDigest:digest(tool)})),
          fields},
        wireTemplate:{model:"gpt-6-luna",stream:true,store:false,instructions:split.staticPrefix,
          input:[{type:"message",role:"user",content:[{type:"input_text",text:TASK}]},{type:"message",role:"system",content:[{type:"input_text",text:split.dynamicSuffix}]}],
          tools:toOpenAIResponsesTools(tools),max_output_tokens:8192,reasoning:{effort:"low",summary:"auto"},include:["reasoning.encrypted_content"],parallel_tool_calls:prompt.parallelToolCalls},
        generatedSlots:["conversationId/prompt_cache_key","rootTurnId","managedRequestId","user-initial-threadId"],
        equivalence:"fresh-empty-resource-only",selectedOrWireObserved:false};
      return {material,semanticDigest:digest(material),producerCollections:state.collections,...fetchGuard.snapshot(),validations:state.validations};
    }));
    need(fetchGuard.snapshot().forbiddenFetches===0&&state.validations===0,"preflight_attempted_sampling");
  }catch(error){primary=true;cause=error;}
  const cleanupErrors:unknown[]=[];
  try{await boot?.shutdown();}catch(error){cleanupErrors.push(error);}
  try{assertTargetUnchanged(input,identity);}catch(error){cleanupErrors.push(error);}
  if(primary&&cleanupErrors.length)throw new AggregateError([cause,...cleanupErrors],"preflight_and_cleanup_failed");
  if(primary)throw cause;
  if(cleanupErrors.length)throw new AggregateError(cleanupErrors,"preflight_cleanup_failed");
  return result;
}

