"""Synthetic transports only. No socket, real key, old ledger or client launch."""
import ast
import base64
import contextlib
import copy
import datetime
import http.server
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

import capture
import fixture
import proxy

HERE = Path(__file__).resolve().parent
ORIGINAL = Path('/private/tmp/light-ultra/bench/converge/runner.py')
PLAN = '- [ ] Implement the change\n- [ ] Run validation\n'


def chunk(delta, finish=None, **extra):
    return {'id':'response-test', 'object':'chat.completion.chunk',
            'choices':[{'index':0,'delta':delta,'finish_reason':finish}], **extra}


def stream(events=None, done=True):
    if events is None:
        events = [chunk({'role':'assistant'}), chunk({'content':PLAN}),
                  chunk({},'stop',usage={'prompt_tokens':20,'completion_tokens':10,'prompt_cache_hit_tokens':2})]
    return (''.join('data: '+json.dumps(event)+'\n\n' for event in events)
            + ('data: [DONE]\n\n' if done else '')).encode()


def load_original():
    raw = ORIGINAL.read_bytes()
    assert capture.sha(raw) == proxy.ORIGINAL_RUNNER_SHA256
    tree = ast.parse(raw)
    names = {'write_json','balance','spend','pending_reservations','admit_reservation','rates','reservation','Proxy'}
    nodes = [node for node in tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in names]
    ns = {'__name__':'_frozen_original_test', 'datetime':datetime,'http':http,'json':json,'os':os}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),str(ORIGINAL),'exec'),ns)
    return ns


class Response:
    status = 200
    headers = {'Content-Type':'text/event-stream'}
    def __init__(self, raw, fault=None): self.raw,self.fault = raw,fault
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def __iter__(self):
        for index,line in enumerate(self.raw.splitlines(keepends=True)):
            if self.fault == 'read' and index == 3: raise OSError('synthetic read failure')
            yield line
        if self.fault == 'late-read': raise OSError('synthetic read failure')


class Sink(io.BytesIO):
    def __init__(self, fault=None): super().__init__();self.fault=fault
    def write(self, raw):
        if self.fault == 'disconnect': raise BrokenPipeError('synthetic disconnect')
        if self.fault == 'reset': raise ConnectionResetError('synthetic reset')
        return super().write(raw)


class Case:
    def __init__(self, test, profile='light-flash-base-v2', original=False, changes=None):
        self.temp = tempfile.TemporaryDirectory(prefix='flash-capture-test-')
        test.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root/'capture';self.output.mkdir(mode=0o700)
        self.data = fixture.build({'profile':profile,'task':'Synthetic task: preserve caf\u00e9.','run_id':'test'})
        self.incoming = json.dumps(self.data['body'],ensure_ascii=False,indent=2).encode()
        self.owner = capture.Owner(directory=self.output,
            contract_bytes=base64.b64decode(self.data['contract_base64']), expected=self.data['expected'],
            deployed_source_pins=self.data['deployed_source_pins'],
            proxy_source_sha256=capture.sha((HERE/'proxy.py').read_bytes()),
            capture_source_sha256=capture.sha((HERE/'capture.py').read_bytes()))
        self.ns = load_original() if original else proxy.__dict__
        self.state = {'dir':self.root,'calls':0,'records':[]}
        self.requests = []
        self.ns.update(ROOT=self.root,LEDGER=self.root/'spend.jsonl',KEY='synthetic-unused-key',PROVIDER='deepseek',
            PRICING={'models':{'deepseek-flash':{'usd_per_million_tokens':[.1,.2,.3]}},
                     'peak_weekdays_utc':[],'peak_hours_utc':[],'peak_multiplier':2},
            LOCK=threading.Lock(),RATE_LIMITED=threading.Event(),ACTIVE={'test':self.state},
            BALANCE_FLOOR=1,BALANCE_SNAPSHOT={'balance':100,'spent':0},SPEND_CAP=10,MAX_CALLS=45,
            time=types.SimpleNamespace(time=lambda:1700000000.0),OWNER=self.owner)
        if changes:self.ns.update(changes)

    def run(self, fault=None, raw=None, incoming=None):
        raw = stream() if raw is None else raw
        def upstream(request,timeout):
            self.requests.append(request)
            if fault == 'http400' or fault == 'http500':
                raise urllib.error.HTTPError(request.full_url,int(fault[4:]),'synthetic',{},io.BytesIO(b'synthetic response'))
            response = Response(raw,fault)
            if fault == 'content-type': response.headers={'Content-Type':'application/json'}
            if fault == 'status': response.status=201
            return response
        self.ns['urllib'] = types.SimpleNamespace(error=urllib.error,
            request=types.SimpleNamespace(Request=urllib.request.Request,urlopen=upstream))
        handler = self.ns['Proxy'].__new__(self.ns['Proxy'])
        body = self.incoming if incoming is None else incoming
        handler.path='/test/chat/completions';handler.rfile=io.BytesIO(body)
        handler.headers={'Content-Length':str(len(body))};handler.wfile=Sink(fault)
        handler.send_response=lambda *_:None;handler.send_header=lambda *_:None;handler.end_headers=lambda:None
        self.errors=[];handler.send_error=lambda *args:self.errors.append(args)
        # Assert that even accidental native calls fail locally, not on a network.
        with patch('urllib.request.urlopen',side_effect=AssertionError('native transport forbidden')):
            handler.forward()
        return handler

    def finish(self):
        return self.owner.finalize(admitted_calls=self.state['calls'],owner_quiescent=True)

    def score(self, capability, **changes):
        return self.owner.score(capability,**{**dict(planning_required=True,code_artifact_pass=True,
            normal_exit=True,timed_out=False,budget_stopped=False),**changes})


class CaptureTests(unittest.TestCase):
    def test_financial_functions_and_blocks_are_source_identical(self):
        old = ORIGINAL.read_text();new=(HERE/'proxy.py').read_text()
        self.assertEqual(capture.sha(old.encode()),proxy.ORIGINAL_RUNNER_SHA256)
        def functions(raw):return {node.name:ast.get_source_segment(raw,node) for node in ast.parse(raw).body if isinstance(node,ast.FunctionDef)}
        for name in ('write_json','balance','spend','pending_reservations','admit_reservation','rates','reservation'):
            self.assertEqual(functions(old)[name],functions(new)[name])
        for start,end in [("            used=spend()","        dest=state['dir']"),
                          ("        hit=usage.get(","\n\ndef cmd(")]:
            original = old[old.index(start):old.index(end)]
            if start.startswith('        hit='):
                original=original.rstrip();actual=new[new.index(start):new.index('        # Optional evidence')].rstrip()
            else:actual=new[new.index(start):new.index(end)]
            self.assertEqual(original,actual)
        self.assertIn("(state['dir']/f'response-{n:03}.txt').write_bytes(raw)",new)

    def test_differential_original_financial_and_delivery_behavior(self):
        for fault in (None,'disconnect','reset','read','late-read','http400','http500','content-type','status'):
            with self.subTest(fault=fault):
                old=Case(self,original=True);old_handler=old.run(fault)
                new=Case(self);new_handler=new.run(fault)
                for filename in ('spend.jsonl','deepseek-reservations.jsonl','usage-001.json','wire-001.json'):
                    self.assertEqual((old.root/filename).read_bytes(),(new.root/filename).read_bytes())
                self.assertEqual(old.ns['pending_reservations'](),new.ns['pending_reservations']())
                self.assertEqual(old_handler.wfile.getvalue(),new_handler.wfile.getvalue())
                self.assertEqual(old.requests[0].data,new.requests[0].data)
                self.assertEqual(old.state['reserved'],new.state['reserved'])
                self.assertEqual(old.errors,new.errors)
                result=new.score(new.finish())
                self.assertEqual(result['visible_plan_format_pass'], True if fault is None else None)
                self.assertTrue(result['code_completion'])

    def test_all_three_source_owned_flash_layouts_bind_and_score(self):
        for profile in ('light-flash-base-v2','light-flash-one-setup-v2','pi-flash-v0731-v2'):
            with self.subTest(profile=profile):
                case=Case(self,profile);case.run();result=case.score(case.finish())
                self.assertTrue(result['capture_verified']);self.assertTrue(result['binding_verified'])
                self.assertTrue(result['visible_plan_format_pass'])
                receipt=json.loads((case.output/'capture-001.json').read_bytes())
                self.assertNotEqual(receipt['incoming_sha256'],receipt['forwarded_sha256'])
                self.assertEqual(receipt['incoming_sha256'],capture.sha(case.incoming))
                self.assertEqual(receipt['forwarded_sha256'],capture.sha(case.requests[0].data))
                self.assertEqual((case.output/'forwarded-001.json').read_bytes(),case.requests[0].data)
                self.assertEqual((case.output/'output-001.sse').read_bytes(),stream())
                self.assertNotIn(PLAN,str(result));self.assertNotIn('synthetic-unused-key',str(receipt))

    def test_bad_json_and_mutated_bindings_never_admit_or_send(self):
        for mutation in ('duplicate','unicode','overflow','task','auxiliary','role','envelope','extra','contract','sources','missing-owner','short','later'):
            with self.subTest(mutation=mutation):
                case=Case(self);body=copy.deepcopy(case.data['body']);incoming=None
                if mutation=='duplicate':incoming=case.incoming[:-1]+b',"stream":true}'
                elif mutation=='unicode':incoming=case.incoming[:-1]+b',"extra":"\\ud800"}'
                elif mutation=='overflow':incoming=case.incoming[:-1]+b',"extra":1e999}'
                elif mutation=='task':body['messages'][-1]['content']='mutated'
                elif mutation=='auxiliary':body['messages'][0]['content']='mutated'
                elif mutation=='role':body['messages'][-1]['role']='system'
                elif mutation=='envelope':body['max_tokens']=1
                elif mutation=='extra':body['context']='extra'
                elif mutation=='contract':case.owner.contract=b'{}'
                elif mutation=='sources':case.owner.sources={}
                elif mutation=='missing-owner':case.ns['OWNER']=None
                elif mutation=='short':incoming=b'{'
                elif mutation=='later':case.state['calls']=1
                case.run(incoming=incoming if incoming is not None else json.dumps(body).encode())
                self.assertEqual(case.requests,[])
                self.assertFalse((case.root/'deepseek-reservations.jsonl').exists())
                self.assertFalse((case.root/'spend.jsonl').exists())
                self.assertEqual(case.errors[0][0],400)

    def test_original_floor_cap_call_and_stop_guards_preserved(self):
        for changes in ({'BALANCE_SNAPSHOT':None},{'SPEND_CAP':0},{'MAX_CALLS':0}):
            old=Case(self,original=True,changes=changes);old.run()
            new=Case(self,changes=changes);new.run()
            self.assertEqual(old.state['stop_reason'],new.state['stop_reason'])
            self.assertEqual(old.errors,new.errors)
            self.assertEqual(new.requests,[])
            self.assertFalse((new.root/'deepseek-reservations.jsonl').exists())
        for original in (True,False):
            case=Case(self,original=original);case.ns['RATE_LIMITED'].set();case.run()
            self.assertEqual(case.state['stop_reason'],'provider_subset_stop')

    def test_original_response_write_failure_does_not_change_settlement(self):
        old_write=Path.write_bytes
        def fail(path,raw):
            if path.name=='response-001.txt':raise OSError('synthetic original response failure')
            return old_write(path,raw)
        with patch.object(Path,'write_bytes',fail):
            old=Case(self,original=True);old.run()
            new=Case(self);new.run()
        self.assertEqual((old.root/'spend.jsonl').read_bytes(),(new.root/'spend.jsonl').read_bytes())
        self.assertIsNone(new.score(new.finish())['visible_plan_format_pass'])

    def test_optional_publication_failure_cannot_change_settlement(self):
        original=Case(self,original=True);original.run()
        for stage in ('incoming-001.json','forwarded-001.json','output-001.sse','capture-001.json'):
            with self.subTest(stage=stage):
                case=Case(self);real=capture.publish_bytes
                def fail(path,raw):
                    if path.name==stage:raise OSError('synthetic publication failure')
                    return real(path,raw)
                with patch.object(capture,'publish_bytes',fail):case.run()
                self.assertEqual((case.root/'spend.jsonl').read_bytes(),(original.root/'spend.jsonl').read_bytes())
                self.assertEqual(case.state['reserved'],{})
                with self.assertRaisesRegex(capture.Unknown,'missing_publication_ack'):case.finish()
                self.assertIsNone(case.score(None)['visible_plan_format_pass'])

    def test_receipt_double_fault_surviving_file_is_not_authority(self):
        case=Case(self);real=capture.publish_bytes
        def double_fault(path,raw):
            if path.name!='capture-001.json':return real(path,raw)
            with patch.object(capture,'sync_directory',side_effect=OSError('sync failed')), \
                 patch.object(capture.os,'unlink',side_effect=OSError('unlink failed')):
                return real(path,raw)
        with patch.object(capture,'publish_bytes',double_fault):case.run()
        self.assertTrue((case.output/'capture-001.json').exists())
        self.assertTrue((case.root/'spend.jsonl').exists())
        with self.assertRaises(capture.Unknown):case.finish()
        for fake in (None,object(),json.loads((case.output/'capture-001.json').read_bytes())):
            self.assertIsNone(case.score(fake)['visible_plan_format_pass'])

    def test_inventory_commit_failure_never_issues_capability(self):
        case=Case(self);case.run()
        with patch.object(capture,'sync_directory',side_effect=OSError('sync failed')):
            with self.assertRaises(OSError):case.finish()
        self.assertTrue((case.output/'publication-inventory.json').exists())
        self.assertIsNone(case.score(None)['visible_plan_format_pass'])
        with self.assertRaisesRegex(capture.Unknown,'owner_already_closed'):case.finish()

    def test_missing_foreign_or_unfinalized_capability_stays_unknown(self):
        case=Case(self);case.run()
        self.assertIsNone(case.score(None)['visible_plan_format_pass'])
        other=Case(self);other.run();other_cap=other.finish()
        self.assertIsNone(case.score(other_cap)['visible_plan_format_pass'])
        cap=case.finish();self.assertTrue(case.score(cap)['visible_plan_format_pass'])
        with self.assertRaises(capture.Unknown):case.owner.preflight('test',2,case.incoming,json.dumps(case.data['body']).encode())

    def test_tamper_artifacts_and_inventory_refuses_without_affecting_code(self):
        for name in ('incoming-001.json','forwarded-001.json','output-001.sse','capture-001.json','publication-inventory.json'):
            case=Case(self);case.run();cap=case.finish();path=case.output/name
            path.write_bytes(path.read_bytes()+b' ')
            result=case.score(cap)
            self.assertIsNone(result['visible_plan_format_pass']);self.assertTrue(result['code_completion'])

    def test_eof_is_not_completion_hidden_text_or_combined_order_proof(self):
        cases=[stream(done=False),b'data: not-json\n\n',
               stream([chunk({'reasoning_content':PLAN}),chunk({},'stop')]),
               stream([chunk({'content':PLAN,'tool_calls':[{'index':0}]},'tool_calls')])]
        for index,raw in enumerate(cases):
            case=Case(self);case.run(raw=raw);result=case.score(case.finish())
            self.assertIs(result['visible_plan_format_pass'],False if index==2 else None)

    def test_upstream_error_and_malformed_usage_preserve_original_financial_semantics(self):
        for events in ([chunk({'content':PLAN}), {'type':'error','code':'synthetic_error'},
                        chunk({},'stop',usage={'prompt_tokens':20,'completion_tokens':10})],
                       [chunk({},'stop',usage={'prompt_tokens':20})]):
            old=Case(self,original=True);old.run(raw=stream(events))
            new=Case(self);new.run(raw=stream(events))
            self.assertEqual((old.root/'spend.jsonl').read_bytes(),(new.root/'spend.jsonl').read_bytes())
            # This is NOT a new usage/accounting validator. The retained legacy
            # truthy-usage rule is characterized, not silently repaired.
            self.assertEqual(old.state['records'][0]['usage_missing'],False)
            if any(event.get('type')=='error' for event in events):
                self.assertIsNone(new.score(new.finish())['visible_plan_format_pass'])

    def test_nonstream_initial_request_refused_before_reservation(self):
        case=Case(self);body=case.data['body'];body['stream']=False
        case.run(incoming=json.dumps(body).encode())
        self.assertEqual(case.requests,[])
        self.assertFalse((case.root/'deepseek-reservations.jsonl').exists())

    def test_no_later_success_search_and_all_calls_must_publish(self):
        case=Case(self);case.run(raw=stream(done=False));case.run()
        self.assertIsNone(case.score(case.finish())['visible_plan_format_pass'])
        case=Case(self);case.run()
        with patch.object(case.owner,'publish',side_effect=OSError('second publication failed')):case.run()
        with self.assertRaisesRegex(capture.Unknown,'missing_publication_ack'):case.finish()

    def test_optional_output_limit_does_not_change_financial_record(self):
        old=Case(self,original=True);old.run()
        case=Case(self)
        with patch.object(capture,'MAX_RESPONSE',4):case.run()
        self.assertEqual((old.root/'spend.jsonl').read_bytes(),(case.root/'spend.jsonl').read_bytes())
        with self.assertRaisesRegex(capture.Unknown,'missing_publication_ack'):case.finish()

    def test_request_size_limit_is_pre_admission(self):
        case=Case(self);case.run(incoming=b' '*(capture.MAX_REQUEST+1))
        self.assertEqual(case.requests,[]);self.assertFalse((case.root/'deepseek-reservations.jsonl').exists())

    def test_original_ledger_failure_retains_reservation_no_publication(self):
        case=Case(self);original_open=Path.open
        def fail(path,*args,**kwargs):
            if path.name=='spend.jsonl':raise OSError('synthetic ledger failure')
            return original_open(path,*args,**kwargs)
        with patch.object(Path,'open',fail):
            with self.assertRaises(OSError):case.run()
        self.assertTrue((case.root/'deepseek-reservations.jsonl').exists())
        self.assertFalse((case.output/'capture-001.json').exists())
        self.assertGreater(case.ns['pending_reservations'](),0)

    def test_original_wire_ledger_and_usage_write_faults_are_differential(self):
        for filename in ('wire-001.json','spend.jsonl','usage-001.json'):
            with self.subTest(filename=filename):
                original_open=Path.open
                def fail(path,*args,**kwargs):
                    if path.name==filename:raise OSError('synthetic original write fault')
                    return original_open(path,*args,**kwargs)
                cases=[]
                for original in (True,False):
                    case=Case(self,original=original)
                    with patch.object(Path,'open',fail):
                        with self.assertRaises(OSError):case.run()
                    cases.append(case)
                old,new=cases
                self.assertEqual(old.state['reserved'],new.state['reserved'])
                self.assertEqual(old.ns['pending_reservations'](),new.ns['pending_reservations']())
                for name in ('deepseek-reservations.jsonl','spend.jsonl','usage-001.json'):
                    a,b=old.root/name,new.root/name
                    self.assertEqual(a.exists(),b.exists())
                    if a.exists():self.assertEqual(a.read_bytes(),b.read_bytes())
                self.assertEqual(len(old.requests),len(new.requests))
                self.assertFalse((new.output/'capture-001.json').exists())

    def test_symlink_capture_and_wrong_source_pins_are_refused(self):
        case=Case(self);case.run();cap=case.finish()
        output=case.output/'output-001.sse';raw=output.read_bytes();output.unlink()
        target=case.root/'alias-target';target.write_bytes(raw);output.symlink_to(target)
        self.assertIsNone(case.score(cap)['visible_plan_format_pass'])
        with self.assertRaisesRegex(capture.Unknown,'proxy_source_mismatch'):
            capture.Owner(directory=case.output,contract_bytes=b'{}',expected={},deployed_source_pins={},
                          proxy_source_sha256='0'*64,capture_source_sha256='0'*64)

    def test_full_owner_process_crash_at_publication_boundaries_preserves_settlement(self):
        for stage in ('capture-001.json','publication-inventory.json'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(prefix='flash-owner-crash-') as root:
                script = '''
import json,os
from pathlib import Path
from unittest.mock import patch
import capture,proxy,test_capture
class T:
    def addCleanup(self,*args):pass
case=test_capture.Case(T())
# Preserve task-owned fixture after abrupt child death for parent verification.
Path(os.environ['SYNTHETIC_LOCATOR']).write_text(str(case.root))
original=capture.publish_bytes
def crash(path,raw):
    original(path,raw)
    if path.name==os.environ['SYNTHETIC_STAGE']:os._exit(73)
with patch.object(capture,'publish_bytes',crash):
    case.run();case.finish()
'''
                locator=Path(root)/'locator'
                result=subprocess.run([sys.executable,'-B','-c',script],cwd=HERE,
                    env={'PATH':os.defpath,'SYNTHETIC_LOCATOR':str(locator),'SYNTHETIC_STAGE':stage},
                    capture_output=True,timeout=10)
                self.assertEqual(result.returncode,73)
                owned=Path(locator.read_text())
                # Locator is emitted by this exact pinned synthetic child, not
                # an untrusted workload; nevertheless restrict task-owned path.
                self.assertTrue(owned.name.startswith('flash-capture-test-'))
                try:
                    self.assertTrue((owned/'spend.jsonl').exists())
                    self.assertTrue((owned/'capture'/stage).exists())
                    self.assertEqual(len((owned/'spend.jsonl').read_text().splitlines()),1)
                    case=Case(self)
                    self.assertIsNone(case.score(json.loads((owned/'capture'/stage).read_bytes()))['visible_plan_format_pass'])
                finally:
                    import shutil
                    shutil.rmtree(owned)

    def test_process_exit_after_receipt_link_cannot_mint_live_capability(self):
        # Child only runs this synthetic fixture; no client/network/native fetch.
        for filename in ('capture-001.json','publication-inventory.json'):
            with tempfile.TemporaryDirectory(prefix='flash-crash-test-') as root:
                script = '''
import os
from pathlib import Path
from unittest.mock import patch
import capture
target=Path(os.environ['SYNTHETIC_TARGET'])
real=os.link
def crash(source,destination,**kw):
    real(source,destination,**kw)
    os._exit(73)
with patch.object(capture.os,'link',crash):capture.publish_bytes(target,b'{"synthetic":true}')
'''
                target=Path(root)/filename
                result=subprocess.run([sys.executable,'-B','-c',script],cwd=HERE,
                    env={'PATH':os.defpath,'SYNTHETIC_TARGET':str(target)},capture_output=True,timeout=10)
                self.assertEqual(result.returncode,73);self.assertTrue(target.exists())
                case=Case(self)
                self.assertIsNone(case.score(json.loads(target.read_bytes()))['visible_plan_format_pass'])


if __name__=='__main__':unittest.main()
