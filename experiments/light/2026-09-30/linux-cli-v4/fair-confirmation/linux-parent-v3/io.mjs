// Local, trusted-manifest I/O only. No process or provider launch.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const need=(ok,why)=>{if(!ok)throw new Error(why);};
export const sha=raw=>createHash('sha256').update(raw).digest('hex');
export const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const canonical=name=>{need(typeof name==='string'&&path.isAbsolute(name)&&path.normalize(name)===name&&fs.realpathSync(name)===name,'canonical_path_required');return name;};
const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
export function inspect(name,{collect=false,limit=256*1024*1024}={}) {
  canonical(name);const named=fs.lstatSync(name,{bigint:true});
  need(named.isFile()&&named.size>=0n&&named.size<=BigInt(limit),'regular_file_required');
  const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const before=fs.fstatSync(fd,{bigint:true});need(same(before,named),'file_changed');
    const h=createHash('sha256'),parts=[],buffer=Buffer.alloc(65536);let total=0;
    while(total<=Number(before.size)) {
      const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(before.size)+1-total),null);
      need(Number.isSafeInteger(n)&&n>=0,'read_failed');if(n===0)break;
      total+=n;need(total<=Number(before.size),'file_grew');h.update(buffer.subarray(0,n));
      if(collect)parts.push(Buffer.from(buffer.subarray(0,n)));
    }
    need(total===Number(before.size)&&same(before,fs.fstatSync(fd,{bigint:true}))&&same(before,fs.lstatSync(name,{bigint:true})),'file_changed');
    return {sha256:h.digest('hex'),bytes:total,...(collect?{raw:Buffer.concat(parts)}:{})};
  } finally {fs.closeSync(fd);}
}
export function readJson(name,pin,limit=16*1024*1024) {
  need(hash(pin),'expected_pin_required');const found=inspect(name,{collect:true,limit});
  need(found.sha256===pin,'file_pin_mismatch');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(found.raw));
}
export function verifyFiles(files) {
  need(files&&Object.getPrototypeOf(files)===Object.prototype&&!Array.isArray(files),'inventory_required');
  const rows=Object.entries(files);need(rows.length>0&&rows.length<=100000,'inventory_size');
  for(const [name,pin]of rows)need(hash(pin)&&inspect(name).sha256===pin,'inventory_mismatch');
}
export function fileId(name){const s=fs.lstatSync(name,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};}
export function syncDir(name){const fd=fs.openSync(name,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function writeNew(name,raw){
  const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw);const fd=fs.openSync(name,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let n=0;while(n<bytes.length){const count=fs.writeSync(fd,bytes,n,bytes.length-n);need(count>0,'write_failed');n+=count;}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  syncDir(path.dirname(name));return sha(bytes);
}
export const save=(name,value)=>writeNew(name,JSON.stringify(value,null,2)+'\n');
export function absent(name){try{fs.lstatSync(name);}catch(e){if(e?.code==='ENOENT')return;throw e;}throw new Error('path_already_exists');}
export function offlineLinux(){
  need(process.platform==='linux'&&process.getuid?.()!==0,'nonroot_linux_required');
  need(fs.readdirSync('/sys/class/net').every(name=>name==='lo'),'network_namespace_not_isolated');
  for(const key of ['NODE_OPTIONS','NODE_PATH','AGENC_RUNTIME_ROOT','OPENAI_API_KEY','LUNA_CAPTURE_METADATA'])need(process.env[key]===undefined,'ambient_execution_override');
}
