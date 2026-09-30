"""Offline actual proxy path; retained synthetic roots, no sockets or credentials."""
import ast
import base64
import copy
import io
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error
import capture
import proxy
from policy_guard import check_policy

HERE=Path(__file__).resolve().parent
FAIR=HERE.parent
OLD=FAIR/'deepseek-capture-v2'
CONTROLS={'model':'deepseek-flash','stream':True,'max_tokens':8192,
          'reasoning_effort':'high','thinking':{'type':'enabled'},'stream_options':{'include_usage':True}}
POLICY={'schema_version':1,'profile':'fixed-flash-v1','route':'deepseek-proxy','client':'light','controls':CONTROLS}

def assemble(client='light'):
    # Source-pinned synthetic recipe, never expected hashes from captured wire.
    fixture=capture.load_source(OLD/'fixture.py','9abcce4e4244e044975ac575cb518202412d54c19a29a1b644572ad50d2113ce')
    data=fixture['build']({'profile':'light-flash-base-v2' if client=='light' else 'pi-flash-v0731-v2','task':'Synthetic task.','run_id':'test'})
    data['body'].update(copy.deepcopy(CONTROLS))
    contract=json.loads(base64.b64decode(data['contract_base64']))
    envelope={k:v for k,v in data['body'].items() if k!='messages'}
    contract.update(envelope_fields=sorted(envelope),envelope_sha256=capture.sha(capture.encode(envelope)))
    raw=capture.encode(contract);data['contract_base64']=base64.b64encode(raw)
    data['expected']['contract_sha256']=capture.sha(raw)
    return data

class Response:
    status=200
    headers={'Content-Type':'text/event-stream'}
    def __enter__(self):return self
    def __exit__(self,*args):return False
    def __iter__(self):
        yield b'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":10,"prompt_cache_hit_tokens":2}}\n\n'
        yield b'data: [DONE]\n\n'

class Case:
    def __init__(self,client='light'):
        self.root=Path(tempfile.mkdtemp(prefix='flash-policy-test-'))
        self.out=self.root/'capture';self.out.mkdir(mode=0o700)
        self.data=assemble(client)
        self.owner=capture.Owner(directory=self.out,contract_bytes=base64.b64decode(self.data['contract_base64']),expected=self.data['expected'],deployed_source_pins=self.data['deployed_source_pins'],proxy_source_sha256=capture.sha((HERE/'proxy.py').read_bytes()),capture_source_sha256=capture.sha((HERE/'capture.py').read_bytes()))
        self.state={'dir':self.root,'calls':0,'records':[]};self.sent=[];self.errors=[]
        self.policy=copy.deepcopy(POLICY);self.policy['client']=client
        self.raw_policy=capture.encode(self.policy)
        proxy.__dict__.update(ROOT=self.root,LEDGER=self.root/'spend.jsonl',KEY='synthetic-only',PROVIDER='deepseek',
            PRICING={'models':{'deepseek-flash':{'usd_per_million_tokens':[.1,.2,.3]},'other-priced':{'usd_per_million_tokens':[.1,.2,.3]}},'peak_weekdays_utc':[],'peak_hours_utc':[],'peak_multiplier':2},
            LOCK=threading.Lock(),RATE_LIMITED=threading.Event(),ACTIVE={'test':self.state},
            BALANCE_FLOOR=1,BALANCE_SNAPSHOT={'balance':100,'spent':0},SPEND_CAP=10,MAX_CALLS=45,
            time=types.SimpleNamespace(time=lambda:1700000000.0),OWNER=self.owner,
            FIXED_POLICY_BYTES=self.raw_policy,FIXED_POLICY_SHA256=capture.sha(self.raw_policy))
    def run(self,body=None,fault=None):
        def upstream(req,timeout):
            self.sent.append(req.data)
            if fault=='http500':raise urllib.error.HTTPError(req.full_url,500,'synthetic',{},io.BytesIO(b'error'))
            return Response()
        proxy.urllib=types.SimpleNamespace(error=urllib.error,request=types.SimpleNamespace(Request=urllib.request.Request,urlopen=upstream))
        handler=proxy.Proxy.__new__(proxy.Proxy)
        body=self.data['body'] if body is None else body
        raw=json.dumps(body,indent=2).encode() if not isinstance(body,bytes) else body
        handler.path='/test/chat/completions';handler.rfile=io.BytesIO(raw);handler.headers={'Content-Length':str(len(raw))};handler.wfile=io.BytesIO()
        handler.send_response=lambda *_:None;handler.send_header=lambda *_:None;handler.end_headers=lambda:None
        self.errors=[];handler.send_error=lambda *args:self.errors.append(args)
        with patch('urllib.request.urlopen',side_effect=AssertionError('network forbidden')):handler.forward()
    def journal(self,name):
        path=self.root/name
        return path.read_bytes() if path.exists() else b''

class Tests(unittest.TestCase):
    def test_source_identity_financial_blocks_and_capture(self):
        old=(OLD/'proxy.py').read_text();new=(HERE/'proxy.py').read_text()
        self.assertEqual(capture.sha(old.encode()),'9377a87555baabdb05aef06d026b68d807ce97db8352fb6fdd9c5f3aca2f5f5f')
        self.assertEqual((HERE/'capture.py').read_bytes(),(OLD/'capture.py').read_bytes())
        def funcs(raw):return {n.name:ast.get_source_segment(raw,n) for n in ast.parse(raw).body if isinstance(n,ast.FunctionDef)}
        self.assertEqual(funcs(old),funcs(new))
        for start,end in [('            used=spend()',"        dest=state['dir']"),('        hit=usage.get(','        # Optional evidence')]:
            self.assertEqual(old[old.index(start):old.index(end)],new[new.index(start):new.index(end)])
    def test_initial_and_later_calls_for_both_clients(self):
        for client in ['light','pi']:
            with self.subTest(client=client):
                c=Case(client);c.run();c.run()
                self.assertEqual(c.errors,[]);self.assertEqual(c.state['calls'],2);self.assertEqual(len(c.sent),2)
                self.assertEqual(len(c.journal('spend.jsonl').splitlines()),2)
                self.assertEqual(len(c.journal('deepseek-reservations.jsonl').splitlines()),2)
                self.assertEqual(json.loads(c.sent[1])['reasoning_effort'],'high')
                self.assertNotEqual(c.sent[0],json.dumps(c.data['body'],indent=2).encode())
    def test_initial_and_later_mismatches_reserve_and_send_nothing_new(self):
        changes=[('reasoning_effort','low'),('thinking',{'type':'disabled'}),('max_tokens',8191),('max_tokens',True),('stream',False),('stream_options',{'include_usage':False}),('model','other-priced'),('temperature',0)]
        for first in [True,False]:
            for field,value in changes:
                with self.subTest(first=first,field=field,value=value):
                    c=Case()
                    if not first:c.run()
                    before={n:c.journal(n) for n in ['spend.jsonl','deepseek-reservations.jsonl']}
                    b=copy.deepcopy(c.data['body']);b[field]=value;c.run(b)
                    self.assertEqual(len(c.sent),0 if first else 1);self.assertEqual(c.state['calls'],0 if first else 1)
                    self.assertEqual(c.errors,[(400,'Capture binding refused')])
                    for name,raw in before.items():self.assertEqual(c.journal(name),raw)
    def test_missing_malformed_wrong_pin_or_wrong_client_policy(self):
        for fault in ['absent','malformed','pin','client']:
            with self.subTest(fault=fault):
                c=Case()
                if fault=='absent':proxy.FIXED_POLICY_BYTES=None
                if fault=='malformed':proxy.FIXED_POLICY_BYTES=b'{'
                if fault=='pin':proxy.FIXED_POLICY_SHA256='0'*64
                if fault=='client':
                    p=copy.deepcopy(c.policy);p['client']='pi';proxy.FIXED_POLICY_BYTES=capture.encode(p);proxy.FIXED_POLICY_SHA256=capture.sha(proxy.FIXED_POLICY_BYTES)
                c.run();self.assertEqual(c.sent,[]);self.assertEqual(c.journal('deepseek-reservations.jsonl'),b'')
    def test_forwarded_bytes_are_independently_checked(self):
        c=Case();body=copy.deepcopy(c.data['body']);body['reasoning_effort']='low'
        with self.assertRaisesRegex(capture.Unknown,'fixed_policy_refused'):
            check_policy(capture.encode(c.data['body']),capture.encode(body),c.raw_policy,capture.sha(c.raw_policy),'light',1)
    def test_existing_hold_unchanged_when_policy_refuses(self):
        c=Case();raw=b'{"run":"unknown","call":1,"reserve":1}\n';(c.root/'deepseek-reservations.jsonl').write_bytes(raw)
        b=copy.deepcopy(c.data['body']);b['max_tokens']=8191;c.run(b)
        self.assertEqual(c.journal('deepseek-reservations.jsonl'),raw);self.assertEqual(c.sent,[])
    def test_original_balance_floor_spend_cap_and_rate_stop(self):
        for fault in ['floor','spend','stop']:
            with self.subTest(fault=fault):
                c=Case()
                if fault=='floor':proxy.BALANCE_SNAPSHOT={'balance':1,'spent':0}
                if fault=='spend':proxy.SPEND_CAP=0
                if fault=='stop':proxy.RATE_LIMITED.set()
                c.run();self.assertEqual(c.sent,[]);self.assertEqual(c.journal('deepseek-reservations.jsonl'),b'')
                self.assertTrue(c.state['budget_stop']);self.assertEqual(c.errors[0][0],429)
    def test_usage_and_settlement_on_original_http_failure(self):
        c=Case();c.run(fault='http500');self.assertEqual(len(c.sent),1)
        record=json.loads(c.journal('spend.jsonl'));reserve=json.loads(c.journal('deepseek-reservations.jsonl'))
        self.assertEqual(record['error']['status'],500);self.assertEqual(record['budget_charge_usd'],reserve['reserve'])
    def test_optional_capture_failure_does_not_change_settlement(self):
        c=Case()
        with patch.object(c.owner,'publish',side_effect=OSError('synthetic')):c.run()
        self.assertEqual(len(c.sent),1);self.assertEqual(len(c.journal('spend.jsonl').splitlines()),1)
        self.assertEqual(c.state['reserved'],{})

if __name__=='__main__':unittest.main()
