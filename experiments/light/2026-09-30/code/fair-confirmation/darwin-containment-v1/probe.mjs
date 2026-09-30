// Root-owned, local-only platform diagnostic. No Core/client/model is launched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if(process.platform!=='darwin')throw new Error('darwin_required');
const here=path.dirname(fileURLToPath(import.meta.url));
const root=fs.mkdtempSync('/private/tmp/light-darwin-containment-');
fs.chmodSync(root,0o700);
fs.mkdirSync(path.join(root,'sockets'),{mode:0o700});
// Syntax is source-backed by Core sandbox/engine/seatbelt.ts unixSocketPolicy.
// This diagnoses network containment only, not filesystem/process isolation.
const profile='(version 1) (allow default) (deny network*) '+
  '(allow system-socket (socket-domain AF_UNIX)) '+
  '(allow network-bind (local unix-socket (subpath (param "SOCKET_ROOT")))) '+
  '(allow network-outbound (remote unix-socket (subpath (param "SOCKET_ROOT"))))';
fs.writeFileSync(path.join(root,'profile.sb'),profile,{flag:'wx',mode:0o600});
const result=spawnSync('/usr/bin/sandbox-exec',[
  '-D',`SOCKET_ROOT=${path.join(root,'sockets')}`,'-p',profile,
  process.execPath,path.join(here,'child.mjs'),root,
],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,LANG:'C',LC_ALL:'C'},
  encoding:'utf8',timeout:25000,maxBuffer:64*1024});
const record={schema:1,platform:os.platform(),node:process.version,root,
  profile_sha256:crypto.createHash('sha256').update(profile).digest('hex'),
  child_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(here,'child.mjs'))).digest('hex'),
  status:result.status,signal:result.signal,error_code:result.error?.code??null,
  stdout:result.stdout??'',stderr:result.stderr??'',paid_calls:0};
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(record));
process.exitCode=result.status===0&&!result.error?0:1;
