// Synthetic trusted parent only. No production runner, network, credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const [dir, fault='none']=process.argv.slice(2);
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const meta={schema_version:3,contract:'prospective-output-capture-v3',protocol_id:'fixture-protocol',
  run_id:'fixture',root_turn_id:'root-1',route:'openai-direct',task_prompt_sha256:sha('Synthetic task.'),
  observer_source_sha256:sha(fs.readFileSync(path.join(here,'direct.mjs'))),
  installed_adapter_sha256:sha(fs.readFileSync(path.join(here,'../stream_adapters.py'))),
  installed_adapter_path:path.join(here,'../stream_adapters.py'),publication_channel_id:crypto.randomUUID()};
const raw=JSON.stringify(meta);
const metadata=path.join(dir,'runner-metadata.json');fs.writeFileSync(metadata,raw,{flag:'wx',mode:0o600});
const child=fork(path.join(here,'child_fixture.mjs'),[],{
  execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,
    HOME:dir,OPENAI_API_KEY:'synthetic-only',LUNA_LEDGER_ROOT:dir,LUNA_RUN_DIR:dir,
    LUNA_RUN_ID:'fixture',LUNA_TASK_CALL_CAP:'45',LUNA_CAPTURE_METADATA:metadata,
    LUNA_CAPTURE_METADATA_SHA256:sha(raw),SYNTHETIC_FAULT:fault}});
const acks=[];let disconnected=false;
child.on('message',message=>acks.push(message));
child.on('disconnect',()=>{disconnected=true;});
child.on('close',(code,signal)=>{
  process.stdout.write(JSON.stringify({acks,child_exit_code:code,ipc_closed:disconnected,signal,
    expected:{channel_id:meta.publication_channel_id,protocol_id:meta.protocol_id,run_id:meta.run_id,
      root_turn_id:meta.root_turn_id,observer_source_sha256:meta.observer_source_sha256,
      installed_adapter_sha256:meta.installed_adapter_sha256,publication_count:1,
      parent_source_sha256:sha(fs.readFileSync(path.join(here,'publication_gate.py'))),
      ipc_parent_source_sha256:sha(fs.readFileSync(path.join(here,'parent_fixture.mjs')))}})+'\n');
});
