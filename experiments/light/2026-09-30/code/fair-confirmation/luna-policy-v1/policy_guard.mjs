// Trusted prospective fixed-policy transport seam, no financial mutations.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const need=ok=>{if(!ok)throw new Error('Fixed request policy refused');};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function regular(filename,max) {
  need(typeof filename==='string'&&path.isAbsolute(filename));
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const info=fs.fstatSync(fd);need(info.isFile()&&info.size<=max);
    const raw=fs.readFileSync(fd);need(raw.length<=max);return raw;}
  finally{fs.closeSync(fd);}
}
export function checkFixedPolicy(meta,raw,ordinal) {
  try {
    const selection=meta.fixed_policy;
    need(selection&&typeof selection==='object'&&!Array.isArray(selection));
    need(Object.keys(selection).sort().join()===['policy_path','policy_sha256','bridge_sha256'].sort().join());
    need(digest(selection.policy_sha256)&&digest(selection.bridge_sha256));
    need(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=4*1024*1024);
    need(Number.isSafeInteger(ordinal)&&ordinal>0);
    const policy=regular(selection.policy_path,64*1024);
    need(sha(policy)===selection.policy_sha256);
    const bridge=path.join(here,'policy_bridge.py');
    // Expected bridge digest comes from immutable runner metadata. The caller
    // separately freezes this whole selected implementation before execution.
    const bridgeBytes=regular(bridge,64*1024);
    need(sha(bridgeBytes)===selection.bridge_sha256);
    need(digest(meta.binding.python_sha256)&&sha(regular(meta.binding.python_path,128*1024*1024))===meta.binding.python_sha256);
    const payload=JSON.stringify({request:raw.toString('base64'),policy:policy.toString('base64'),
      expected_sha256:selection.policy_sha256,client:meta.binding.expected.client,ordinal});
    const code=`__file__ = ${JSON.stringify(bridge)}\n`+bridgeBytes.toString('utf8');
    const child=spawnSync(meta.binding.python_path,['-I','-S','-B','-c',code],{input:payload,encoding:'utf8',
      timeout:5000,maxBuffer:4096,env:{LANG:'C.UTF-8'}});
    need(child.status===0&&child.signal===null&&!child.error&&child.stderr.length===0);
    const value=JSON.parse(child.stdout);
    need(value&&typeof value==='object'&&!Array.isArray(value));
    need(Object.keys(value).sort().join()===['policy_verified','reason','request_sha256','policy_sha256'].sort().join());
    need(value.policy_verified===true&&value.reason===null&&value.request_sha256===sha(raw)&&value.policy_sha256===selection.policy_sha256);
    return Object.freeze(value);
  } catch {throw new Error('Fixed request policy refused');}
}
