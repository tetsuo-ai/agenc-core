// Preserve original failure. Distinguish new-test typing from legacy Vitest-only
// relocated imports; do not suppress diagnostics or change compiler resolution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),runtime='/private/tmp/light-takeover/startup-core/runtime';
const evidence=JSON.parse(readFileSync(join(here,'result.json'),'utf8'));
const verify=()=>{for(const [p,h] of Object.entries(evidence.pins))assert.equal(createHash('sha256').update(readFileSync(join(runtime,p))).digest('hex'),h,p);};
verify();
const require=createRequire(join(runtime,'package.json')),ts=require('typescript');
const newTests=['tests/llm/wire/incomplete-tool-calls.test.ts','tests/llm/providers/openai/adapter.incomplete-identities.test.ts','tests/session/run-turn.truncated-tool-recovery.test.ts'];
const legacyTests=['tests/llm/providers/deepseek/provider.test.ts','tests/phases/stream-model.test.ts','tests/recovery/max-output-tokens.test.ts'];
const report={scope:'alternate_preserveSymlinks_diagnostic_not_clean_standard_gate',checks:[]};
function check(name,extra,preimages=false){
  const path=join(runtime,name),raw=ts.readConfigFile(path,ts.sys.readFile);
  assert(!raw.error);const config=ts.parseJsonConfigFileContent(raw.config,ts.sys,runtime,{preserveSymlinks:true,noEmit:true},path);
  const host=ts.createCompilerHost(config.options);
  if(preimages){
    const get=host.getSourceFile;
    const replacements=new Map(legacyTests.map(p=>[join(runtime,p),execFileSync('git',['show',evidence.base+':runtime/'+p],{cwd:runtime,encoding:'utf8'})]));
    host.getSourceFile=(p,version,onError,create)=>replacements.has(p)?ts.createSourceFile(p,replacements.get(p),version,true):get(p,version,onError,create);
  }
  const program=ts.createProgram([...new Set([...config.fileNames,...extra.map(p=>join(runtime,p))])],config.options,host);
  const diagnostics=[...config.errors,...ts.getPreEmitDiagnostics(program)];
  return {name,extra,preimages,diagnostics:diagnostics.map(d=>({file:d.file?.fileName.replace(runtime+'/',''),code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))};
}
report.checks.push(check('tsconfig.test-support.json',newTests));console.log('New three tests checked');
report.checks.push(check('tsconfig.m4-test-support.json',[]));console.log('Unchanged M4 gate checked');
report.checks.push(check('tsconfig.test-support.json',[...newTests,...legacyTests],true));console.log('Exact28e legacy-test preimages checked against same current dependency/source graph');
report.checks.push(check('tsconfig.test-support.json',[...newTests,...legacyTests]));
const normalized=x=>x.diagnostics.map(d=>JSON.stringify(d)).sort();
report.legacyDiagnosticsIdentical=JSON.stringify(normalized(report.checks[2]))===JSON.stringify(normalized(report.checks[3]));
verify();
writeFileSync(join(here,'type-diagnosis.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({counts:report.checks.map(c=>c.diagnostics.length),legacyDiagnosticsIdentical:report.legacyDiagnosticsIdentical}));
assert.equal(report.checks[0].diagnostics.length,0);assert.equal(report.checks[1].diagnostics.length,0);assert.equal(report.legacyDiagnosticsIdentical,true);
