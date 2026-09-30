// Trusted owned-channel classifier; no launch, file access or score authority.
// The lifecycle owner must call dispatch only for its live registered owner.
import {types} from 'node:util';

export const PINS = Object.freeze({
  observer_source_sha256: '8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a',
  installed_adapter_sha256: 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323',
  binding_source_sha256: '9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112',
});
const profiles = Object.freeze({light: 'light-luna-44aed-source-base-v2', pi: 'pi-luna-v0731-shared-v1'});
const identityKeys = ['channel_id', 'protocol_id', 'run_id', 'root_turn_id', 'client', 'binding_profile_id'];
const pinKeys = [...Object.keys(PINS), 'binding_contract_sha256'];
const hashKeys = ['receipt_sha256', 'request_body_sha256', 'response_bytes_sha256'];
const ackKeys = ['kind', 'schema_version', ...identityKeys, ...pinKeys, ...hashKeys,
  'admission_id', 'call_ordinal', 'publication_ordinal', 'response_byte_count'];
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isIdentity = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,240}$/.test(value);
const need = value => {if (!value) throw new Error('publication_channel_refused');};
function fields(value, keys) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(descriptors).length === keys.length);
  need(keys.every(key => Object.hasOwn(descriptors, key) && descriptors[key].enumerable
    && Object.hasOwn(descriptors[key], 'value')));
  return Object.freeze(Object.fromEntries(keys.map(key => [key, descriptors[key].value])));
}

export function createDispatcher(expectedInput) {
  const expected = fields(expectedInput, [...identityKeys, ...pinKeys, 'max_publications']);
  need(identityKeys.every(key => isIdentity(expected[key])) && pinKeys.every(key => isHash(expected[key])));
  need(Object.hasOwn(profiles, expected.client) && expected.binding_profile_id === profiles[expected.client]);
  need(Object.keys(PINS).every(key => expected[key] === PINS[key]));
  need(Number.isSafeInteger(expected.max_publications) && expected.max_publications >= 1 && expected.max_publications <= 1000);
  const acknowledgments = [];
  let failed = false, sealed = false;
  const refuse = () => {failed = true; throw new Error('publication_channel_refused');};
  const snapshot = () => Object.freeze({failed, sealed, finalization_authorized: false,
    expected, acknowledgments: Object.freeze([...acknowledgments])});
  return Object.freeze({
    dispatch(message, owner) {
      if (failed || sealed) return refuse();
      try {
        const owned = fields(owner, ['pid']);
        need(Number.isSafeInteger(owned.pid) && owned.pid > 1);
        need(message !== null && typeof message === 'object' && !types.isProxy(message));
        const descriptor = Object.getOwnPropertyDescriptor(message, 'kind');
        need(descriptor && Object.hasOwn(descriptor, 'value'));
        if (descriptor.value === 'lifecycle-probe-v5') {
          const value = fields(message, ['kind', 'pid', 'ordinal', 'connected']);
          need(value.pid === owned.pid && value.connected === true && Number.isSafeInteger(value.ordinal) && value.ordinal > 0);
          // Exact lifecycle count/order and owned-channel liveness remain in
          // the original lifecycle engine, not a second tracker here.
          return {kind: 'lifecycle'};
        }
        need(descriptor.value === 'luna.capture.published.shared.v6');
        const ack = fields(message, ackKeys), next = acknowledgments.length + 1;
        need(ack.schema_version === 1 && next <= expected.max_publications);
        need([...identityKeys, ...pinKeys].every(key => ack[key] === expected[key]));
        need(ack.call_ordinal === next && ack.publication_ordinal === next && ack.admission_id === `${expected.run_id}:${next}`);
        need(hashKeys.every(key => isHash(ack[key])) && Number.isSafeInteger(ack.response_byte_count)
          && ack.response_byte_count >= 0 && ack.response_byte_count <= 64 * 1024 * 1024);
        acknowledgments.push(ack);
        return {kind: 'publication'};
      } catch {return refuse();}
    },
    snapshot,
    finish() {
      sealed = true;
      // The whole financial ledger, not this maximum or ACK count, determines
      // admitted attempts. The accepted finalizer performs that reconciliation.
      // No clean/composition verdict is minted by this informational inventory.
      return snapshot();
    },
  });
}
