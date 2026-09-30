// Root-owned constrained import only. No adapter API, daemon or task is invoked.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname,join } from 'node:path';

assert.equal(process.version,'v26.5.0');
assert(process.permission,'permission mode required');
for(const scope of ['fs.write','child','worker','addons','net']) assert.equal(process.permission.has(scope),false,scope);
const [bridge,loader]=process.argv.slice(2);
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(digest(bridge),'3eb7d0488baa826d7ff5b2403543a3ff58100db4ba77215c755ec10be04da0ec');
assert.equal(digest(loader),'f32f4bc866dfd4ac33092532d4e5a1c8366adf2db799f2092eb5bf69a79470bf');
assert.equal(digest(join(dirname(loader),'pins.mjs')),'a6036f166327d32112650f24e1df8c4bbeea4c2b021b4c9d62141d0e70461a1a');
const attempts=[];
const deny=name=>(..._args)=>{attempts.push(name);throw new Error('import_capability_denied');};
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) childProcess[name]=deny('child.'+name);
net.connect=deny('net.connect');net.createConnection=deny('net.createConnection');
net.Socket.prototype.connect=deny('net.Socket.connect');net.Server.prototype.listen=deny('net.Server.listen');
dgram.Socket.prototype.bind=deny('dgram.bind');dgram.Socket.prototype.send=deny('dgram.send');
dgram.Socket.prototype.connect=deny('dgram.connect');globalThis.fetch=deny('fetch');
syncBuiltinESMExports();
const names=['SIGINT','SIGTERM','SIGHUP','SIGUSR1','SIGUSR2','uncaughtException','unhandledRejection','exit','beforeExit'];
const before=Object.fromEntries(names.map(n=>[n,process.listenerCount(n)]));
const handlesBefore=process.getActiveResourcesInfo().sort();
const {loadCanonicalBridge}=await import(pathToFileURL(loader).href);
const api=await loadCanonicalBridge({path:bridge,sha256:digest(bridge)});
await new Promise(resolve=>setImmediate(resolve));
const after=Object.fromEntries(names.map(n=>[n,process.listenerCount(n)]));
const handlesAfter=process.getActiveResourcesInfo().sort();
const report={scope:'constrained_import_only_no_daemon_no_api_calls',apiNames:Object.keys(api).sort(),
  capabilitiesAttempted:attempts,listenersBefore:before,listenersAfter:after,
  handlesBefore,handlesAfter,bridgeSha256:digest(bridge),
  limitations:['permission-restricted import is not unrestricted runtime behavior or real-socket validation',
    'listener counts/resource names are observations, not identity equivalence',
    'patched common API attempts do not exhaustively count denied filesystem/worker/addon attempts']};
console.log(JSON.stringify(report));
assert.equal(Object.keys(api).length,10);assert.deepEqual(attempts,[]);assert.deepEqual(before,after);
assert.deepEqual(handlesAfter,handlesBefore);
