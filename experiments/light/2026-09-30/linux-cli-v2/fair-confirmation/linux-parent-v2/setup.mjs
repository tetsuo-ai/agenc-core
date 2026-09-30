// SETUP ONLY. Creates one fresh, private synthetic root and literal build
// overlays. Does not import Core, build, launch a client or initialize a live ledger.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {need,sha,readJson,verifyFiles,inspect,canonical,absent,save,writeNew,syncDir,fileId,offlineLinux} from './io.mjs';
const SOURCE='403da04398b55e51d1f4e8814f9a70957b0db5ef';
const BUILD='38d63e586a92c4da8b1e51b31d46f74ee359a55a';
const VERSION={commit:BUILD,shortCommit:'38d63e586a92',buildTime:'2026-09-30T11:17:38.000Z',runtimeVersion:'0.18.0'};
const CONFIG='config_version = 2\nmodel = "gpt-6-luna"\nmodel_provider = "openai"\nreasoning_effort = "low"\nreasoning_summary = "auto"\nlight_reasoning_policy = "fixed"\nmax_output_tokens = 8192\n';
const [manifestPath,manifestHash,runRoot,...extra]=process.argv.slice(2);
need(extra.length===0,'usage_setup_manifest_hash_new_root');offlineLinux();
const input=readJson(manifestPath,manifestHash);
need(input.schemaVersion===1&&input.executionApproved===true&&input.sourceRevision===SOURCE&&input.buildRevision===BUILD,'reviewed_linux_selection_required');
need(input.version&&Object.keys(input.version).sort().join()===Object.keys(VERSION).sort().join()&&
  Object.entries(VERSION).every(([key,value])=>input.version[key]===value),'version_selection_mismatch');
need(input.containment?.network==='none'&&input.containment?.outerWatchdogSeconds===180&&input.containment?.ordinarySandboxRequired===true,'containment_selection_required');
for(const name of [input.coreRoot,input.fairRoot,input.node,input.python])canonical(name);
need(process.execPath===input.node&&input.files[input.node]&&input.files[input.python],'runtime_selection_required');
need(path.isAbsolute(runRoot)&&path.join(canonical(path.dirname(runRoot)),path.basename(runRoot))===runRoot,'private_root_path_required');
need(!runRoot.startsWith(input.coreRoot+'/')&&!runRoot.startsWith(input.fairRoot+'/'),'separate_run_root_required');absent(runRoot);
need(typeof input.fixedIso==='string'&&new Date(input.fixedIso).toISOString()===input.fixedIso,'calendar_required');
for(const key of ['protocolId','runId','channelId'])need(/^[A-Za-z0-9_.-]{1,240}$/.test(input[key]??''),'identity_required');
need(input.spendPolicy?.mode==='credit_exhaustion'?Object.keys(input.spendPolicy).length===1:
  input.spendPolicy?.mode==='positive_cap'&&Object.keys(input.spendPolicy).sort().join()==='capUsd,mode'&&typeof input.spendPolicy.capUsd==='string','explicit_spend_policy_required');
verifyFiles(input.files);
const here=path.dirname(fileURLToPath(import.meta.url));
for(const name of ['setup.mjs','io.mjs','parent.mjs','child.mjs'])need(input.files[path.join(here,name)]===inspect(path.join(here,name)).sha256,'parent_source_not_selected');
const runtime=path.join(input.coreRoot,'runtime'),fixture=path.join(input.fairRoot,'current-cli-observer-v1');
const actualVersion=JSON.parse(inspect(path.join(runtime,'dist/VERSION'),{collect:true}).raw);
need(Object.entries(VERSION).every(([key,value])=>actualVersion[key]===value),'actual_version_mismatch');
fs.mkdirSync(runRoot,{mode:0o700});syncDir(path.dirname(runRoot));
for(const name of ['selection','identity','workspace','target-home','preflight-home','finance','capture','network-attempts','logs'])fs.mkdirSync(path.join(runRoot,name),{mode:0o700});
fs.mkdirSync(path.join(runRoot,'workspace/.git'),{mode:0o700});
const configPath=path.join(runRoot,'config.toml');writeNew(configPath,CONFIG);
writeNew(path.join(runRoot,'finance/luna-api-ledger.jsonl'),'');
const preflight=path.join(runRoot,'selection/preflight-selection.mjs');
writeNew(preflight,`// Explicit Linux overlay; unchanged selected inventory, no source waiver.\nimport {SOURCE_PINS,TYPESCRIPT_SHA256} from ${JSON.stringify(path.join(fixture,'preflight-selection.mjs'))};\nimport {pinnedBytes} from ${JSON.stringify(path.join(fixture,'empty-resources.mjs'))};\nexport {SOURCE_PINS,TYPESCRIPT_SHA256};\nexport const CORE=${JSON.stringify(runtime)};\nexport const SOURCE_REVISION=${JSON.stringify(SOURCE)};\nexport const PREFLIGHT_EXECUTION_APPROVED=true;\nexport function verifySelection(){for(const [name,pin]of Object.entries(SOURCE_PINS))pinnedBytes(CORE+'/'+name,pin);pinnedBytes(CORE+'/../node_modules/typescript/lib/typescript.js',TYPESCRIPT_SHA256,32*1024*1024);}\n`);
const identityBase=path.join(input.fairRoot,'real-parent-adapters-v2');
const oldPins=inspect(path.join(identityBase,'pins.mjs'),{collect:true});
need(oldPins.sha256==='eff97184774b64ba237a45040b176b58e7822b06dafaaed91a3b1dbf8e4dd8d3','identity_source_changed');
const marker=`export const SOURCE_REVISION = '${SOURCE}';`;
const text=oldPins.raw.toString('utf8');need(text.split(marker).length===2,'identity_revision_marker');
writeNew(path.join(runRoot,'identity/pins.mjs'),`// Explicit build-only compatibility: runtime/src is pinned to ${SOURCE}; VERSION is ${BUILD}.\n`+text.replace(marker,`export const SOURCE_REVISION = '${BUILD}';`));
for(const [name,pin]of [['adapters.mjs','1e1526531c9e579829e448a26ba693dffb82700056a6f95607f24a45cbac23f7'],['load-bridge.mjs','f32f4bc866dfd4ac33092532d4e5a1c8366adf2db799f2092eb5bf69a79470bf']]) {
  const found=inspect(path.join(identityBase,name),{collect:true});need(found.sha256===pin,'identity_implementation_changed');writeNew(path.join(runRoot,'identity',name),found.raw);
}
// Freeze the human calendar only; keep Date.now/monotonic timers real so no
// permission/identity/timeout loop is disabled. This is NOT a timing benchmark.
writeNew(path.join(runRoot,'selection/calendar.cjs'),`'use strict';const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[${JSON.stringify(input.fixedIso)}]));}};\n`);
const buildMap={schemaVersion:1,coreRoot:input.coreRoot,fairRoot:input.fairRoot,runRoot,
  externalRedirects:{[path.join(fixture,'selection.mjs')]:path.join(runRoot,'selection/owner-selection.mjs'),
    [path.join(fixture,'preflight-selection.mjs')]:preflight,[path.join(identityBase,'pins.mjs')]:path.join(runRoot,'identity/pins.mjs')},
  sourcePrefixRedirect:{from:'/private/tmp/light-clean-cli-validator-v2-GANyA9/source/runtime/src/',to:runtime+'/src/'}};
save(path.join(runRoot,'build-map.json'),buildMap);
save(path.join(runRoot,'setup.json'),{schemaVersion:1,inputManifestPath:manifestPath,inputManifestHash:manifestHash,input,
  runRoot,runRootIdentity:fileId(runRoot),runtime,configPath,configurationSha256:sha(CONFIG),
  paths:Object.fromEntries(['workspace','target-home','preflight-home','finance','capture','network-attempts','logs'].map(name=>[name,path.join(runRoot,name)]))});
console.log(JSON.stringify({phase:'setup_only',runRoot,buildMapSha256:inspect(path.join(runRoot,'build-map.json')).sha256,
  setupSha256:inspect(path.join(runRoot,'setup.json')).sha256,executionStarted:false}));
