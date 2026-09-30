"""UNEXECUTED cross-language fixture, not a provider/client or parent owner.

prepare writes only fresh synthetic files. score accepts the Node finalizer's
returned capability via stdin; it never mints a capability from manifest bytes.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

HERE = Path(__file__).resolve().parent
GATE_PIN = 'a73cd7ef4ccc7b036139ab819a164d8a43c428fe725daee588592ad40ba8993b'
RECIPE_PIN = 'df02ee1f2b0a7dd19de0a89b1e112fa6ceb9ec3340a4474fc395b3e766295e00'
FINALIZER_PIN = 'f08c8cd77f3624a5ed6af96d2695c400d7fabbd5fd4bf8becad39662048df2aa'
PLAN = '- [ ] Implement the change\n- [ ] Run tests\n'


def need(ok):
    if not ok:
        raise ValueError('synthetic_cross_language_fixture_refused')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, separators=(',', ':'), allow_nan=False).encode()+b'\n'


def load(filename, pin):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        st = os.fstat(fd);need(stat.S_ISREG(st.st_mode) and st.st_size <= 256*1024)
        with os.fdopen(os.dup(fd), 'rb') as handle:
            raw = handle.read(st.st_size+1)
        need(len(raw) == st.st_size and sha(raw) == pin)
    finally:
        os.close(fd)
    namespace = {'__name__':'_integration_selected_source','__file__':str(filename)}
    exec(compile(raw,str(filename),'exec'),namespace)
    return namespace


def put(directory, name, raw):
    fd = os.open(directory/name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(raw):
            count = os.write(fd,raw[offset:]);need(count>0);offset += count
    finally:
        os.close(fd)


def response(n):
    rid,mid = f'r{n}',f'm{n}'
    part = {'type':'output_text','text':PLAN}
    item = {'type':'message','id':mid,'role':'assistant','content':[part]}
    common = {'item_id':mid,'output_index':0,'content_index':0}
    events = [
        {'type':'response.created','response':{'id':rid,'model':'gpt-6-luna','status':'in_progress','output':[]}},
        {'type':'response.output_item.added','output_index':0,'item':{**item,'content':[]}},
        {'type':'response.content_part.added',**common,'part':{'type':'output_text','text':''}},
        {'type':'response.output_text.delta',**common,'delta':PLAN},
        {'type':'response.output_text.done',**common,'text':PLAN},
        {'type':'response.content_part.done',**common,'part':part},
        {'type':'response.output_item.done','output_index':0,'item':item},
        {'type':'response.completed','response':{'id':rid,'model':'gpt-6-luna','status':'completed','output':[item],
            'usage':{'input_tokens':100,'output_tokens':20,'total_tokens':120,'input_tokens_details':{'cached_tokens':0}}}},
    ]
    return b''.join(b'data: '+encoded({**event,'sequence_number':i})+b'\n' for i,event in enumerate(events))


def prepare(directory, client, gate):
    need(client in gate['PROFILES'] and not list(directory.iterdir()))
    recipe = load(HERE.parent/'shared-luna-binding-v1'/'binding_test.py',RECIPE_PIN)
    # The accepted recipe seals the independently declared task/context/envelope
    # before assembling wire. No capture/report is an expected-value source.
    sealed = recipe['fixture'](client)
    contract = json.loads(sealed['contract_bytes'])
    expected = {key:contract[key] for key in ('run_id','root_turn_id','protocol_id','task_prompt_sha256')}
    expected.update(client=client,binding_profile_id=contract['profile_id'],channel_id='integration-channel',
        financial_policy_id='a'*64,observer_source_sha256=gate['OBSERVER'],installed_adapter_sha256=gate['ADAPTER'],
        binding_source_sha256=gate['BINDING'],binding_contract_sha256=sha(sealed['contract_bytes']),
        parent_source_sha256=sha((HERE/'cross_language.test.mjs').read_bytes()),finalizer_source_sha256=FINALIZER_PIN,
        owner_pid=1234,task_pid=1235 if client=='light' else None,
        daemon_identity_sha256='c'*64 if client=='light' else None)
    outcome = dict(normal_exit=True,timed_out=False,budget_stopped=False,code_artifact_pass=True,planning_required=True)
    acks,rows = [],[]
    for n in (1,2):
        if n==1:
            request = sealed['request_bytes']
        else:
            body = json.loads(sealed['request_bytes'])
            body['input'].append({'role':'assistant','content':[{'type':'output_text','text':'Synthetic prior turn.'}]})
            request = encoded(body)
        output = response(n)
        receipt = dict(client=client,binding_profile_id=expected['binding_profile_id'],schema_version=2,
            protocol_id=expected['protocol_id'],run_id=expected['run_id'],root_turn_id=expected['root_turn_id'],
            request_role='root' if n==1 else 'continuation',admission_id=f'synthetic:{n}',call_ordinal=n,
            prior_root_generations=n-1,initial_request=n==1,route='openai-direct',source='provider_response_sse',
            request_body_sha256=sha(request),task_prompt_sha256=expected['task_prompt_sha256'],
            response_bytes_sha256=sha(output),response_byte_count=len(output),http_status=200,
            response_content_type='text/event-stream',requested_stream=True,transport_outcome='eof',
            downstream_delivery_failed=False,capture_write_complete=True,observer_source_sha256=gate['OBSERVER'],
            installed_adapter_sha256=gate['ADAPTER'],binding_source_sha256=gate['BINDING'],
            binding_contract_sha256=expected['binding_contract_sha256'],initial_binding_verified=n==1)
        receipt_raw = encoded(receipt)
        for name,extension,raw in [('receipt','json',receipt_raw),('request','json',request),('response','sse',output)]:
            put(directory,f'capture-{name}-{n:03d}.{extension}',raw)
        ack = {key:expected[key] for key in ('client','binding_profile_id','channel_id','protocol_id','run_id','root_turn_id',
            'observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256')}
        ack.update(kind='luna.capture.published.shared.v6',schema_version=1,admission_id=f'synthetic:{n}',call_ordinal=n,
            publication_ordinal=n,receipt_sha256=sha(receipt_raw),request_body_sha256=sha(request),
            response_bytes_sha256=sha(output),response_byte_count=len(output));acks.append(ack)
        common = dict(id=f'synthetic:{n}',run='synthetic',call=n,financial_schema=1,financial_policy_id=expected['financial_policy_id'],
            price_id='historical-luna-fixture-nanodollars-v1',request_sha256=sha(request))
        rows.extend([dict(event='admit',**common,reserve=0.01,reserve_nanos='10000000'),
            dict(event='settle',**common,usage_missing=False,
                usage=dict(input_tokens=100,output_tokens=20,total_tokens=120,input_tokens_details={'cached_tokens':0}),
                cost_usd=0.00002,budget_charge_usd=0.00002,charge_nanos='20000',settlement_proof='completed-full-usage-v1',
                error=None,input_tokens=100,output_tokens=20,cached_tokens=0,uncached_tokens=100)])
    put(directory,'contract.json',sealed['contract_bytes'])
    put(directory,'synthetic-ledger.jsonl',b''.join(encoded(row) for row in rows))
    put(directory,'selection.json',encoded(dict(expected=expected,outcome=outcome,acknowledgments=acks,
        binding_expected=sealed['expected'],deployed_source_pins=sealed['deployed_source_pins'])))
    return {'prepared':True,'client':client,'admitted_calls':2}


def score(directory, gate):
    raw = sys.stdin.buffer.read(1024*1024+1);need(len(raw)<=1024*1024)
    payload = json.loads(raw)
    need(type(payload) is dict and set(payload)=={'trusted_clean_commit_sha256','expected','outcome','directory_identity'})
    selection = json.loads((directory/'selection.json').read_bytes())
    # There is intentionally no read/hash of parent-attempt-v1.json here.
    # The accepted gate verifies its bytes AGAINST the passed Node return value.
    return gate['score_committed_attempt'](directory=str(directory),**payload,
        binding_expected=selection['binding_expected'],deployed_source_pins=selection['deployed_source_pins'])


def main():
    need(len(sys.argv) in (3,4))
    mode = sys.argv[1];directory = Path(sys.argv[2])
    need(directory.is_absolute() and directory.resolve(strict=True)==directory and directory.is_dir()
         and stat.S_IMODE(directory.stat().st_mode)==0o700)
    gate = load(HERE/'score_gate.py',GATE_PIN)
    if mode=='prepare':
        need(len(sys.argv)==4);result=prepare(directory,sys.argv[3],gate)
    else:
        need(mode=='score' and len(sys.argv)==3);result=score(directory,gate)
    sys.stdout.buffer.write(encoded(result))


if __name__=='__main__':main()
