import fs from 'node:fs';
import {createHash} from 'node:crypto';

export const FILE_LIMIT=256*1024*1024;
export const MANIFEST_LIMIT=16*1024*1024;
export const CHUNK_BYTES=64*1024;
const metadata=['dev','ino','size','mtimeNs','ctimeNs'];
const same=(a,b)=>metadata.every(key=>a[key]===b[key]);
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

function scan(path,expected,max,collect,io){
  if(!validHash(expected)||!Number.isSafeInteger(max)||max<1||max>FILE_LIMIT)
    throw new Error('verification_arguments_invalid');
  const fd=io.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const before=io.fstatSync(fd,{bigint:true});
    if(!before.isFile()||typeof before.size!=='bigint'||before.size<0n||before.size>BigInt(max))
      throw new Error('not_bounded_regular');
    const length=Number(before.size),hash=createHash('sha256'),parts=[];
    const buffer=Buffer.allocUnsafe(CHUNK_BYTES);
    let count=0;
    while(count<length){
      const requested=Math.min(buffer.length,length-count);
      const got=io.readSync(fd,buffer,0,requested,count);
      if(!Number.isInteger(got)||got<1||got>requested)throw new Error('artifact_short_or_invalid_read');
      const bytes=buffer.subarray(0,got);hash.update(bytes);
      if(collect)parts.push(Buffer.from(bytes));
      count+=got;
    }
    // A file that grew after the first fstat is not accepted by hashing a prefix.
    if(io.readSync(fd,buffer,0,1,count)!==0)throw new Error('artifact_grew');
    const after=io.fstatSync(fd,{bigint:true}),named=io.lstatSync(path,{bigint:true});
    if(!after.isFile()||!named.isFile()||!same(before,after)||!same(before,named))
      throw new Error('artifact_changed');
    if(hash.digest('hex')!==expected)throw new Error('artifact_digest_mismatch');
    return collect?Buffer.concat(parts,count):Object.freeze({bytes:count,sha256:expected});
  } finally {io.closeSync(fd);}
}

// Test-only io injection permits large logical-file tests without disk artifacts.
// Real invocation uses fs and never accepts an IO override from the selection.
export function verifyFile(path,expected,io=fs){return scan(path,expected,FILE_LIMIT,false,io);}
export function readPinnedBytes(path,expected,max=MANIFEST_LIMIT,io=fs){
  if(max>MANIFEST_LIMIT)throw new Error('buffer_limit_exceeded');
  return scan(path,expected,max,true,io);
}
