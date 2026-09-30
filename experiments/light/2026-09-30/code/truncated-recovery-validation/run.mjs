// Root-owned frozen-dirty-tree checks. Not a standard clean/Linux/build gate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const runtime = '/private/tmp/light-takeover/startup-core/runtime';
const pins = {
  'src/llm/types.ts': 'a6bb18fbe436d86383d7b65f2c65ecf38e7d4e2d011b776d439fc0e9070b9e03',
  'src/llm/wire/incomplete-tool-calls.ts': 'd5cd9331e4d02573e6fda8484a689673c7d2f7637b2b136d4d750b6244cf793c',
  'src/llm/wire/chat-completions.ts': '0f49d3c69e56d3d43f43b73f529c77fb922268fddd7400a6f37ba8c32a8cc758',
  'src/llm/wire/responses-openai.ts': 'aa3b2d13d7790163d29d025413ca60d5bf84b81d8f04b8c800b73a798ebd7732',
  'src/llm/providers/openai/adapter.ts': '788d803541ecc2693d8084ff23913077e987af367149c2fe107510c20c80999f',
  'src/phases/stream-model.ts': '552529755f1cfb50729c590098be8ad99c10b7ea8cd5982695bd9b851d4f48b4',
  'src/session/turn-state.ts': '116e5d9a1baff0a32688bea9cffe8f9c96b8d535d4d665766eed7fe4f4fb9a75',
  'src/recovery/max-output-tokens.ts': '6c5d082a4c02adcaa66efc9e9f666105379c3b2f6ce3984c36cb875b2309b827',
  'tests/llm/wire/incomplete-tool-calls.test.ts': 'e295aa221228654efb54319ed36d03e96f48225055153aa52d167992e7005d25',
  'tests/llm/providers/openai/adapter.incomplete-identities.test.ts': '9db01eccb2d7bfdda2cf4b7b9982603d3f307fd46023bc7f94e39f43dc194d87',
  'tests/llm/providers/deepseek/provider.test.ts': '8c938f3d83d1f49b5f021b0f5e0015063f92485ef962c7d788d59c4e3724cde9',
  'tests/phases/stream-model.test.ts': '0ab8e66d05037b6a107759037ad2b4c52dd9e9b67e517d93092c26943fb92d09',
  'tests/recovery/max-output-tokens.test.ts': 'cbba0816a39400254b8ec04081ee8b155df84d7d3450fb6502f103ed1d8e5b00',
  'tests/session/run-turn.truncated-tool-recovery.test.ts': 'dbbeaf1464ab6a705765cc185efb87a1bce0674b99d1c9bcaf326f85d8e2d722',
};
const verify = () => {
  for (const [p, expected] of Object.entries(pins)) assert.equal(createHash('sha256').update(readFileSync(join(runtime,p))).digest('hex'), expected, p);
};
assert.equal(process.versions.node,'26.8.1');
closeSync(openSync(join(here,'started'),'wx',0o600));
const report = { base:'28e21d055fa052f0f27810bd65f76fd8f6b1ce15', pins,
  scope:'local_frozen_recovery_tests_and_alternate_symlink_typechecks', steps:[], status:'running' };
const save = () => writeFileSync(join(here,'result.json'),JSON.stringify(report,null,2)+'\n');
try {
  verify(); save();
  const log = openSync(join(here,'tests.log'),'wx',0o600);
  const args = ['scripts/run-hermetic-vitest.mjs','--require-zero-skips','run',
    'tests/llm/providers/openai','tests/llm/providers/deepseek/provider.test.ts',
    'tests/llm/wire/incomplete-tool-calls.test.ts','tests/llm/wire/responses-openai',
    'tests/recovery/max-output-tokens.test.ts','tests/phases/stream-model.test.ts',
    'tests/session/run-turn.truncated-tool-recovery.test.ts','tests/session/run-turn.responses-terminal-safety.test.ts',
    'tests/session/run-turn.light-write-admission.test.ts','tests/session/light-reasoning-policy.test.ts',
    '--maxWorkers=1','--reporter=dot'];
  const env={PATH:dirname(process.execPath)+':/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME:process.env.HOME,LANG:'C',LC_ALL:'C',TZ:'UTC',CI:'true'};
  console.log('Running frozen 24-file affected test selection');
  let exitCode;
  try { exitCode=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:runtime,env,stdio:['ignore',log,log]});
    const timer=setTimeout(()=>child.kill('SIGKILL'),120000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);resolve(code);});
  }); } finally {closeSync(log);}
  report.steps.push({name:'hermetic-tests',exitCode,args});save();assert.equal(exitCode,0);verify();
  const require=createRequire(join(runtime,'package.json'));
  const ts=require('typescript');
  for(const [name,extra] of [['tsconfig.json',[]],['tsconfig.test-support.json',Object.keys(pins).filter(p=>p.startsWith('tests/'))],['tsconfig.m4-test-support.json',[]]]) {
    console.log('Checking '+name+' with explicit preserveSymlinks'+(extra.length?' and six recovery tests':''));
    const path=join(runtime,name),raw=ts.readConfigFile(path,ts.sys.readFile);
    assert(!raw.error);
    const config=ts.parseJsonConfigFileContent(raw.config,ts.sys,runtime,{preserveSymlinks:true,noEmit:true},path);
    const program=ts.createProgram([...new Set([...config.fileNames,...extra.map(p=>join(runtime,p))])],config.options);
    const diagnostics=[...config.errors,...ts.getPreEmitDiagnostics(program)];
    const text=ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>runtime,getNewLine:()=> '\n'});
    writeFileSync(join(here,name+'.log'),text,{flag:'wx',mode:0o600});
    report.steps.push({name,alternatePreserveSymlinks:true,extraTests:extra,diagnostics:diagnostics.length});save();
    assert.equal(diagnostics.length,0,name);verify();
  }
  report.status='passed';
} catch(error) {report.status='failed';report.error=error.message;process.exitCode=1;}
finally {report.finished=new Date().toISOString();save();console.log(JSON.stringify(report));}
