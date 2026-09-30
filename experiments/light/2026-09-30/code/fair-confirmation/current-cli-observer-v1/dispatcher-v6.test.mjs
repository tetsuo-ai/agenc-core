import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDispatcher, PINS} from './dispatcher-v6.mjs';

const expected = client => ({channel_id:'channel',protocol_id:'protocol',run_id:'run',root_turn_id:'root',client,
  binding_profile_id:client==='light'?'light-luna-44aed-source-base-v2':'pi-luna-v0731-shared-v1',
  ...PINS,binding_contract_sha256:'a'.repeat(64),max_publications:4});
const ack = (e,n) => {const {max_publications,...identity}=e;return {...identity,
  kind:'luna.capture.published.shared.v6',schema_version:1,admission_id:`run:${n}`,call_ordinal:n,publication_ordinal:n,
  receipt_sha256:'b'.repeat(64),request_body_sha256:'c'.repeat(64),response_bytes_sha256:'d'.repeat(64),response_byte_count:10};};
const owner={pid:1234};
for(const client of ['light','pi']) test(`${client}: variable count and exact immutable ACKs, no authority`,()=>{
  const e=expected(client),d=createDispatcher(e);
  assert.deepEqual(d.dispatch({kind:'lifecycle-probe-v5',pid:1234,ordinal:1,connected:true},owner),{kind:'lifecycle'});
  for(let n=1;n<=2;n++)assert.deepEqual(d.dispatch(ack(e,n),owner),{kind:'publication'});
  const result=d.finish();
  assert.equal(result.failed,false);assert.equal(result.sealed,true);assert.equal(result.finalization_authorized,false);
  assert.equal(result.acknowledgments.length,2);assert.deepEqual(result.acknowledgments[1],ack(e,2));
  assert.throws(()=>{result.acknowledgments[0].call_ordinal=5;},TypeError);
  assert.throws(()=>d.dispatch(ack(e,3),owner),/publication_channel_refused/);
  assert.equal(d.snapshot().failed,true);
});
test('zero ACK inventory is informational, not success',()=>{
  const r=createDispatcher(expected('pi')).finish();assert.equal(r.acknowledgments.length,0);
  assert.equal(r.finalization_authorized,false);assert.equal('composition_verified' in r,false);
});
test('duplicate, skipped, malformed and wrong-arm acknowledgments latch failure',()=>{
  for(const mutate of [a=>({...a,call_ordinal:2}),a=>({...a,publication_ordinal:2}),a=>({...a,admission_id:'run:01'}),
    a=>({...a,client:'pi'}),a=>({...a,channel_id:'other'}),a=>({...a,extra:true}),a=>({...a,response_byte_count:-1}),
    a=>({...a,observer_source_sha256:'f'.repeat(64)}),a=>({...a,receipt_sha256:'bad'}),a=>({...a,kind:'luna.capture.published.v5'})]){
    const e=expected('light'),d=createDispatcher(e);assert.throws(()=>d.dispatch(mutate(ack(e,1)),owner));
    assert.throws(()=>d.dispatch(ack(e,1),owner));assert.equal(d.finish().failed,true);
  }
  const e=expected('light'),d=createDispatcher(e);d.dispatch(ack(e,1),owner);
  assert.throws(()=>d.dispatch(ack(e,1),owner));assert.equal(d.snapshot().failed,true);
});
test('configured maximum is a bound, not a declaration of admitted count',()=>{
  const e={...expected('pi'),max_publications:1},d=createDispatcher(e);d.dispatch(ack(e,1),owner);
  assert.throws(()=>d.dispatch(ack(e,2),owner));assert.equal(d.finish().acknowledgments.length,1);
});
test('accessors and proxies are refused without evaluating them',()=>{
  const e=expected('pi');let touched=false;
  const a=ack(e,1);Object.defineProperty(a,'kind',{get(){touched=true;throw Error();}});
  assert.throws(()=>createDispatcher(e).dispatch(a,owner));assert.equal(touched,false);
  const p=new Proxy(ack(e,1),{getOwnPropertyDescriptor(){touched=true;throw Error();}});
  assert.throws(()=>createDispatcher(e).dispatch(p,owner));assert.equal(touched,false);
});
test('wrong source selection, profile, and unbounded inventory refused before collection',()=>{
  for(const e of [{...expected('pi'),max_publications:1001},{...expected('pi'),max_publications:0},
    {...expected('pi'),binding_profile_id:'unknown'},{...expected('pi'),binding_source_sha256:'f'.repeat(64)}]){
    assert.throws(()=>createDispatcher(e));
  }
});
