// Independently declared reduced fixture values matching pinned fixtures.ts
// mkCtx/mkModelInfo. Never import its Vitest afterAll lifecycle or helpers.
import type {TurnContext} from '/private/tmp/light-clean-responses-eof-RKsVUm/source/runtime/src/session/turn-context.js';
export function mkCtx(overrides:Partial<TurnContext>={}):TurnContext{
 return {subId:'turn-abc',cwd:'/tmp',config:{maxTurns:100},configSnapshot:{},
 modelInfo:{slug:'test-model',effectiveContextWindowPercent:100,contextWindow:131072,
 supportedReasoningLevels:[],defaultReasoningSummary:'auto',truncationPolicy:'off',usedFallbackModelMetadata:false},
 collaborationMode:{model:'test-model'},approvalPolicy:{value:'never'},sandboxPolicy:{value:'read_only'},
 fileSystemSandboxPolicy:{allowWrite:[],denyWrite:[],allowRead:[],denyRead:[]},
 networkSandboxPolicy:{allowlist:[],denylist:[],allowManagedDomainsOnly:false},
 reasoningSummary:'auto',sessionSource:'cli_main',currentDate:'2026-04-30',timezone:'Etc/UTC',dynamicTools:[],depth:0,
 toolCallGate:{isReady:()=>true,signal:()=>{},wait:async()=>{}},...overrides} as unknown as TurnContext;
}



