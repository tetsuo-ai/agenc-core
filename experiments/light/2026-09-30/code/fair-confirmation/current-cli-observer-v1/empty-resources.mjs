import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const need=(ok,reason)=>{if(!ok)throw new Error(reason);};
export function plainDirectory(name){
 const st=fs.lstatSync(name);need(st.isDirectory()&&!st.isSymbolicLink(),'resource_not_directory');
 need(fs.realpathSync(name)===name,'resource_noncanonical_path');
 return {dev:String(st.dev),ino:String(st.ino)};
}
export function absent(name){
 try{fs.lstatSync(name);}catch(error){if(error?.code==='ENOENT')return;throw new Error('resource_stat_failed');}
 throw new Error('unexpected_resource');
}
// Deliberately fresh, narrow layout; no recursive reads or secret content scans.
export function emptyResources({workspace,targetHome,preflightHome,managedRoot}){
 need(new Set([workspace,targetHome,preflightHome]).size===3,'resource_roots_overlap');
 for(const a of [workspace,targetHome,preflightHome])for(const b of [workspace,targetHome,preflightHome])
  if(a!==b)need(!a.startsWith(b+path.sep),'resource_roots_overlap');
 const identities={};
 for(const name of [workspace,targetHome,preflightHome])identities[name]=plainDirectory(name);
 need(fs.readdirSync(targetHome).length===0,'target_home_not_empty');
 need(fs.readdirSync(preflightHome).length===0,'preflight_home_not_empty');
 need(fs.readdirSync(workspace).sort().join(',')==='.git','workspace_not_empty');
 identities[path.join(workspace,'.git')]=plainDirectory(path.join(workspace,'.git'));
 need(fs.readdirSync(path.join(workspace,'.git')).length===0,'workspace_git_not_empty');
 absent(managedRoot);
 // Non-repository ancestors can supply project guidance; reject rather than
 // suppress discovery. Never read their contents.
 for(let current=path.dirname(workspace);;current=path.dirname(current)){
  for(const name of ['AGENC.md','AGENC.local.md','.agenc'])absent(path.join(current,name));
  if(path.dirname(current)===current)break;
 }
 return Object.freeze(identities);
}
export function assertTargetUnchanged({workspace,targetHome},identities){
 for(const name of [workspace,targetHome,path.join(workspace,'.git')]){
  need(JSON.stringify(plainDirectory(name))===JSON.stringify(identities[name]),'target_identity_changed');
 }
 need(fs.readdirSync(targetHome).length===0,'target_home_changed');
 need(fs.readdirSync(workspace).sort().join(',')==='.git','target_workspace_changed');
 need(fs.readdirSync(path.join(workspace,'.git')).length===0,'target_git_changed');
}
export function pinnedBytes(name,hash,max=1024*1024){
 need(Number.isSafeInteger(max)&&max>=0&&max<=32*1024*1024,'invalid_pin_bound');
 const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
 const namedBefore=fs.lstatSync(name,{bigint:true});
 need(namedBefore.isFile()&&!namedBefore.isSymbolicLink(),'invalid_pinned_file');
 const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=fs.fstatSync(fd,{bigint:true});
  need(before.isFile()&&before.size>=0n&&before.size<=BigInt(max)&&same(namedBefore,before),'invalid_pinned_file');
  // At most the initial size plus one byte is ever read, even if the file
  // grows while the descriptor is open. The extra byte detects growth.
  const size=Number(before.size), buffer=Buffer.alloc(size+1);let total=0;
  while(total<buffer.length){const count=fs.readSync(fd,buffer,total,buffer.length-total,null);if(count===0)break;total+=count;}
  const after=fs.fstatSync(fd,{bigint:true}),namedAfter=fs.lstatSync(name,{bigint:true});
  need(total===size&&after.isFile()&&namedAfter.isFile()&&!namedAfter.isSymbolicLink()&&
    same(before,after)&&same(after,namedAfter),'pinned_file_changed');
  const bytes=buffer.subarray(0,total);
  need(crypto.createHash('sha256').update(bytes).digest('hex')===hash,'pin_mismatch');
  return bytes;
 }finally{fs.closeSync(fd);}
}
