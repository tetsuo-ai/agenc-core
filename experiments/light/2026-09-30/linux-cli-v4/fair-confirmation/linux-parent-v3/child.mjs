// Single-use process wrapper. No mock Session/provider/identity or IPC ACKs.
// Parent must launch with the pinned canonical network tripwire + calendar.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {need,readJson,inspect,save} from './io.mjs';
const [specPath,specHash,...extra]=process.argv.slice(2);
need(extra.length===0&&process.platform==='linux'&&process.getuid?.()!==0&&process.connected,'owned_linux_child_required');
const spec=readJson(specPath,specHash,4*1024*1024);
need(['preflight','owner'].includes(spec.role),'invalid_child_role');
need(inspect(spec.entry).sha256===spec.entrySha256,'entry_pin_mismatch');
need(inspect(spec.selection).sha256===spec.selectionSha256,'selection_pin_mismatch');
const marker=Object.getOwnPropertyDescriptor(globalThis,Symbol.for('agenc.test.hermetic-runtime.marker'));
need(marker?.value?.version==='agenc-hermetic-network-tripwire-v1'&&marker.configurable===false&&marker.writable===false,'canonical_tripwire_required');
let phase='import';
try {
  const entry=await import(pathToFileURL(spec.entry).href);phase='call';
  if(spec.role==='preflight') {
    const controller=new AbortController();
    const result=await entry.runSelectedIndependent({...spec.input,signal:controller.signal});
    // prepareIndependent has already shut down its canonical bootstrap and
    // checked target-home/workspace identity before returning this material.
    save(spec.result,{schemaVersion:1,role:'preflight',result});
  } else {
    const result=await entry.runPreacceptedOwner(spec.input);
    save(spec.result,{schemaVersion:1,role:'owner',result});
    need(result.foreground.exitCode===0,'foreground_exit_not_zero');
  }
} catch (error) {
  // Preserve private logs and any partial accounting/captures. No raw thrown
  // value, credential, prompt or cookie is serialized in the failure report.
  const describe=(value,depth=0)=>{
    if(depth>3||!(value instanceof Error))return null;
    const frames=String(value.stack??'').slice(0,16384).split('\n').slice(1,20).flatMap(line=>{
      if(!/^\s+at /.test(line))return [];
      const m=line.match(/(?:file:\/\/)?(\/gate\/[A-Za-z0-9_./-]+):(\d+):(\d+)/);
      return m&&m[1].length<=512?[{file:m[1],line:Number(m[2]),column:Number(m[3])}]:[];
    }).slice(0,6);
    const counters=Object.getOwnPropertyDescriptor(value,'preflightDiagnostics')?.value;
    const keys=['version','deniedMetadataRequests','forbiddenFetches','validations','producerCollections'];
    const diagnostics=counters&&keys.every(k=>Number.isSafeInteger(counters[k])&&counters[k]>=0)
      ?Object.fromEntries(keys.map(k=>[k,counters[k]])):null;
    return {frames,diagnostics,...(value instanceof AggregateError?{causes:value.errors.slice(0,3).map(e=>describe(e,depth+1))}:{})};
  };
  try{save(spec.failure,{schemaVersion:1,role:spec.role,phase,failed:true,diagnostic:describe(error)});}catch{}
  process.exitCode=1;
} finally {
  if(process.connected)process.disconnect();
}
// Natural exit only. A lingering handle is a real containment failure; the
// owned parent timeout/kill/close path, not process.exit(0), handles it.
