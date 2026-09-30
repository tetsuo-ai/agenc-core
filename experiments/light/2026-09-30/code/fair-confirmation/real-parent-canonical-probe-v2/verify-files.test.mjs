import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {verifyFile,readPinnedBytes,FILE_LIMIT,MANIFEST_LIMIT,CHUNK_BYTES} from './verify-files.mjs';
import {validateSelection,MAX_INVENTORY_ENTRIES} from './selection.mjs';
import {SOURCE_REVISION} from '../real-parent-adapters-v1/pins.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function zeroDigest(length){const hash=createHash('sha256'),chunk=Buffer.alloc(CHUNK_BYTES);for(let n=0;n<length;n+=chunk.length)hash.update(chunk.subarray(0,Math.min(chunk.length,length-n)));return hash.digest('hex');}
function fake(length,data){
  const calls={reads:0,maxRequest:0,closed:0,opened:0},stat={dev:1n,ino:2n,size:BigInt(length),mtimeNs:3n,ctimeNs:4n,isFile:()=>true};
  const io={openSync(_path,flags){calls.opened++;assert(flags&constants.O_NOFOLLOW);return 42;},
    fstatSync(){return {...stat};},lstatSync(){return {...stat};},
    readSync(fd,buffer,offset,count,position){assert.equal(fd,42);calls.reads++;calls.maxRequest=Math.max(calls.maxRequest,count);
      const got=Math.min(count,Math.max(0,length-position));
      if(data)data.copy(buffer,offset,position,position+got);else buffer.fill(0,offset,offset+got);
      return got;},closeSync(fd){assert.equal(fd,42);calls.closed++;}};
  return {io,calls,stat};
}
test('selected148010504-byte Node and original128MiB boundary stream through bounded chunks',()=>{
  for(const length of [128*1024*1024,148010504]){
    const f=fake(length),hash=zeroDigest(length),result=verifyFile('/node',hash,f.io);
    assert.deepEqual(result,{bytes:length,sha256:hash});assert.equal(f.calls.maxRequest,CHUNK_BYTES);
    assert.equal(f.calls.closed,1);assert(f.calls.reads>2000);
  }
});
test('explicit256MiB boundary accepts; larger artifact refuses before read and closes descriptor',()=>{
  const f=fake(FILE_LIMIT);assert.equal(verifyFile('/boundary',zeroDigest(FILE_LIMIT),f.io).bytes,FILE_LIMIT);
  const large=fake(FILE_LIMIT+1);assert.throws(()=>verifyFile('/large','0'.repeat(64),large.io),/not_bounded_regular/);
  assert.equal(large.calls.reads,0);assert.equal(large.calls.closed,1);
});
test('small content and empty file hashes are exact, collected bytes unchanged',()=>{
  for(const data of [Buffer.from('synthetic exact bytes\u0000\n'),Buffer.alloc(0)]){
    const f=fake(data.length,data);assert.deepEqual(readPinnedBytes('/small',digest(data),1024,f.io),data);
  }
});
test('manifest above4MiB is collected under16MiB; oversized manifest rejected before read',()=>{
  const data=Buffer.alloc(5801285,32);data[0]=123;data[data.length-1]=125;
  const f=fake(data.length,data);assert.deepEqual(readPinnedBytes('/manifest',digest(data),MANIFEST_LIMIT,f.io),data);
  const g=fake(MANIFEST_LIMIT+1);assert.throws(()=>readPinnedBytes('/large','0'.repeat(64),MANIFEST_LIMIT,g.io),/not_bounded_regular/);
  assert.equal(g.calls.reads,0);assert.equal(g.calls.closed,1);
});
test('finite inventory cap retains all36806entries and refuses100001',()=>{
  const value={version:2,source_revision:SOURCE_REVISION,core_root:'/core',node_path:'/node',
    bridge:{path:'/bridge.mjs',sha256:'a'.repeat(64)},expected_build:{runtimeVersion:'test',commit:SOURCE_REVISION,buildTime:'test'},
    reviewed_full_closure:true,files:{'/node':'a'.repeat(64),'/bridge.mjs':'a'.repeat(64),'/core/runtime/bin/agenc':'a'.repeat(64),'/core/runtime/dist/VERSION':'a'.repeat(64)}};
  for(let i=4;i<36806;i++)value.files['/dependency/'+i]='a'.repeat(64);
  assert.equal(Object.keys(validateSelection(value).files).length,36806);
  for(let i=36806;i<=MAX_INVENTORY_ENTRIES;i++)value.files['/dependency/'+i]='a'.repeat(64);
  assert.throws(()=>validateSelection(value),/selection_invalid/);
});
test('short reads progress correctly; premature EOF and extra bytes fail closed',()=>{
  const data=Buffer.from('abcdefghij'),f=fake(data.length,data),read=f.io.readSync;
  f.io.readSync=(fd,b,o,n,p)=>read(fd,b,o,Math.min(n,2),p);
  assert.equal(verifyFile('/short-chunks',digest(data),f.io).bytes,10);
  const short=fake(10);short.io.readSync=()=>0;
  assert.throws(()=>verifyFile('/short','0'.repeat(64),short.io),/artifact_short/);assert.equal(short.calls.closed,1);
  const grew=fake(10),base=grew.io.readSync;grew.io.readSync=(fd,b,o,n,p)=>p===10?1:base(fd,b,o,n,p);
  assert.throws(()=>verifyFile('/grew',zeroDigest(10),grew.io),/artifact_grew/);assert.equal(grew.calls.closed,1);
});
test('descriptor and named path metadata changes or symlink swaps reject same bytes',()=>{
  for(const key of ['dev','ino','size','mtimeNs','ctimeNs','isFile']){
    for(const where of ['descriptor','path']){
      const f=fake(10);let calls=0;const change=()=>({...f.stat,[key]:key==='isFile'?()=>false:f.stat[key]+1n});
      if(where==='descriptor')f.io.fstatSync=()=>++calls===1?{...f.stat}:change();else f.io.lstatSync=change;
      assert.throws(()=>verifyFile('/changed',zeroDigest(10),f.io),/artifact_changed/);assert.equal(f.calls.closed,1);
    }
  }
});
test('I/O errors and digest mismatch close descriptor; no fallback reads',()=>{
  for(const fault of ['read','stat','lstat','hash']){
    const f=fake(10);
    if(fault==='read')f.io.readSync=()=>{throw new Error('io');};
    if(fault==='stat')f.io.fstatSync=()=>{throw new Error('io');};
    if(fault==='lstat')f.io.lstatSync=()=>{throw new Error('io');};
    assert.throws(()=>verifyFile('/fault','f'.repeat(64),f.io));assert.equal(f.calls.closed,1);
  }
});
test('invalid hash and oversized collection request fail before opening',()=>{
  const f=fake(1);
  assert.throws(()=>verifyFile('/file','invalid',f.io),/verification_arguments_invalid/);
  assert.throws(()=>readPinnedBytes('/file','0'.repeat(64),MANIFEST_LIMIT+1,f.io),/buffer_limit_exceeded/);
  assert.equal(f.calls.opened,0);
});
