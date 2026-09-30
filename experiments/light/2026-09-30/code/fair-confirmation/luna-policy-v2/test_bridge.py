"""Strict bridge transport bounds; no observer, ledger, network or credentials."""
import base64
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
HERE=Path(__file__).resolve().parent
pure=runpy.run_path(str(HERE.parent/'all-call-policy-v1/policy.py'))
bridge=runpy.run_path(str(HERE/'policy_bridge.py'))
C={'model':'gpt-6-luna','stream':True,'store':False,'max_output_tokens':8192,'reasoning':{'effort':'low','summary':'auto'},'include':['reasoning.encrypted_content']}
policy=json.dumps({'schema_version':1,'profile':'fixed-luna-v1','route':'openai-direct','client':'light','controls':C}).encode()
pin=hashlib.sha256(policy).hexdigest()
def payload(request):return {'request':base64.b64encode(request).decode(),'policy':base64.b64encode(policy).decode(),'expected_sha256':pin,'client':'light','ordinal':2}
def call(raw):
    p=subprocess.run([sys.executable,'-I','-S','-B',str(HERE/'policy_bridge.py')],input=raw,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10,env={})
    assert p.returncode==0 and not p.stderr
    return json.loads(p.stdout)
class Tests(unittest.TestCase):
    def test_request_bounds_match_pure_policy_including_reviewer_repro(self):
        for sizes in [[20],[450000,450000],[900000,900000,900000,900000],[1100000],[900000]*5]:
            with self.subTest(sizes=sizes):
                request=json.dumps(dict(C,input=[{'role':'user','content':'x'*n} for n in sizes])).encode()
                expected=pure['check_request'](request_bytes=request,policy_bytes=policy,expected_policy_sha256=pin,client='light',route='openai-direct',call_ordinal=2)
                actual=call(json.dumps(payload(request)).encode())
                if len(request)<=4*1024*1024:self.assertEqual(actual,expected)
                else:self.assertFalse(actual['policy_verified'])
    def test_strict_transport_envelope(self):
        good=payload(b'{}');raw=json.dumps(good).encode()
        for bad in [b'\xef\xbb\xbf'+raw,raw+b'x',b'[]',b'{"x":NaN}',raw.replace(b'"ordinal": 2',b'"ordinal": 2,"ordinal": 2')]:
            with self.subTest(raw=bad[:40]):
                with self.assertRaises(Exception):bridge['envelope'](bad)
        for field,value in [('ordinal',True),('ordinal',0),('ordinal',2.0),('client',[]),('request',{}),('request','\ud800'),('policy',None),('expected_sha256','x'*64)]:
            with self.subTest(field=field,value=type(value).__name__):
                changed=dict(good);changed[field]=value
                with self.assertRaises(Exception):bridge['envelope'](json.dumps(changed).encode())
    def test_invalid_base64_and_extra_fields_refuse(self):
        good=payload(b'{}')
        for changes in [{'request':'@@@'},{'policy':'@@@'},{'extra':'private'}]:
            value=dict(good);value.update(changes)
            result=call(json.dumps(value).encode());self.assertFalse(result['policy_verified']);self.assertNotIn('private',json.dumps(result))
    def test_explicit_encoded_bounds(self):
        good=payload(b'{}')
        for field,size in [('request',4*((4*1024*1024+2)//3)+1),('policy',4*((64*1024+2)//3)+1)]:
            value=dict(good);value[field]='A'*size
            with self.assertRaises(Exception):bridge['envelope'](json.dumps(value).encode())
        with self.assertRaises(Exception):bridge['envelope'](b' '*(bridge['MAX']+1))
if __name__=='__main__':unittest.main()
