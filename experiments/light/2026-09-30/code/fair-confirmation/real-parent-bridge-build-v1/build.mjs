// Root-owned, explicit one-shot companion build. Never calls Core's dist builder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, lstat, readlink, realpath, symlink } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const [coreArg, adaptersArg, provenanceArg, outputArg] = process.argv.slice(2);
assert(coreArg && adaptersArg && provenanceArg && outputArg, 'four explicit paths required');
const core=await realpath(coreArg), adapters=await realpath(adaptersArg), output=resolve(outputArg);
const runtime=join(core,'runtime');
const revision='ec45a1e49a6e563391830b07ff54ac483bed5180';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha=async p=>hash(await readFile(p));
assert.equal(process.platform,'linux');
assert.equal(process.version,'v26.5.0');
assert.deepEqual(process.execArgv,[], 'no preload/loader or alternate conditions');
for(const name of ['NODE_OPTIONS','NODE_PATH','ESBUILD_BINARY_PATH']) assert(!process.env[name],name);
assert.equal(execFileSync('git',['-C',core,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),revision);
assert.equal(execFileSync('git',['-C',core,'status','--porcelain'],{encoding:'utf8'}).trim(),'');
const canonicalOutput=join(await realpath(dirname(output)),basename(output));
assert.equal(output,canonicalOutput,'output ancestors must be canonical');
assert(!canonicalOutput.startsWith(core+'/') && canonicalOutput!==core, 'companion output must be separate');
assert.equal(await sha(provenanceArg),'82bdb120c4a7440bf6a3f832b0520ab0eabdcea7578b6110ca25059778a40745');
const provenance=JSON.parse(await readFile(provenanceArg,'utf8'));
assert.equal(provenance.sources.treatment.commit,revision);
const pins={
  'canonical-bridge.ts':'24226523569f5de7f3acf7848375222cf45d4a3b9320029c8e476273cf0d1ff9',
  'pins.mjs':'a6036f166327d32112650f24e1df8c4bbeea4c2b021b4c9d62141d0e70461a1a',
};
for(const [p,h] of Object.entries(pins)) assert.equal(await sha(join(adapters,p)),h,p);
const {SOURCE_PINS}=await import(pathToFileURL(join(adapters,'pins.mjs')).href);
const configPins={
  'runtime/build.config.ts':'b34f5c7fa761269447aa645385380c883574b436fcb096b45c398d872c702558',
  'runtime/scripts/build-runtime.mjs':'c2b64c66c44abf13b6203237b6d1341ac5f70b80686089959c47bef11b956aec',
  'runtime/tsconfig.bundle.json':'ae3c771a0aff86f224b5acc5ab1e83d732fb27af736d21ea613298bc000c14bc',
  'runtime/src/build/feature.ts':'ac2e0d25f8f5af58f32ec2ea339aabc720b07f5ff9754691573a46ec40438ed9',
};
for(const [p,h] of Object.entries({...SOURCE_PINS,...configPins})) assert.equal(await sha(join(core,p)),h,p);
async function verifyFrozenDist() {
  const files=['runtime/bin/agenc'];
  async function visit(path) {
    for(const item of await readdir(path,{withFileTypes:true})) {
      const p=join(path,item.name);
      if(item.isDirectory()) await visit(p);
      else {assert(item.isFile(),'unexpected nonregular dist node');files.push(relative(core,p));}
    }
  }
  await visit(join(runtime,'dist'));
  assert.deepEqual(files.sort(),Object.keys(provenance.sources.treatment.build_files).sort(),'exact historical dist file set');
  for(const [p,h] of Object.entries(provenance.sources.treatment.build_files)) {
    assert(!isAbsolute(p) && !p.split('/').includes('..'));
    assert.equal(await sha(join(core,p)),h,p);
  }
}
await verifyFrozenDist();
const version=JSON.parse(await readFile(join(runtime,'dist/VERSION'),'utf8'));
assert.equal(version.commit,revision); assert.equal(version.runtimeVersion,'0.18.0');
assert.equal(version.buildTime,'2026-09-30T02:05:54.472Z');
await mkdir(output,{recursive:false,mode:0o700}); // Existing output is never reused.
const save=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
await save('selection.json',{revision,version,core,adapters,pins,configPins,
  provenanceSha256:await sha(provenanceArg),node:process.version,nodeSha256:await sha(process.execPath),
  lockSha256:await sha(join(core,'package-lock.json')),builderSha256:await sha(new URL(import.meta.url))});

const require=createRequire(join(runtime,'package.json'));
const {build,transform,version:esbuildVersion}=require('esbuild');
const configSource=await readFile(join(runtime,'build.config.ts'),'utf8');
const transformed=await transform(configSource,{format:'esm',loader:'ts',platform:'node',target:'node26'});
const configPath=join(output,'reviewed-build-config.mjs');
await writeFile(configPath,transformed.code,{flag:'wx',mode:0o600});
// Importing configuration reads source/package files; no compile/copy hooks run.
process.env.AGENC_RUNTIME_ROOT=runtime;
process.env.AGENC_BUILD_TIME=version.buildTime;
const {default:config}=await import(pathToFileURL(configPath).href);
const pluginNames=config.esbuildPlugins.map(p=>p.name);
assert.deepEqual(pluginNames,['agenc-feature-flag-inline','agenc-bare-src-alias',
  'agenc-optional-external','agenc-known-missing-optional-external','agenc-runtime-assets']);
// The last plugin writes frozen dist in onEnd. Explicitly exclude it; preserve
// the four canonical source-resolution/feature plugins and do not invoke hooks.
const options={absWorkingDir:runtime,bundle:true,format:'esm',platform:'node',
  target:config.target,tsconfig:join(runtime,'tsconfig.bundle.json'),
  entryPoints:[join(adapters,'canonical-bridge.ts')],outfile:join(output,'canonical-bridge.mjs'),
  splitting:false,sourcemap:true,metafile:true,logLevel:'warning',
  external:[...new Set(config.external.flatMap(x=>[x,...(x.endsWith('/*')?[]:[`${x}/*`])]))],
  plugins:config.esbuildPlugins.slice(0,-1),banner:{},loader:{},
};
config.esbuildOptions(options);
options.alias={...options.alias,'agenc-reviewed':join(runtime,'src')};
const result=await build(options);
await save('metafile.json',result.metafile);
const sourceFiles={};
for(const input of Object.keys(result.metafile.inputs)) {
  assert(!input.startsWith('<'),'unexpected virtual input');
  const selected=await realpath(resolve(runtime,input));
  assert(selected.startsWith(core+'/') || ['canonical-bridge.ts','pins.mjs'].some(p=>selected===join(adapters,p)),
    'metafile input escapes selected sources');
  sourceFiles[input]={canonical:selected,sha256:await sha(selected)};
}
const externalImports=[...new Set(Object.values(result.metafile.outputs).flatMap(o=>o.imports.filter(i=>i.external).map(i=>i.path)))].sort();
await symlink(join(core,'node_modules'),join(output,'node_modules'),'dir');
// Inventory the actual dependency tree, preserving symlinks and following their
// canonical targets once. Hashes only: never print dependency contents/env.
const dependencyFiles={},seen=new Set();
async function inventory(path) {
  const stat=await lstat(path);
  if(stat.isSymbolicLink()) {
    const target=await readlink(path),canonical=await realpath(path);
    dependencyFiles[path]={symlink:target,canonical};
    assert(canonical===core || canonical.startsWith(core+'/'),'dependency escapes frozen checkout');
    await inventory(canonical); return;
  }
  if(seen.has(path)) return; seen.add(path);
  if(stat.isDirectory()) {for(const name of (await readdir(path)).sort()) await inventory(join(path,name));}
  else if(stat.isFile()) dependencyFiles[path]={sha256:await sha(path),bytes:stat.size};
  else throw new Error('unsupported dependency node');
}
await inventory(join(core,'node_modules'));
let nestedDependencies=false;
try {await lstat(join(runtime,'node_modules')); nestedDependencies=true;}
catch(error) {if(error?.code!=='ENOENT') throw error;}
if(nestedDependencies) await inventory(join(runtime,'node_modules'));
// Resolve-only helper uses ESM conditions from the output's own directory; no
// target package is imported/executed. Also record banner require() resolution.
const resolverPath=join(output,'external-resolution.mjs');
await writeFile(resolverPath,'export const resolved = '+JSON.stringify(externalImports)+
  '.map(specifier => { try { return {specifier,url:import.meta.resolve(specifier)}; } '+
  'catch { return {specifier,unresolved:true}; } });\n',{flag:'wx',mode:0o600});
const {resolved:externalResolution}=await import(pathToFileURL(resolverPath).href);
const companionRequire=createRequire(join(output,'canonical-bridge.mjs'));
const frozenRequire=createRequire(join(runtime,'dist','canonical-resolution-origin.mjs'));
const frozenEsm=JSON.parse(execFileSync(process.execPath,['--input-type=module','--eval',
  'console.log(JSON.stringify('+JSON.stringify(externalImports)+'.map(specifier=>{try{return {specifier,url:import.meta.resolve(specifier)}}catch{return {specifier,unresolved:true}}})))'],
  {cwd:join(runtime,'dist'),encoding:'utf8',env:{PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'production'}}));
for(const row of externalResolution) {
  try {row.requireTarget=companionRequire.resolve(row.specifier);} catch {row.requireUnresolved=true;}
  row.frozenEsm=frozenEsm.find(x=>x.specifier===row.specifier);
  try {row.frozenRequireTarget=frozenRequire.resolve(row.specifier);} catch {row.frozenRequireUnresolved=true;}
  assert.equal(row.url,row.frozenEsm.url,'ESM external differs from frozen runtime');
  assert.equal(row.requireTarget,row.frozenRequireTarget,'require external differs from frozen runtime');
  for(const target of [row.url,row.requireTarget].filter(Boolean)) {
    if(target.startsWith('node:') || (!target.startsWith('file:') && !isAbsolute(target))) continue;
    const selected=await realpath(target.startsWith('file:')?fileURLToPath(target):target);
    assert(selected.startsWith(core+'/'),'external target escapes frozen checkout');
    assert(dependencyFiles[selected]?.sha256,'resolved external absent from dependency inventory');
  }
}
await save('external-resolution.json',externalResolution);
assert(externalResolution.every(r=>!r.unresolved&&!r.requireUnresolved),'unresolved external needs explicit review');
// Check dist remained exactly the previously timed build after companion hooks.
await verifyFrozenDist();
await save('closure.json',{sourceFiles,externalImports,externalResolution,dependencyFiles,
  esbuildVersion,plugins:options.plugins.map(p=>p.name),defines:options.define,
  nodeOptions:process.execArgv,environmentKeys:['AGENC_RUNTIME_ROOT','AGENC_BUILD_TIME'],
  bridgeSha256:await sha(join(output,'canonical-bridge.mjs')),
  sourceMapSha256:await sha(join(output,'canonical-bridge.mjs.map')),
  frozenDistVerified:true,bridgeImported:false,
  limits:['static external resolution and dependency-tree inventory do not attest nonliteral dynamic loads or import-time behavior',
    'dependency/ignored workspace hashes are an observed snapshot, not independent installation attestation']});
console.log(JSON.stringify({revision,version,inputs:Object.keys(sourceFiles).length,
  dependencyNodes:Object.keys(dependencyFiles).length,externalImports,
  bridgeSha256:await sha(join(output,'canonical-bridge.mjs')),output,bridgeImported:false}));
