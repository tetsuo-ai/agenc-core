// One genuine ordinary-CLI task, using the existing foreground companion.
// Run ONLY in root's reviewed non-root --network=none container with an outer
// 180s watchdog. This script never grants network access or production spend.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {need,sha,hash,readJson,verifyFiles,inspect,canonical,absent,save,writeNew,fileId,offlineLinux} from './io.mjs';

const SOURCE='403da04398b55e51d1f4e8814f9a70957b0db5ef';
const BUILD='38d63e586a92c4da8b1e51b31d46f74ee359a55a';
const TASK='Say Done. Do not invoke any tool.';
const OBSERVER='8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a';
const ADAPTER='fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323';
const BINDING='9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112';
const PROFILE='light-luna-44aed-source-base-v2';
const [deploymentPath,deploymentHash,...extra]=process.argv.slice(2);
need(extra.length===0,'usage_parent_deployment_hash');offlineLinux();
const d=readJson(deploymentPath,deploymentHash);
need(d.schemaVersion===1&&d.executionApproved===true&&d.sourceRevision===SOURCE&&d.buildRevision===BUILD,'reviewed_deployment_required');
const s=readJson(d.setupPath,d.setupSha256),i=s.input,p=s.paths;
need(s.schemaVersion===1&&i.executionApproved===true&&i.sourceRevision===SOURCE&&i.buildRevision===BUILD,'setup_mismatch');
need(readJson(s.inputManifestPath,s.inputManifestHash).buildRevision===BUILD,'original_selection_changed');
need(process.execPath===i.node&&JSON.stringify(fileId(s.runRoot))===JSON.stringify(s.runRootIdentity),'parent_runtime_or_root_changed');
need(i.containment?.network==='none'&&i.containment?.outerWatchdogSeconds===180&&i.containment?.ordinarySandboxRequired===true,'containment_not_selected');
verifyFiles(i.files);verifyFiles(d.files);
const here=path.dirname(fileURLToPath(import.meta.url)),fair=i.fairRoot,fixture=path.join(fair,'current-cli-observer-v1');
const selectedImport=async name=>{need(d.files[name]===inspect(name).sha256,'unselected_import');return import(pathToFileURL(name).href);};
for(const name of ['parent.mjs','child.mjs','io.mjs'])need(d.files[path.join(here,name)]===inspect(path.join(here,name)).sha256,'unselected_parent');
for(const key of ['owner','preflight','bridge'])need(d.files[d.entries?.[key]]===inspect(d.entries[key]).sha256,'unselected_entry');
need(d.cli===path.join(s.runtime,'bin/agenc')&&d.files[d.cli]===inspect(d.cli).sha256,'ordinary_cli_required');
need(hash(d.clientArtifactSha256)&&d.clientArtifactSha256===d.files[path.join(s.runtime,'dist/bin/agenc.js')],'client_artifact_pin_required');
need(d.files[i.python]===i.files[i.python]&&d.files[i.node]===i.files[i.node],'interpreter_selection_changed');
const version=JSON.parse(inspect(path.join(s.runtime,'dist/VERSION'),{collect:true}).raw);
for(const key of ['runtimeVersion','commit','shortCommit','buildTime'])need(version[key]===i.version[key],'actual_version_changed');
const tripwire=path.join(s.runtime,'tests/helpers/network-tripwire.cjs');
need(d.files[tripwire]===inspect(tripwire).sha256,'canonical_tripwire_not_pinned');
const calendar=path.join(s.runRoot,'selection/calendar.cjs');
need(d.files[calendar]===inspect(calendar).sha256,'calendar_not_pinned');
const ownerSelection=path.join(s.runRoot,'selection/owner-selection.mjs');absent(ownerSelection);
// A durable single-use marker blocks accidental repeat attempts even if a later
// phase fails. No marker, journal, hold, stop or partial artifact is removed.
save(path.join(s.runRoot,'parent-started.json'),{deploymentSha256:deploymentHash,syntheticOnly:true});
const {supervise,spawnWithLog}=await selectedImport(path.join(fixture,'parent-lifecycle.mjs'));
const {readPublisherBinding,canonicalPublisherJson}=await selectedImport(path.join(fixture,'publisher-record-parent.mjs'));
const {verifyCompatibleSources}=await selectedImport(path.join(fixture,'compatibility-selection.mjs'));
const deployedSourcePins=verifyCompatibleSources(s.runtime);
const {financialPolicyId}=await selectedImport(path.join(fair,'luna-finance-mode-v2/journal.mjs'));
const {finalizeAttempt}=await selectedImport(path.join(fair,'shared-parent-finalizer-v1/finalize.mjs'));
const envBase=home=>({PATH:path.dirname(i.node)+':/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TZ:'UTC',
  HOME:home,AGENC_HOME:home,AGENC_WORKSPACE:p.workspace,OPENAI_API_KEY:'synthetic-unused-no-provider-authority',
  AGENC_CACHE_SESSION_TAIL:'0',AGENC_OPENAI_REASONING_REPLAY:'1',
  AGENC_TEST_HERMETIC_RUN_ROOT:s.runRoot,AGENC_TEST_NETWORK_ATTEMPT_LEDGER:p['network-attempts']});
const childArgs=spec=>['--require',tripwire,'--require',calendar,path.join(here,'child.mjs'),spec.path,spec.sha256];
function ownedSpawn(register,args,env,logName,ipc,onOwned=()=>{}) {
  return spawnWithLog({openLog:()=>fs.openSync(path.join(p.logs,logName),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600),
    closeLog:fd=>fs.closeSync(fd),register:child=>{register(child);onOwned(child);},
    spawn:fd=>spawn(i.node,args,{cwd:p.workspace,env,stdio:ipc?['ignore',fd,fd,'ipc']:['ignore',fd,fd],windowsHide:true})});
}
function spec(name,value){const filename=path.join(s.runRoot,name+'.json');return {path:filename,sha256:save(filename,value)};}
function result(name){const filename=path.join(s.runRoot,name);return readJson(filename,inspect(filename,{limit:4*1024*1024}).sha256,4*1024*1024);}
let phase='preflight',lifecycle=null,adapters=null,publisher=null,ownerChild=null,taskChild=null;
let ownerClosed=false,taskClosed=false,commit=null,success=false;
try {
  const preflightSelection=path.join(s.runRoot,'selection/preflight-selection.mjs');
  const preSpec=spec('preflight-input',{role:'preflight',entry:d.entries.preflight,entrySha256:d.files[d.entries.preflight],
    selection:preflightSelection,selectionSha256:d.files[preflightSelection],result:path.join(s.runRoot,'preflight-result.json'),
    failure:path.join(s.runRoot,'preflight-failure.json'),input:{workspace:p.workspace,targetHome:p['target-home'],preflightHome:p['preflight-home'],
      configPath:s.configPath,configSha256:s.configurationSha256,fixedIso:i.fixedIso}});
  // Reuse direct-owner lifecycle solely to contain this preparation child. The
  // arm label here is an engine mode, NOT a Pi execution or comparison claim.
  const prep=await supervise({arm:'pi',expectedMessages:0,
    spawnOwner:register=>ownedSpawn(register,childArgs(preSpec),envBase(p['preflight-home']),'preflight.log',true),
    readyMs:10000,taskMs:60000,closeMs:5000,killGraceMs:2000});
  save(path.join(s.runRoot,'preflight-lifecycle.json'),prep);
  need(prep.valid&&prep.cleanup_complete,'preflight_not_cleanly_closed');
  need(fs.readdirSync(p['network-attempts']).length===0,'preflight_network_attempt');
  const prepared=result('preflight-result.json').result;
  need(prepared.producerCollections===1&&prepared.forbiddenFetches===0&&prepared.validations===0&&hash(prepared.semanticDigest)&&
    prepared.material?.task===TASK&&prepared.material?.selectedOrWireObserved===false,'independent_preparation_failed');
  need(fs.readdirSync(p['target-home']).length===0&&fs.readdirSync(p.workspace).join()==='.git'&&fs.readdirSync(path.join(p.workspace,'.git')).length===0,'target_changed_before_owner');
  // Canonical documented trust-file schema; authority is this explicitly
  // selected empty private workspace, never a copied user's trust/credentials.
  save(path.join(p['target-home'],'trusted-projects.json'),{version:1,trustedProjects:[{path:p.workspace,trustedAt:i.fixedIso}]});
  const config=inspect(s.configPath,{collect:true});need(config.sha256===s.configurationSha256,'configuration_changed');
  writeNew(path.join(p['target-home'],'config.toml'),config.raw);
  const ledgerPath=path.join(p.finance,'luna-api-ledger.jsonl'),ledger=inspect(ledgerPath,{collect:true,limit:16*1024*1024});
  need(ledger.bytes===0,'synthetic_root_not_fresh');
  const financeId=fileId(p.finance),ledgerId=fileId(ledgerPath),captureId=fileId(p.capture);
  const policyId=financialPolicyId(i.spendPolicy);
  const callbackInput={material:prepared.material,independentMaterialDigest:prepared.semanticDigest,
    protocolId:i.protocolId,financialRunId:i.runId,publicationChannelId:i.channelId,
    runDirectory:p.capture,runDirectoryIdentity:captureId,financialRoot:p.finance,
    financialInventory:{rootDev:financeId.dev,rootIno:financeId.ino,journalDev:ledgerId.dev,journalIno:ledgerId.ino,prefixBytes:0,prefixSha256:ledger.sha256},
    spendPolicy:i.spendPolicy,financialPolicyId:policyId,deployedSourcePins,clientArtifactSha256:d.clientArtifactSha256,
    configurationSha256:s.configurationSha256,pythonPath:i.python,pythonSha256:i.files[i.python],fairRoot:fair};
  const literal={inspectedProductRevision:SOURCE,platform:'linux',scope:'one-selected-main-call-fresh-empty-resources',callCap:1,
    expectedLifecycleMessages:0,acceptedCoreRoot:s.runtime,acceptedBuildTuple:version,acceptedCompanion:{deploymentSha256:deploymentHash},
    acceptedCliClosure:{deploymentSha256:deploymentHash},acceptedLinuxAdapter:{sourceRevision:SOURCE,buildRevision:BUILD},
    acceptedContainment:i.containment,acceptedIndependentMaterial:{semanticDigest:prepared.semanticDigest,workspace:p.workspace},
    selectedBindingProfile:PROFILE,acceptedInitialLayout:'independent-preflight-fresh-empty-only',acceptedObserver:OBSERVER,referenceObserverV6:OBSERVER};
  const ownerSelectionHash=writeNew(ownerSelection,'// Root-reviewed one-attempt literal; created only after owned preflight close.\nexport const EXECUTION_APPROVED=true;\nexport const selection=Object.freeze('+JSON.stringify(literal)+');\n');
  const ownerSpec=spec('owner-input',{role:'owner',entry:d.entries.owner,entrySha256:d.files[d.entries.owner],selection:ownerSelection,
    selectionSha256:ownerSelectionHash,result:path.join(s.runRoot,'owner-result.json'),failure:path.join(s.runRoot,'owner-failure.json'),
    input:{workspace:p.workspace,callbacks:callbackInput}});
  const expectedPublisher={binding_profile_id:PROFILE,protocol_id:i.protocolId,run_id:i.runId,publication_channel_id:i.channelId,
    independent_material_digest:prepared.semanticDigest,task_prompt_sha256:sha(TASK),client_artifact_sha256:d.clientArtifactSha256,
    configuration_sha256:s.configurationSha256,source_inventory_sha256:sha(canonicalPublisherJson(deployedSourcePins)),
    observer_source_sha256:OBSERVER,installed_adapter_sha256:ADAPTER,binding_source_sha256:BINDING};
  const {loadCanonicalBridge}=await selectedImport(path.join(s.runRoot,'identity/load-bridge.mjs'));
  const {createIdentityAdapters}=await selectedImport(path.join(s.runRoot,'identity/adapters.mjs'));
  const api=await loadCanonicalBridge({path:d.entries.bridge,sha256:d.files[d.entries.bridge]});
  const ownerEnv={...envBase(p['target-home']),LUNA_LEDGER_ROOT:p.finance,LUNA_RUN_DIR:p.capture,LUNA_RUN_ID:i.runId,LUNA_TASK_CALL_CAP:'1'};
  phase='ordinary_cli';
  lifecycle=await supervise({arm:'light',expectedBuild:version,expectedMessages:0,
    spawnOwner:register=>ownedSpawn(register,childArgs(ownerSpec),ownerEnv,'owner.log',true,child=>{
      ownerChild=child;child.on('close',()=>{ownerClosed=true;});
      adapters=createIdentityAdapters({api,ownedPid:child.pid,daemonHome:p['target-home'],userHome:p['target-home'],expectedBuild:version,
        requestMs:1000,operationMs:10000,readyPollMs:25,maxReadyReads:320});}),
    spawnTask:register=>ownedSpawn(register,['--require',tripwire,'--require',calendar,d.cli,'-p',TASK,'--light','--provider','openai','--model','gpt-6-luna',
      '--config',s.configPath,'--permission-mode','default'],envBase(p['target-home']),'cli.log',false,child=>{
      taskChild=child;child.on('close',()=>{taskClosed=true;});}),
    identityAdapter:{readSidecar:signal=>adapters.identityAdapter.readSidecar(signal),
      readProcessStart:(pid,signal)=>adapters.identityAdapter.readProcessStart(pid,signal),
      requestAuthenticatedIdentity:signal=>adapters.identityAdapter.requestAuthenticatedIdentity(signal)},
    requestShutdown:(bound,signal)=>adapters.requestShutdown(bound,signal),
    dispatchOwnerMessage:(message,owner)=>{
      // Expectations are selected before spawn. Read trusted publisher BEFORE
      // examining any ACK; never derive protocol/run/source expectations from it.
      publisher??=readPublisherBinding({runDirectory:p.capture,runDirectoryIdentity:captureId,expected:expectedPublisher});
      return publisher.dispatcher.dispatch(message,owner);},
    observeOutstandingOperations:()=>adapters===null||adapters.state().outstanding,
    observeJournalQuiescence:()=>ownerClosed&&taskClosed&&!fs.existsSync(path.join(p.finance,'luna-api-admission.lock')),
    readyMs:15000,taskMs:60000,stopMs:5000,closeMs:5000,killGraceMs:2000});
  save(path.join(s.runRoot,'owned-lifecycle.json'),{...lifecycle,projection:lifecycle.observeLifecycle()});
  // A missing ACK cannot delete an attempt. Try the independently checked
  // publisher after closure, then pass the actual (possibly empty) ACK array.
  if(!publisher)publisher=readPublisherBinding({runDirectory:p.capture,runDirectoryIdentity:captureId,expected:expectedPublisher});
  const publication=publisher.dispatcher.finish();
  save(path.join(p.capture,'all-acks.json'),publication.acknowledgments);
  const closure=lifecycle.observeLifecycle(),record=publisher.record;
  need(ownerChild&&taskChild&&closure.daemon_identity_sha256,'missing_actual_identity');
  let ownerResult=null;try{ownerResult=result('owner-result.json').result;}catch{/* missing return cannot erase settled charges */}
  const evidence=ownerResult?.foreground?.evidence;
  const observedClean=lifecycle.valid&&ownerResult?.foreground?.exitCode===0&&evidence?.selected===true&&evidence.fetchEntered===true&&
    evidence.failed===false&&evidence.closed===true&&evidence.managedRequestId===record.managed_request_id&&evidence.dispatch!==null&&
    ownerResult.callbacks?.published===true&&ownerResult.callbacks.fetched===true&&ownerResult.callbacks.failed===false&&
    fs.readdirSync(p['network-attempts']).length===0&&!fs.existsSync(path.join(p.finance,'luna-api-stop.json'));
  phase='finalize';
  commit=finalizeAttempt({directory:p.capture,directoryIdentity:captureId,ledgerPath,ledgerIdentity:ledgerId,
    expected:{run_id:i.runId,root_turn_id:record.root_turn_id,client:'light',binding_profile_id:PROFILE,protocol_id:i.protocolId,channel_id:i.channelId,
      financial_policy_id:policyId,observer_source_sha256:OBSERVER,installed_adapter_sha256:ADAPTER,binding_source_sha256:BINDING,
      binding_contract_sha256:record.contract_sha256,task_prompt_sha256:sha(TASK),parent_source_sha256:d.files[fileURLToPath(import.meta.url)],
      finalizer_source_sha256:d.files[path.join(fair,'shared-parent-finalizer-v1/finalize.mjs')],owner_pid:ownerChild.pid,task_pid:taskChild.pid,
      daemon_identity_sha256:closure.daemon_identity_sha256},acknowledgments:publication.acknowledgments,
    outcome:{normal_exit:observedClean,timed_out:closure.owner.timed_out||closure.task.timed_out,budget_stopped:fs.existsSync(path.join(p.finance,'luna-api-stop.json')),
      code_artifact_pass:null,planning_required:false},observeLifecycle:lifecycle.observeLifecycle});
  const inventory=JSON.parse(commit.inventoryBytes);
  success=observedClean&&commit.cleanCommitSha256!==null&&inventory.accounting?.calls?.length===1&&publication.acknowledgments.length===1;
  save(path.join(s.runRoot,'finalizer-return.json'),{attemptCommitSha256:commit.attemptCommitSha256,cleanCommitSha256:commit.cleanCommitSha256});
} catch {
  // Existing supervise owns every started child. Unexpected pre/post-phase
  // failures remain failures, with all logs/holds/artifacts retained unchanged.
  success=false;
} finally {
  const closure=lifecycle?.observeLifecycle()??null;
  const accountingFile=path.join(p.finance,'luna-api-ledger.jsonl');
  let ledgerSha256=null;try{ledgerSha256=inspect(accountingFile,{limit:16*1024*1024}).sha256;}catch{}
  save(path.join(s.runRoot,'result.json'),{schemaVersion:1,kind:'linux-ordinary-cli-one-fake-response',success,phase,
    sourceRevision:SOURCE,buildRevision:BUILD,client:'light',paid:false,syntheticFinancialRoot:true,
    ownerPid:ownerChild?.pid??null,taskPid:taskChild?.pid??null,closure,ledgerSha256,
    attemptCommitSha256:commit?.attemptCommitSha256??null,cleanCommitSha256:commit?.cleanCommitSha256??null,
    finalPanelReady:false});
  adapters?.close();
}
console.log(JSON.stringify({success,runRoot:s.runRoot,phase,paid:false,finalPanelReady:false}));
process.exitCode=success?0:1;
// Outer container watchdog remains required for unconfirmed closure or pending
// canonical operations. No PID-file signalling, cleanup deletion, or retry.
