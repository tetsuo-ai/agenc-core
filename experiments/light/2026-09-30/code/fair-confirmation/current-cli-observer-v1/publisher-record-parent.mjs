// Read-only bridge from the trusted owned publisher to existing strict IPC.
// Must run under the selected private-directory/companion trust boundary.
// Neither a file nor this function grants financial/finalizer authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createDispatcher, PINS} from './dispatcher-v6.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = value => {if (!value) throw new Error('publisher_record_refused');};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,240}$/.test(value);
const fixedKeys = ['binding_profile_id', 'protocol_id', 'run_id', 'publication_channel_id',
  'independent_material_digest', 'task_prompt_sha256', 'client_artifact_sha256',
  'configuration_sha256', 'source_inventory_sha256', ...Object.keys(PINS)];
const recordKeys = ['schema_version', 'contract', 'client', 'route', ...fixedKeys,
  'root_turn_id', 'conversation_id', 'managed_request_id', 'admission_run_id',
  'contract_sha256', 'policy_sha256', 'metadata_sha256'];
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join() === [...keys].sort().join();
function read(filename, maximum) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, {bigint: true});
    need(before.isFile() && before.size > 0n && before.size <= BigInt(maximum));
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fs.fstatSync(fd, {bigint: true}), named = fs.lstatSync(filename, {bigint: true});
    need(used === Number(before.size) && named.isFile());
    for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      need(before[key] === after[key] && before[key] === named[key]);
    }
    return buffer.subarray(0, used);
  } finally {fs.closeSync(fd);}
}
// Publisher emits canonical ASCII JSON. Equality also rejects duplicate keys,
// BOM/trailing data, unexpected encodings and noncanonical numeric spellings.
export function canonicalPublisherJson(value) {
  const sorted = value !== null && typeof value === 'object'
    ? Array.isArray(value) ? value.map(sort) : sort(value) : value;
  return Buffer.from(JSON.stringify(sorted).replace(/[\u007f-\uffff]/g,
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  }
  return value;
}
function parse(bytes) {
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  need(bytes.equals(canonicalPublisherJson(value)));
  return value;
}

/** Trusted expected input is independently selected before child launch.
 * No IPC message or outgoing request is an argument to this function.
 * Directory remains private and owned; this is not an adversarial FS sandbox.
 */
export function readPublisherBinding({runDirectory, runDirectoryIdentity, expected}) {
  need(path.isAbsolute(runDirectory) && fs.realpathSync(runDirectory) === runDirectory);
  need(exact(expected, fixedKeys));
  const fixed = Object.freeze({...expected});
  need(fixed.binding_profile_id === 'light-luna-44aed-source-base-v2');
  for (const key of fixedKeys) need(key.endsWith('sha256') || key === 'independent_material_digest'
    ? hash(fixed[key]) : id(fixed[key]));
  for (const key of Object.keys(PINS)) need(fixed[key] === PINS[key]);
  const checkDirectory = () => {
    const st = fs.lstatSync(runDirectory, {bigint: true});
    need(st.isDirectory() && String(st.dev) === runDirectoryIdentity.dev && String(st.ino) === runDirectoryIdentity.ino);
  };
  checkDirectory();
  const recordBytes = read(path.join(runDirectory, 'publisher-record.json'), 16 * 1024);
  const record = parse(recordBytes);
  need(exact(record, recordKeys) && record.schema_version === 1 && record.contract === 'current-cli-publisher-v1'
    && record.client === 'light' && record.route === 'openai-direct');
  for (const key of fixedKeys) need(record[key] === fixed[key]);
  for (const key of ['root_turn_id', 'conversation_id', 'admission_run_id']) need(id(record[key]));
  need(typeof record.managed_request_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.managed_request_id));
  const artifacts = {};
  for (const name of ['contract', 'policy', 'metadata']) {
    need(hash(record[name + '_sha256']));
    const raw = read(path.join(runDirectory, name + '.json'), 256 * 1024);
    need(sha(raw) === record[name + '_sha256']);
    artifacts[name] = parse(raw);
  }
  const {contract, metadata} = artifacts;
  for (const key of ['protocol_id', 'run_id', 'root_turn_id', 'task_prompt_sha256']) {
    need(contract[key] === record[key] && metadata[key] === record[key]);
  }
  for (const key of ['client_artifact_sha256', 'configuration_sha256', 'source_inventory_sha256']) need(contract[key] === record[key]);
  need(contract.schema_version === 2 && contract.profile_id === fixed.binding_profile_id);
  need(metadata.schema_version === 11 && metadata.contract === 'prospective-shared-source-finance-v6'
    && metadata.client === 'light' && metadata.route === 'openai-direct'
    && metadata.binding_profile_id === fixed.binding_profile_id
    && metadata.publication_channel_id === fixed.publication_channel_id);
  for (const key of ['observer_source_sha256', 'installed_adapter_sha256']) need(metadata[key] === fixed[key]);
  need(metadata.binding?.binding_source_sha256 === fixed.binding_source_sha256
    && metadata.binding.contract_path === path.join(runDirectory, 'contract.json')
    && metadata.binding.expected?.contract_sha256 === record.contract_sha256
    && metadata.fixed_policy?.policy_path === path.join(runDirectory, 'policy.json')
    && metadata.fixed_policy.policy_sha256 === record.policy_sha256);
  for (const key of ['protocol_id', 'run_id', 'root_turn_id', 'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256', 'client', 'route']) {
    need(metadata.binding.expected[key] === record[key]);
  }
  checkDirectory();
  need(read(path.join(runDirectory, 'publisher-record.json'), 16 * 1024).equals(recordBytes));
  const dispatcher = createDispatcher({channel_id: fixed.publication_channel_id,
    protocol_id: fixed.protocol_id, run_id: fixed.run_id, root_turn_id: record.root_turn_id,
    client: 'light', binding_profile_id: fixed.binding_profile_id, ...PINS,
    binding_contract_sha256: record.contract_sha256, max_publications: 1});
  return Object.freeze({record: Object.freeze(record), record_sha256: sha(recordBytes), dispatcher,
    finalization_authorized: false});
}
