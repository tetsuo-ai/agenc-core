// Offline root selection assembly, never imports a probe or launches a client.
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [evidenceRoot,probeRoot,approvedPinsPath,approvedPinsSha,output]=process.argv.slice(2);
const digest=b=>createHash('sha256').update(b).digest('hex');
const read=async(path,hash)=>{const b=await readFile(path);assert.equal(digest(b),hash,path);return b;};
const closure=JSON.parse(await read(join(evidenceRoot,'real-parent-bridge-build-v1/closure.json'),
  '3d24a78bc4f4f76cd2a8d5a7cbca0137012771c6f38bad6a6b8f2c740d6b5ff2'));
const build=JSON.parse(await read(join(evidenceRoot,'real-parent-bridge-build-v1/selection.json'),
  'a275433199e71130b82f1ffec097f90c0db61ff296fe878faafd8cbeb9530f74'));
assert.equal(build.revision,'ec45a1e49a6e563391830b07ff54ac483bed5180');
assert.equal(build.version.buildTime,'2026-09-30T02:05:54.472Z');
const historical=JSON.parse(await read(join(evidenceRoot,'../startup-cpu/cold-cli-ab-provenance.json'),
  '82bdb120c4a7440bf6a3f832b0520ab0eabdcea7578b6110ca25059778a40745'));
const reviewed=JSON.parse(await read(approvedPinsPath,approvedPinsSha));
const core='/work/core-converge-coldcli-v2';
const bridge='/work/bridge-build/output/canonical-bridge.mjs';
const files=Object.fromEntries(Object.entries(closure.dependencyFiles)
  .filter(([,row])=>row.sha256).map(([path,row])=>[path,row.sha256]));
for(const [path,hash] of Object.entries(historical.sources.treatment.build_files)) files[join(core,path)]=hash;
files['/usr/local/bin/node']=build.nodeSha256;
files[bridge]=closure.bridgeSha256;
for(const [path,hash] of Object.entries(reviewed)) {
  assert(!path.startsWith('/')&&!path.split('/').includes('..'),'reviewed relative file path');
  await read(join(probeRoot,path),hash);
  files[join('/work/probes',path)]=hash;
}
const selection={version:2,source_revision:build.revision,core_root:core,node_path:'/usr/local/bin/node',
  bridge:{path:bridge,sha256:closure.bridgeSha256},expected_build:{runtimeVersion:build.version.runtimeVersion,
    commit:build.version.commit,buildTime:build.version.buildTime},reviewed_full_closure:true,files};
const bytes=Buffer.from(JSON.stringify(selection)+'\n');
assert(bytes.length<=16*1024*1024);assert(Object.keys(files).length<=100000);
await writeFile(output,bytes,{flag:'wx',mode:0o600});
console.log(JSON.stringify({selectionSha256:digest(bytes),bytes:bytes.length,files:Object.keys(files).length,
  scope:'root-reviewed snapshot for network-none canonical daemon probes only'}));
