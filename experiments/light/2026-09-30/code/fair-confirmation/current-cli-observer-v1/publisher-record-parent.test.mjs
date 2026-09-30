import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PINS} from './dispatcher-v6.mjs';
import {readPublisherBinding, canonicalPublisherJson as encode} from './publisher-record-parent.mjs';
const sha = raw => createHash('sha256').update(raw).digest('hex');
function fixture() {
  const runDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'light-publisher-parent-'));
  const st = fs.statSync(runDirectory, {bigint: true});
  const expected = {binding_profile_id: 'light-luna-44aed-source-base-v2', protocol_id: 'synthetic-cli',
    run_id: 'financial-run', publication_channel_id: 'owned-channel', independent_material_digest: 'a'.repeat(64),
    task_prompt_sha256: 'b'.repeat(64), client_artifact_sha256: 'c'.repeat(64), configuration_sha256: 'd'.repeat(64),
    source_inventory_sha256: 'e'.repeat(64), ...PINS};
  const record = {schema_version: 1, contract: 'current-cli-publisher-v1', client: 'light', route: 'openai-direct',
    ...expected, root_turn_id: 'source-root', conversation_id: 'source-conversation',
    managed_request_id: '12345678-1234-4234-8234-123456789012', admission_run_id: 'core-admission-run'};
  const identity = Object.fromEntries(['protocol_id', 'run_id', 'root_turn_id', 'task_prompt_sha256',
    'client_artifact_sha256', 'configuration_sha256', 'client', 'route'].map(key => [key, record[key]]));
  const contract = {...identity, schema_version: 2, profile_id: expected.binding_profile_id,
    source_inventory_sha256: expected.source_inventory_sha256};
  const policy = {synthetic_test_only: true};
  const write = (name, value) => {
    const raw = encode(value); fs.writeFileSync(path.join(runDirectory, name + '.json'), raw, {mode: 0o600}); return sha(raw);
  };
  record.contract_sha256 = write('contract', contract);
  record.policy_sha256 = write('policy', policy);
  const metadata = {...identity, schema_version: 11, contract: 'prospective-shared-source-finance-v6',
    binding_profile_id: expected.binding_profile_id, publication_channel_id: expected.publication_channel_id,
    observer_source_sha256: PINS.observer_source_sha256, installed_adapter_sha256: PINS.installed_adapter_sha256,
    binding: {binding_source_sha256: PINS.binding_source_sha256,
      contract_path: path.join(runDirectory, 'contract.json'), expected: {...identity, contract_sha256: record.contract_sha256}},
    fixed_policy: {policy_path: path.join(runDirectory, 'policy.json'), policy_sha256: record.policy_sha256}};
  record.metadata_sha256 = write('metadata', metadata);
  write('publisher-record', record);
  return {runDirectory, runDirectoryIdentity: {dev: String(st.dev), ino: String(st.ino)}, expected,
    record, metadata, contract, write};
}
test('trusted publisher record binds dispatcher without reading an ACK', () => {
  const input = fixture(), selected = readPublisherBinding(input);
  assert.equal(selected.finalization_authorized, false);
  assert.equal(selected.record.admission_run_id, 'core-admission-run');
  assert.equal(selected.dispatcher.snapshot().expected.run_id, 'financial-run');
  assert.equal(selected.dispatcher.snapshot().expected.root_turn_id, 'source-root');
  assert.equal(selected.dispatcher.snapshot().expected.max_publications, 1);
  assert.deepEqual(selected.dispatcher.snapshot().acknowledgments, []);
  assert.equal(selected.record_sha256, sha(encode(input.record)));
});
const cases = {
  missing: f => fs.renameSync(path.join(f.runDirectory, 'publisher-record.json'), path.join(f.runDirectory, 'retained-record.json')),
  symlink: f => {fs.renameSync(path.join(f.runDirectory, 'publisher-record.json'), path.join(f.runDirectory, 'retained-record.json'));
    fs.symlinkSync('retained-record.json', path.join(f.runDirectory, 'publisher-record.json'));},
  duplicate_key: f => fs.writeFileSync(path.join(f.runDirectory, 'publisher-record.json'),
    encode(f.record).toString().replace('{', '{"schema_version":1,')),
  fixed_expectation: f => {f.record.protocol_id = 'different'; f.write('publisher-record', f.record);},
  artifact_tamper: f => fs.appendFileSync(path.join(f.runDirectory, 'contract.json'), ' '),
  inconsistent_generated_root: f => {f.metadata.root_turn_id = 'other-root';
    f.record.metadata_sha256 = f.write('metadata', f.metadata); f.write('publisher-record', f.record);},
  wrong_directory_identity: f => {f.runDirectoryIdentity.ino = '0';},
  unrelated_contract_path: f => {f.metadata.binding.contract_path = '/unrelated/contract.json';
    f.record.metadata_sha256 = f.write('metadata', f.metadata); f.write('publisher-record', f.record);},
};
for (const [name, mutate] of Object.entries(cases)) test('refuses ' + name, () => {
  const input = fixture(); mutate(input); assert.throws(() => readPublisherBinding(input));
});
// All synthetic fixture directories intentionally retained. No observer,
// runtime, network, provider, financial owner or paid journal is constructed.
