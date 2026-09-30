import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile,lstat,readlink,realpath,mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const [base,output]=process.argv.slice(2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha=async p=>hash(await readFile(p));
assert.equal(await sha(join(base,'output/closure.json')),'3d24a78bc4f4f76cd2a8d5a7cbca0137012771c6f38bad6a6b8f2c740d6b5ff2');
const closure=JSON.parse(await readFile(join(base,'output/closure.json'),'utf8'));
for(const [path,row] of Object.entries(closure.dependencyFiles)) {
  if(row.symlink!==undefined) {
    assert((await lstat(path)).isSymbolicLink());assert.equal(await readlink(path),row.symlink);
    assert.equal(await realpath(path),row.canonical);
  } else {assert((await lstat(path)).isFile());assert.equal(await sha(path),row.sha256);}
}
assert.equal(await sha(join(base,'output/canonical-bridge.mjs')),closure.bridgeSha256);
await mkdir(output,{recursive:false,mode:0o700});
const env={PATH:'/usr/local/bin:/usr/bin:/bin',NODE_ENV:'production',HOME:'/tmp/import-home',AGENC_HOME:'/tmp/import-home/agenc',LANG:'C'};
const args=['--permission','--allow-fs-read=/work/core-converge-coldcli-v2',
  '--allow-fs-read=/work/bridge-build',join(base,'import-smoke.mjs'),join(base,'output/canonical-bridge.mjs'),
  join(base,'real-parent-adapters-v1/load-bridge.mjs')];
const result=spawnSync(process.execPath,args,{env,cwd:'/tmp',encoding:'utf8',timeout:20000,killSignal:'SIGKILL',maxBuffer:1024*1024});
const report={scope:'constrained_import_only',status:result.status,signal:result.signal,error:result.error?.code??null,
  stdout:result.stdout,stderr:result.stderr,node:process.version,args,
  scriptSha256:await sha(join(base,'import-smoke.mjs')),runnerSha256:await sha(new URL(import.meta.url)),
  closureSha256:await sha(join(base,'output/closure.json')),dependencyNodesVerified:Object.keys(closure.dependencyFiles).length};
await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(result.error,undefined);
