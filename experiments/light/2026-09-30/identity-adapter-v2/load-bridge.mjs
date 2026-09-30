import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_NAMES, SOURCE_PINS, SOURCE_REVISION } from './pins.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function readArtifact(path) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('bridge_not_bounded_regular');
    return await file.readFile();
  } finally {await file.close();}
}

// Dependencies are injected ONLY for synthetic tests. The real caller must
// independently select an immutable reviewed bridge hash and dependency closure.
export async function loadCanonicalBridge({path,sha256},deps={}) {
  if(typeof path!=='string'||!isAbsolute(path)||normalize(path)!==path||!path.endsWith('.mjs')||
    !/^[a-f0-9]{64}$/.test(sha256??''))throw new Error('bridge_selection_invalid');
  const read=deps.readArtifact??readArtifact;
  const load=deps.importModule??(url=>import(url));
  try {
    if(digest(await read(path))!==sha256)throw new Error();
    const module=await load(pathToFileURL(path).href);
    if(digest(await read(path))!==sha256)throw new Error();
    if(module.SOURCE_REVISION!==SOURCE_REVISION||
      Object.keys(module.SOURCE_PINS??{}).length!==Object.keys(SOURCE_PINS).length||
      !Object.entries(SOURCE_PINS).every(([key,value])=>module.SOURCE_PINS[key]===value)||
      !API_NAMES.every(name=>typeof module.api?.[name]==='function'))throw new Error();
    return Object.freeze(Object.fromEntries(API_NAMES.map(name=>[name,module.api[name]])));
  } catch {throw new Error('bridge_verification_failed');}
}
