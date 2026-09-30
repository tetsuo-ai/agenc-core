import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [control, treatment, output] = process.argv.slice(2);
const pins = ['aaf332b45d0ec7b2f6f7b6e223b5648c8bab2d6d', 'ec45a1e49a6e563391830b07ff54ac483bed5180'];
const rows = [control,treatment].map((core,index) => {
  assert.equal(spawnSync('git',['-C',core,'rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),pins[index]);
  const scratch = mkdtempSync(join(tmpdir(),'agenc-help-smoke-'));
  const result = spawnSync(process.execPath,[join(core,'runtime/bin/agenc'),'help','skills'],{
    cwd:scratch,env:{...process.env,AGENC_HOME:join(scratch,'state')},encoding:'utf8',timeout:25000});
  return {commit:pins[index],status:result.status,signal:result.signal,error:result.error?.code??null,
    stderr:result.stderr,sha256:createHash('sha256').update(result.stdout??'').digest('hex')};
});
writeFileSync(output,JSON.stringify(rows,null,2),{flag:'wx',mode:0o600});
for(const row of rows) {
  assert.equal(row.status,0);assert.equal(row.signal,null);assert.equal(row.error,null);assert.equal(row.stderr,'');
}
assert.equal(rows[0].sha256,rows[1].sha256);
console.log(JSON.stringify({matchedPairs:1,command:'help skills',rows}));
