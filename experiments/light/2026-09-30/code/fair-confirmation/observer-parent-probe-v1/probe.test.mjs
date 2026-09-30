// Offline composition: frozen real observer + its fake-fetch child, owned by
// the new strict parent. No current Core/Pi executable and no score capability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const fair = path.dirname(here), luna = path.join(fair, 'luna-capture-v5');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pins = {
  'luna-capture-v5/direct.mjs':'45843e8b17283c247eb9ded660a689b2952a659957d470da2589883edbd3f074',
  'luna-capture-v5/child_fixture.mjs':'12a72c86e9f9ead1befa878e8bb812ce6d3c84ebc9156841c05d23ddf6752209',
  'luna-capture-v5/synthetic_fixture.mjs':'182b9bd59eb8eb1790a7829c725a9a699005d5a4e83cff6f95e8d216319193d6',
  'luna-capture-v5/fixture_builder.py':'905dcd708fcb4291df13eabeddf174b14c1a8110147a7f75a5b5bc408b72ab72',
  'luna-capture-v5/binding_bridge.py':'d9076c9adf0f0529dd88e118a22ecefb191a5755387951c0e9f836658f840db5',
  'luna-capture-v5/publication_gate.py':'bb33193092e9ed73ac03d8c0c22bc986bc5a3310e6405dc84e7a195a4ef47772',
  'prompt-binding-v2/prompt_binding.py':'513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6',
  'stream_adapters.py':'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323',
};
for (const [name,pin] of Object.entries(pins)) assert.equal(sha(fs.readFileSync(path.join(fair,name))),pin);
// Successor lifecycle pins must be independently frozen before this fixture
// can run. No fallback to old bytes or deriving expected hashes at runtime.
const approved = JSON.parse(fs.readFileSync(path.join(here,'approved-parent.json')));
assert.equal(approved.schema_version,1);
assert.deepEqual(Object.keys(approved.files).sort(),['dispatcher.mjs','lifecycle.mjs']);
for (const [name,pin] of Object.entries(approved.files)) {
  assert.match(pin,/^[a-f0-9]{64}$/);
  assert.equal(sha(fs.readFileSync(path.join(fair,'real-parent-capture-v1',name))),pin);
}
const { supervise } = await import('../real-parent-capture-v1/lifecycle.mjs');
const { createDispatcher } = await import('../real-parent-capture-v1/dispatcher.mjs');
const { installBinding } = await import('../luna-capture-v5/synthetic_fixture.mjs');
const read = (root,name) => fs.readFileSync(path.join(root,name));
const json = (root,name) => JSON.parse(read(root,name));
const records = root => read(root,'luna-api-ledger.jsonl').toString().trim().split('\n').map(JSON.parse);

async function run(fault='none') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'observer-parent-probe-'));
  // Synthetic recipe creates both test request and expectations before child
  // execution. These historical-profile pins are NOT deployed Core provenance.
  const installed=installBinding(root,{task:'Synthetic task.',run_id:'fixture',protocol_id:'fixture-protocol',profile:'light-luna-base-v2'});
  fs.writeFileSync(path.join(root,'synthetic-request.json'),JSON.stringify(installed.fixture.body),{flag:'wx',mode:0o600});
  const meta={schema_version:5,contract:'prospective-output-capture-v5',protocol_id:'fixture-protocol',
    run_id:'fixture',root_turn_id:'root-1',route:'openai-direct',task_prompt_sha256:sha('Synthetic task.'),
    observer_source_sha256:pins['luna-capture-v5/direct.mjs'],installed_adapter_sha256:pins['stream_adapters.py'],
    installed_adapter_path:path.join(fair,'stream_adapters.py'),publication_channel_id:crypto.randomUUID(),binding:installed.binding};
  const raw=JSON.stringify(meta), metadata=path.join(root,'runner-metadata.json');
  fs.writeFileSync(metadata,raw,{flag:'wx',mode:0o600});
  const expected={channel_id:meta.publication_channel_id,protocol_id:meta.protocol_id,run_id:meta.run_id,
    root_turn_id:meta.root_turn_id,observer_source_sha256:meta.observer_source_sha256,
    installed_adapter_sha256:meta.installed_adapter_sha256,binding_source_sha256:meta.binding.binding_source_sha256,
    binding_contract_sha256:meta.binding.expected.contract_sha256,publication_count:1};
  const dispatcher=createDispatcher(expected);
  const lifecycle=await supervise({arm:'pi',expectedMessages:0,readyMs:5000,taskMs:5000,stopMs:1000,closeMs:1000,killGraceMs:500,
    dispatchOwnerMessage:dispatcher.dispatch,
    spawnOwner(register) {
      // 'pi' selects direct-owner lifecycle only. Child is NOT Pi; its frozen
      // fake fetch replaces global fetch before importing the actual observer.
      const child=fork(path.join(luna,'child_fixture.mjs'),[],{execArgv:[],cwd:root,
        stdio:['ignore','ignore','ignore','ipc'],env:{PATH:'/usr/bin:/bin:/usr/local/bin',HOME:root,
          OPENAI_API_KEY:'synthetic-only',LUNA_LEDGER_ROOT:root,LUNA_RUN_DIR:root,LUNA_RUN_ID:'fixture',LUNA_TASK_CALL_CAP:'45',
          LUNA_CAPTURE_METADATA:metadata,LUNA_CAPTURE_METADATA_SHA256:sha(raw),SYNTHETIC_FAULT:fault}});
      register(child);return child;
    }});
  const inventory=dispatcher.finish(lifecycle);
  const rows=records(root);
  assert.equal(lifecycle.cleanup_complete,true);
  assert.equal(inventory.finalization_authorized,false);
  // Retain safe scalar results plus synthetic artifacts, never remove runs or
  // infer current financial balances from these private fixture journals.
  fs.writeFileSync(path.join(root,'probe-outcome.json'),JSON.stringify({fault,lifecycle,inventory,
    ledger_events:rows.map(row=>row.event)}),{flag:'wx',mode:0o600});
  return {root,lifecycle,inventory,rows};
}

function verifyArtifacts(result) {
  const code=`import json,runpy,sys\ng=runpy.run_path(sys.argv[1])\na=json.load(sys.stdin)\nr=sys.argv[2]\nfrom pathlib import Path\np=Path(r)\ng['verify_artifacts'](a,(p/'capture-receipt-001.json').read_bytes(),(p/'capture-request-001.json').read_bytes(),(p/'capture-response-001.sse').read_bytes())\n`;
  return spawnSync('/usr/bin/python3',['-I','-S','-B','-c',code,path.join(luna,'publication_gate.py'),result.root],
    {input:JSON.stringify(result.inventory.acknowledgments[0]),encoding:'utf8',timeout:5000,maxBuffer:8192,env:{PATH:'/usr/bin:/bin'}});
}

test('real observer publishes durable artifacts, settles once and sends owned IPC acknowledgment',async()=>{
  const result=await run();
  assert.equal(result.lifecycle.valid,true);
  assert.equal(result.inventory.composition_verified,true);
  assert.deepEqual(result.rows.map(row=>row.event),['admit','settle']);
  assert.equal(result.rows[1].error,null);
  assert.deepEqual(json(result.root,'fixture-send-count.json'),{calls:1});
  assert.equal(verifyArtifacts(result).status,0);
});
test('forged channel cannot authorize composition despite actual settled capture files',async()=>{
  const result=await run('forged-channel');
  assert.equal(result.lifecycle.valid,false);
  assert.equal(result.inventory.composition_verified,false);
  assert.deepEqual(result.rows.map(row=>row.event),['admit','settle']);
});
test('well-shaped but wrong artifact digest passes channel shape only and fails artifact verification',async()=>{
  const result=await run('wrong-hash');
  assert.equal(result.inventory.composition_verified,true);
  const verify=verifyArtifacts(result);
  assert.notEqual(verify.status,0);
  assert.match(verify.stderr,/publication_artifact_hash_mismatch/);
  assert.deepEqual(result.rows.map(row=>row.event),['admit','settle']);
});
test('child exit after acknowledgment never becomes a clean composition',async()=>{
  const result=await run('crash-after-ack');
  assert.equal(result.lifecycle.valid,false);
  assert.equal(result.inventory.composition_verified,false);
  assert.equal(result.lifecycle.owner.code,94);
  assert.deepEqual(result.rows.map(row=>row.event),['admit','settle']);
});
test('legacy response-open fault leaves the original conservative hold before any upstream send',async()=>{
  const result=await run('legacy-open');
  assert.equal(result.inventory.composition_verified,false);
  assert.deepEqual(result.rows.map(row=>row.event),['admit']);
  assert.deepEqual(json(result.root,'fixture-send-count.json'),{calls:0});
});
test('optional publication sync and withdrawal faults do not erase the existing settlement',async()=>{
  const result=await run('double-fault');
  assert.equal(result.inventory.composition_verified,false);
  assert.deepEqual(result.rows.map(row=>row.event),['admit','settle']);
  assert.deepEqual(json(result.root,'fixture-send-count.json'),{calls:1});
});
test('settlement append failure preserves outstanding admission and cannot yield accepted publication',async()=>{
  const result=await run('settlement-append');
  assert.equal(result.inventory.composition_verified,false);
  assert.deepEqual(result.rows.map(row=>row.event),['admit']);
});
