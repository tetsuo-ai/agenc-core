// Only classifies owned-channel messages. Never mints finalization authority.
export const DEPENDENCIES=Object.freeze({
  lifecycle_v5:'1cc1464a06069f467b756bdecd487d0f01ab93bbdba7cb2a14b4706de129cb6e',
  lifecycle_tests_v5:'0a208e50f68a0db5476af8a9011e5f2b423b2c92563dca75f9519f82db78d38c',
  luna_observer_v5:'45843e8b17283c247eb9ded660a689b2952a659957d470da2589883edbd3f074',
  publication_gate_v5:'bb33193092e9ed73ac03d8c0c22bc986bc5a3310e6405dc84e7a195a4ef47772',
  old_parent_fixture_v5:'674ecc5ea9b1552688ca1689d4f1c9127519140c315fa839d9e0246d387ac18b',
  binding_v2:'513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6',
});
const identities=['channel_id','protocol_id','run_id','root_turn_id'];
const pins=['observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'];
const hashes=['receipt_sha256','request_body_sha256','response_bytes_sha256'];
const expectedKeys=[...identities,...pins,'publication_count'];
const ackKeys=['kind','schema_version',...identities,...pins,...hashes,'admission_id','call_ordinal','publication_ordinal','response_byte_count'];
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const isIdentity=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,240}$/.test(value);
const need=ok=>{if(!ok)throw new Error('publication_channel_refused');};
function fields(value,keys) {
  need(value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  need(Reflect.ownKeys(descriptors).length===keys.length&&keys.every(k=>Object.hasOwn(descriptors,k)&&Object.hasOwn(descriptors[k],'value')));
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,descriptors[k].value])));
}

export function createDispatcher(expectedInput) {
  const expected=fields(expectedInput,expectedKeys);
  need(identities.every(k=>isIdentity(expected[k]))&&pins.every(k=>isHash(expected[k])));
  need(expected.binding_source_sha256===DEPENDENCIES.binding_v2);
  need(expected.observer_source_sha256===DEPENDENCIES.luna_observer_v5);
  need(Number.isSafeInteger(expected.publication_count)&&expected.publication_count>=1&&expected.publication_count<=1000);
  const acknowledgments=[];
  let failed=false,sealed=false;
  const refuse=()=>{failed=true;throw new Error('publication_channel_refused');};
  return Object.freeze({
    dispatch(message,owner) {
      if(failed||sealed)return refuse();
      try {
        need(owner&&Number.isSafeInteger(owner.pid)&&owner.pid>1);
        const descriptor=message&&typeof message==='object'?Object.getOwnPropertyDescriptor(message,'kind'):undefined;
        need(descriptor&&Object.hasOwn(descriptor,'value'));
        if(descriptor.value==='lifecycle-probe-v5') {
          const value=fields(message,['kind','pid','ordinal','connected']);
          need(value.pid===owner.pid&&value.connected===true&&Number.isSafeInteger(value.ordinal)&&value.ordinal>0);
          // Lifecycle engine retains exact ordinal/count, spawn and terminal authority.
          return {kind:'lifecycle'};
        }
        need(descriptor.value==='luna.capture.published.v5');
        const ack=fields(message,ackKeys),next=acknowledgments.length+1;
        need(ack.schema_version===1&&next<=expected.publication_count);
        need([...identities,...pins].every(k=>ack[k]===expected[k]));
        need(ack.call_ordinal===next&&ack.publication_ordinal===next&&ack.admission_id===`${expected.run_id}:${next}`);
        need(hashes.every(k=>isHash(ack[k]))&&Number.isSafeInteger(ack.response_byte_count)
          &&ack.response_byte_count>=0&&ack.response_byte_count<=64*1024*1024);
        acknowledgments.push(ack);
        return {kind:'publication'};
      } catch {return refuse();}
    },
    finish(lifecycle) {
      sealed=true;
      const accepted=!failed&&lifecycle?.valid===true&&lifecycle.cleanup_complete===true
        &&acknowledgments.length===expected.publication_count;
      // Informational inventory only. No receipt reads, durable writes or score.
      return Object.freeze({composition_verified:accepted,finalization_authorized:false,
        reason:accepted?null:'lifecycle_or_publication_incomplete',
        expected,acknowledgments:Object.freeze([...acknowledgments])});
    },
  });
}
