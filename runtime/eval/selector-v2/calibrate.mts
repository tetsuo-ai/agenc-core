/** Calibration-only. Each reported v2 development outcome uses a model fitted without that task. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { abilityPrior, extractTaskFeatures, updateAbility, type ModelAbility } from '../../src/agents/provider-selector-irt.js';
import { selectChildProviderV2, pairKey, type RoutingPreferences, type ConditionalSuccess } from '../../src/agents/provider-selector-v2.js';
import { classifyChildTask } from '../../src/agents/provider-selector.js';
import { ModelRegistry, modelRegistryEntryToModelInfo } from '../../src/llm/model-registry.js';
import { resolveRegisteredModelCatalogEntry } from '../../src/llm/registry/model-catalog.js';
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from '../../src/session/cost.js';
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw Error('calibrate input output');
const inputText = readFileSync(inputPath,'utf8');
const input = JSON.parse(inputText);
if (input.tasks.some((t:any)=>t.split!=='calibration') || input.records.some((r:any)=>r.split!=='calibration')) throw Error('Holdout in calibration input');
const registry = new ModelRegistry({config:{},metadata:{env:{}}});
export function candidates(raw:any[]) { return raw.filter(c=>c.connected).map(c=>{
 const pair={provider:c.provider,model:c.model}; const info=modelRegistryEntryToModelInfo(registry.resolveSync(pair));
 const entry=resolveRegisteredModelCatalogEntry(pair); const rates=resolveModelCostEntry(pair,DEFAULT_MODEL_COSTS);
 return {...pair,connected:c.connected,allowed:c.allowed,billingSource:c.billingSource,
 supportsToolUse:info.supportsToolUse!==false&&entry?.supportsToolUse!==false&&(info.supportsToolUse===true||entry?.supportsToolUse===true),
 supportsVision:entry?.inputModalities.includes('image')===true, supportsReasoning:info.supportedReasoningLevels.some(x=>x!=='none'),
 contextWindow:info.contextWindow,maxOutputTokens:info.maxOutputTokens,...(rates?{cost:rates.entry}:{})};
}); }
const cs=candidates(input.candidates.candidates);
const tasks=input.tasks;
const parent=input.candidates.baselines.fixed_parent;
const records=new Map<string,any>();
for(const r of input.records) if(r.arm==='matrix') {const key=r.taskId+'|'+r.provider+'/'+r.model;if(!records.has(key)) records.set(key,r);}
const passed=(r:any)=>r?.grade?.passed===true || r?.grade?.pass===true;
function fit(exclude:string|undefined) {
 const abilities=new Map<string,ModelAbility>(); const aggregates=new Map<string,any>();
 for(const t of tasks) if(t.id!==exclude) {
  const features=extractTaskFeatures(t.prompt,false); const kind=classifyChildTask(t.prompt).kind;
  for(const c of cs) {
   const r=records.get(t.id+'|'+pairKey(c));if(!r)continue;
   const k=pairKey(c)+'|'+features.skill;const prior=abilities.get(k)??abilityPrior(c.provider,c.model,features.skill);
   if(!r.error) abilities.set(k,updateAbility(prior,features,passed(r)));
   const ak=pairKey(c)+'|'+kind;const a=aggregates.get(ak)??{provider:c.provider,model:c.model,taskKind:kind,latencySamples:0,latencyTotalMs:0,attempts:0,infrastructureFailures:0};
   a.attempts++;a.infrastructureFailures+=Number(!!r.error);
   if(Number.isFinite(r.latencyMs)){a.latencySamples++;a.latencyTotalMs+=r.latencyMs;}aggregates.set(ak,a);
  }
 }
 const conditional:ConditionalSuccess[]=[];
 for(const c of cs)for(const d of cs)if(pairKey(c)!==pairKey(d)) {
  let failures=0,recovered=0;
  for(const t of tasks)if(t.id!==exclude) {
   const a=records.get(t.id+'|'+pairKey(c)),b=records.get(t.id+'|'+pairKey(d));
   if(a&&!a.error&&b&&!b.error&&!passed(a)){failures++;recovered+=Number(passed(b));}
  }
  conditional.push({first:pairKey(c),second:pairKey(d),failures,recovered});
 }
 return {abilities:[...abilities.values()],outcomes:{aggregates:[...aggregates.values()],health:[]},conditional};
}
function select(t:any,fit:any,config:any) {
 const features=extractTaskFeatures(t.prompt,false);const labels=classifyChildTask(t.prompt);
 const task={...labels,requiresTools:false,inputTokens:Math.ceil(Buffer.byteLength(input.candidates.systemPrompt+'\n'+t.prompt)/3),outputTokens:4096,expectedModelCalls:1,maxCostUsd:0.05};
 return selectChildProviderV2({task,features,parent,candidates:cs,abilities:config.learn?fit.abilities:[],
 outcomes:config.learn?fit.outcomes:{aggregates:[],health:[]},preferences:config.preferences,
 ...(config.verify?{verification:{available:true as const,retrySafe:true,costUsd:0,latencyMs:1,targetQuality:config.target,conditional:fit.conditional}}:{}),nowMs:0});
}
const configs:any[]=[{name:'parent_first_cold',learn:false,verify:false,preferences:{cost:'balanced'}},
 {name:'irt',learn:true,verify:false,preferences:{cost:'balanced'}}];
for(const target of [0.65,0.7,0.75,0.8,0.85,0.9,0.95])for(const cost of ['quality','balanced','economy'])configs.push({name:`cascade_${target}_${cost}`,learn:true,verify:true,target,preferences:{cost}});
const fits=new Map(tasks.map((t:any)=>[t.id,fit(t.id)]));
const trials=configs.map(config=>{
 const rows=tasks.map((t:any)=>{
  const decision=select(t,fits.get(t.id),config);const attempted:any[]=[];
  const chain=decision.cascade?.candidates??(decision.selected?[decision.selected]:[]);
  for(const c of chain){const r=records.get(t.id+'|'+pairKey(c));if(!r)break;attempted.push(r);if(passed(r))break;}
  return {taskId:t.id,passed:attempted.length>0&&passed(attempted.at(-1)),costUsd:attempted.reduce((a,r)=>a+(r.costUsd??0),0),
   latencyMs:attempted.reduce((a,r)=>a+(r.latencyMs??0),0),covered:attempted.length>0,mode:decision.mode,
   models:attempted.map(r=>r.provider+'/'+r.model),requestIds:attempted.map(r=>r.requestId),decision};
 });
 return {config,passed:rows.filter((r:any)=>r.passed).length,costUsd:rows.reduce((a:number,r:any)=>a+r.costUsd,0),coverage:rows.filter((r:any)=>r.covered).length,rows};
});
const orRows=input.records.filter((r:any)=>r.arm==='openrouter_restricted');const targetPass=orRows.filter(passed).length;
const viable=trials.filter(t=>t.coverage===28&&t.passed>=targetPass&&t.config.learn&&t.config.verify).sort((a,b)=>a.costUsd-b.costUsd||b.config.target-a.config.target||a.config.name.localeCompare(b.config.name));
const chosen=viable[0]??trials.filter(t=>t.config.learn).sort((a,b)=>b.passed-a.passed||a.costUsd-b.costUsd)[0];
const result={inputSha256:createHash('sha256').update(inputText).digest('hex'),method:'leave-one-task-out calibration only; grid declared in source before holdout scoring',
 parent,candidates:cs,chosen:chosen.config,fit:fit(undefined),trials,targetPass,holdoutUsed:false};
writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({chosen:chosen.config,calibrationTarget:targetPass,trials:trials.map(({config,passed,costUsd,coverage})=>({name:config.name,passed,costUsd,coverage}))},null,2));
