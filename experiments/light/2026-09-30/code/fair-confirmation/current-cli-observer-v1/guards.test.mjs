// Inert local-file checks only. Never imports loader, Core, bootstrap or selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {emptyResources,assertTargetUnchanged,pinnedBytes} from './empty-resources.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function layout(){
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cli-preflight-guards-'));
 fs.chmodSync(root,0o700);
 const value={root,workspace:path.join(root,'workspace'),targetHome:path.join(root,'target-home'),preflightHome:path.join(root,'preflight-home'),managedRoot:path.join(root,'absent-managed')};
 for(const dir of [value.workspace,value.targetHome,value.preflightHome,path.join(value.workspace,'.git')])fs.mkdirSync(dir,{mode:0o700});
 return value; // All roots, moved directories, and failed evidence remain.
}
test('fresh resources and exact regular pin pass; content, aliases and mismatches refuse',()=>{
 const a=layout(),before=emptyResources(a);assertTargetUnchanged(a,before);
 fs.writeFileSync(path.join(a.targetHome,'AGENC.md'),'synthetic',{flag:'wx',mode:0o600});
 assert.throws(()=>emptyResources(a),/target_home_not_empty/);
 assert.throws(()=>assertTargetUnchanged(a,before),/target_home_changed/);
 const b=layout();fs.writeFileSync(path.join(b.workspace,'extra'),'synthetic',{flag:'wx',mode:0o600});
 assert.throws(()=>emptyResources(b),/workspace_not_empty/);
 const c=layout();fs.mkdirSync(c.managedRoot);assert.throws(()=>emptyResources(c),/unexpected_resource/);
 const file=path.join(c.root,'declared');fs.writeFileSync(file,'declared',{flag:'wx',mode:0o600});
 assert.equal(pinnedBytes(file,sha('declared')).toString(),'declared');
 assert.throws(()=>pinnedBytes(file,sha('different')),/pin_mismatch/);
 const linked=path.join(c.root,'alias');fs.symlinkSync(file,linked);
 assert.throws(()=>pinnedBytes(linked,sha('declared')),/invalid_pinned_file/);
});
for(const target of ['targetHome','git-directory','git-symlink'])test(`resource identity refuses ${target} replacement`,()=>{
 const a=layout(),before=emptyResources(a),name=target==='targetHome'?a.targetHome:path.join(a.workspace,'.git');
 fs.renameSync(name,path.join(a.root,'retained-original'));
 if(target==='git-symlink'){
  const empty=path.join(a.root,'empty-target');fs.mkdirSync(empty,{mode:0o700});fs.symlinkSync(empty,name);
 }else fs.mkdirSync(name,{mode:0o700});
 assert.throws(()=>assertTargetUnchanged(a,before),/target_identity_changed|resource_not_directory/);
});
for(const mode of ['growth','truncation','same-byte-replacement'])test(`bounded pin reader refuses concurrent ${mode}`,t=>{
 const a=layout(),file=path.join(a.root,'declared'),initial=Buffer.from('declared');
 fs.writeFileSync(file,initial,{flag:'wx',mode:0o600});
 const original=fs.readSync;let once=false,total=0;
 t.mock.method(fs,'readSync',function(fd,buffer,offset,length,position){
  if(!once){once=true;
   if(mode==='growth')fs.appendFileSync(file,Buffer.alloc(1024*1024,97));
   if(mode==='truncation')fs.truncateSync(file,1);
   if(mode==='same-byte-replacement'){
    fs.renameSync(file,path.join(a.root,'retained-original'));
    fs.writeFileSync(file,initial,{flag:'wx',mode:0o600});
   }
  }
  const count=original.call(fs,fd,buffer,offset,length,position);total+=count;return count;
 });
 assert.throws(()=>pinnedBytes(file,sha(initial)),/pinned_file_changed/);
 assert.ok(total<=initial.length+1,'cannot read unbounded growth');
});
