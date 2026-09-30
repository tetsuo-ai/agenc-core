// Build does not execute Python. Keep Python pinned in setup/deployment, but
// omit that unused interpreter from the narrower builder input namespace.
// Preserve the rejected first manifest, all source pins and all setup files.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const input='/gate/build-manifest-v1.json',output='/gate/build-manifest-v2.json';
const raw=fs.readFileSync(input);
if(sha(raw)!=='be59237fa513f3807479ef7ee5ee2bda42b6cd7a0682f5212222cd1fdcf8d855')throw Error('wrong_preimage');
const manifest=JSON.parse(raw);
const python=fs.realpathSync('/usr/bin/python3');
if(!manifest.files[python]||manifest.files[python]!==sha(fs.readFileSync(python)))throw Error('python_pin_changed');
delete manifest.files[python];
const next=JSON.stringify(manifest,null,2)+'\n';
fs.writeFileSync(output,next,{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,sha256:sha(next),omittedUnusedBuildInterpreter:python}));
