"""UNEXECUTED DRAFT. Synthetic trusted-parent capabilities, not process proofs.

Node tests exercise the actual finalizer/accounting. These isolated wrapper
tests explicitly play the trusted-parent role; their calculated capability is
not a recipe for recovering authority from production surviving files.
"""
import copy
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest import mock

import score_gate as subject

HERE = Path(__file__).resolve().parent
# Accepted independent assembly recipe, not an expected value learned from a
# captured request. Loading the recipe does not run its unittest methods.
recipe = runpy.run_path(str(HERE.parent / 'shared-luna-binding-v1' / 'binding_test.py'))
PLAN = '- [ ] Implement the change\n- [ ] Run tests\n'
ROOTS = []


def encoded(value):
    return json.dumps(value, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def response():
    part = {'type': 'output_text', 'text': PLAN}
    item = {'type': 'message', 'id': 'm1', 'role': 'assistant', 'content': [part]}
    common = {'item_id': 'm1', 'output_index': 0, 'content_index': 0}
    events = [
        {'type': 'response.created', 'response': {'id': 'r1', 'status': 'in_progress', 'output': []}},
        {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': []}},
        {'type': 'response.content_part.added', **common, 'part': {'type': 'output_text', 'text': ''}},
        {'type': 'response.output_text.delta', **common, 'delta': PLAN},
        {'type': 'response.output_text.done', **common, 'text': PLAN},
        {'type': 'response.content_part.done', **common, 'part': part},
        {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
        {'type': 'response.completed', 'response': {'id': 'r1', 'status': 'completed', 'output': [item]}},
    ]
    return b''.join(b'data: '+encoded({**event, 'sequence_number': n})+b'\n' for n,event in enumerate(events))


def child(pid, ipc):
    return dict(pid=pid,spawned=True,exit_observed=True,closed=True,ipc_disconnected=ipc,
        exit_code=0,exit_signal=None,close_code=0,close_signal=None,invalid=False,error=False,
        timed_out=False,kill_attempted=False,kill_failed=False)


def fixture(client='pi', count=1):
    sealed = recipe['fixture'](client)
    directory = Path(tempfile.mkdtemp(prefix='shared-score-gate-draft-')).resolve()
    ROOTS.append(str(directory))  # Deliberately retain small synthetic roots.
    st = directory.stat()
    directory_identity = {'dev':str(st.st_dev), 'ino':str(st.st_ino)}
    contract = json.loads(sealed['contract_bytes'])
    expected = {key:contract[key] for key in ('run_id','root_turn_id','protocol_id','task_prompt_sha256')}
    expected.update(client=client,binding_profile_id=contract['profile_id'],channel_id='synthetic-channel',
        financial_policy_id='a'*64,observer_source_sha256=subject.OBSERVER,installed_adapter_sha256=subject.ADAPTER,
        binding_source_sha256=subject.BINDING,binding_contract_sha256=subject.sha(sealed['contract_bytes']),
        parent_source_sha256='b'*64,finalizer_source_sha256=subject.sha((HERE/'finalize.mjs').read_bytes()),
        owner_pid=1234,task_pid=1235 if client=='light' else None,
        daemon_identity_sha256='c'*64 if client=='light' else None)
    outcome = dict(normal_exit=True,timed_out=False,budget_stopped=False,code_artifact_pass=True,planning_required=True)
    publications,artifacts,calls = [],[],[]
    for n in range(1,count+1):
        request,output = sealed['request_bytes'],response()
        receipt = dict(client=client,binding_profile_id=expected['binding_profile_id'],schema_version=2,
            protocol_id=expected['protocol_id'],run_id=expected['run_id'],root_turn_id=expected['root_turn_id'],
            request_role='root' if n==1 else 'continuation',admission_id=f'synthetic:{n}',call_ordinal=n,
            prior_root_generations=n-1,initial_request=n==1,route='openai-direct',source='provider_response_sse',
            request_body_sha256=subject.sha(request),task_prompt_sha256=expected['task_prompt_sha256'],
            response_bytes_sha256=subject.sha(output),response_byte_count=len(output),http_status=200,
            response_content_type='text/event-stream',requested_stream=True,transport_outcome='eof',
            downstream_delivery_failed=False,capture_write_complete=True,observer_source_sha256=subject.OBSERVER,
            installed_adapter_sha256=subject.ADAPTER,binding_source_sha256=subject.BINDING,
            binding_contract_sha256=expected['binding_contract_sha256'],initial_binding_verified=n==1)
        receipt_raw = encoded(receipt)
        for name,extension,raw in [('receipt','json',receipt_raw),('request','json',request),('response','sse',output)]:
            (directory/f'capture-{name}-{n:03d}.{extension}').write_bytes(raw)
        ack = {key:expected[key] for key in ('client','binding_profile_id','channel_id','protocol_id','run_id','root_turn_id',
            'observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256')}
        ack.update(kind='luna.capture.published.shared.v6',schema_version=1,admission_id=f'synthetic:{n}',
            call_ordinal=n,publication_ordinal=n,receipt_sha256=subject.sha(receipt_raw),
            request_body_sha256=subject.sha(request),response_bytes_sha256=subject.sha(output),response_byte_count=len(output))
        publications.append(ack)
        artifacts.append(dict(ordinal=n,verified=True,clean=True,reason=None,
            **{key:ack[key] for key in ('receipt_sha256','request_body_sha256','response_bytes_sha256','response_byte_count')}))
        calls.append(dict(ordinal=n,admissionId=f'synthetic:{n}',requestSha256=subject.sha(request),state='known',
            reserveNanodollars='10000000',chargeNanodollars='20000',nominalReserveNanodollars='10000000',nominalChargeNanodollars='20000'))
    accounting = dict(schemaVersion=1,runId='synthetic',ledgerSha256='d'*64,calls=calls,admittedCalls=count,settledCalls=count,
        knownCalls=count,unknownHoldCalls=0,unsettledCalls=0,knownChargeSubtotalNanodollars=str(count*20000),
        unknownHoldNanodollars='0',unsettledReserveNanodollars='0',journalExposureNanodollars=str(count*20000),
        completeUsage=True,chargeTotalNanodollars=str(count*20000),
        knownTokenSubtotals=dict(input=str(count*100),output=str(count*20),cached='0',uncached=str(count*100)),
        tokenTotals=dict(input=str(count*100),output=str(count*20),cached='0',uncached=str(count*100)),
        ackInventoryComplete=True,ackErrors=[],finalizationAuthorized=False)
    lifecycle = dict(schema_version=1,client=client,owner=child(1234,True),task=child(1235,None) if client=='light' else None,
        daemon_identity_sha256=expected['daemon_identity_sha256'],shutdown_acknowledged=True if client=='light' else None,
        pending_operations=False,journal_quiescent=True,sticky_invalid=False)
    inventory = dict(schema_version=1,kind='shared-parent-attempt-v1',expected=copy.deepcopy(expected),
        source_pins=dict(finalizer=expected['finalizer_source_sha256'],parent=expected['parent_source_sha256'],
                         reconcile=subject.RECONCILE,scorer=subject.SCORER),artifact_directory_identity=directory_identity,
        outcome=copy.deepcopy(outcome),lifecycle=lifecycle,ledger=dict(dev='1',ino='2',byte_count=10,sha256='d'*64),
        accounting=accounting,acknowledgments=publications,artifacts=artifacts,terminal_accounting_complete=True,
        clean_publication_candidate=True,reasons=[])
    (directory/'contract.json').write_bytes(sealed['contract_bytes'])
    raw = encoded(inventory)
    (directory/'parent-attempt-v1.json').write_bytes(raw)
    args = dict(directory=str(directory),directory_identity=directory_identity,trusted_clean_commit_sha256=subject.sha(raw),
        expected=expected,outcome=outcome,binding_expected=sealed['expected'],deployed_source_pins=sealed['deployed_source_pins'])
    return args,inventory,directory


class GateTests(unittest.TestCase):
    def unknown(self,args):
        result = subject.score_committed_attempt(**args)
        self.assertFalse(result['parent_publication_verified'],result)
        self.assertFalse(result['capture_verified'],result)
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertTrue(result['code_completion'])
        return result

    def test_both_arms_first_capture_unchanged_grading(self):
        for client in ('pi','light'):
            args,_,_ = fixture(client,2)
            result = subject.score_committed_attempt(**args)
            self.assertTrue(result['parent_publication_verified'],result)
            self.assertTrue(result['capture_verified'],result)
            self.assertTrue(result['binding_verified'],result)
            self.assertTrue(result['visible_plan_format_pass'],result)
            self.assertIsNone(result['plan_semantic_quality'])

    def test_surviving_files_without_returned_token_do_not_grant_authority(self):
        for token in (None,'',False,'0'*64):
            args,_,_ = fixture();args['trusted_clean_commit_sha256']=token;self.unknown(args)

    def test_unclean_attempt_token_is_not_clean_token(self):
        args,inventory,directory = fixture()
        inventory['clean_publication_candidate']=False;inventory['reasons']=['usage_incomplete']
        raw=encoded(inventory);(directory/'parent-attempt-v1.json').write_bytes(raw)
        args['trusted_clean_commit_sha256']=subject.sha(raw)  # Unit role: mistakenly passed attempt token.
        result=self.unknown(args);self.assertEqual(result['parent_evidence_unknown_reason'],'parent_not_clean')

    def test_every_capture_rechecked_not_only_first(self):
        for name in ('capture-receipt-002.json','capture-request-002.json','capture-response-002.sse','contract.json'):
            args,_,directory=fixture(count=2)
            (directory/name).write_bytes((directory/name).read_bytes()+b' ')
            self.unknown(args)

    def test_missing_first_never_selects_later_success(self):
        args,_,directory=fixture(count=2)
        (directory/'capture-response-001.sse').rename(directory/'retained-first.sse')
        self.unknown(args)

    def test_expected_outcome_arm_and_directory_identity_are_independent(self):
        for kind in ('run','arm','outcome','directory'):
            args,_,_=fixture()
            if kind=='run':args['expected']['run_id']='other'
            elif kind=='arm':args['expected'].update(client='light',binding_profile_id=subject.PROFILES['light'],task_pid=1235,daemon_identity_sha256='c'*64)
            elif kind=='outcome':args['outcome']['planning_required']=False
            else:args['directory_identity']={'dev':'0','ino':'0'}
            self.unknown(args)

    def test_code_failure_is_preserved_with_valid_visible_plan(self):
        args,inventory,directory=fixture()
        args['outcome']['code_artifact_pass']=False;inventory['outcome']=copy.deepcopy(args['outcome'])
        raw=encoded(inventory);(directory/'parent-attempt-v1.json').write_bytes(raw);args['trusted_clean_commit_sha256']=subject.sha(raw)
        result=subject.score_committed_attempt(**args)
        self.assertTrue(result['parent_publication_verified']);self.assertTrue(result['visible_plan_format_pass'])
        self.assertFalse(result['code_completion']);self.assertFalse(result['requested_format_contract_pass'])

    def test_code_only_does_not_invent_publication_verification(self):
        args,_,_=fixture();args['outcome']['planning_required']=False;args['trusted_clean_commit_sha256']=None
        result=self.unknown(args);self.assertEqual(result['plan_reason'],'planning_not_required')

    def test_symlink_and_duplicate_json_refused(self):
        args,_,directory=fixture();target=directory/'capture-response-001.sse'
        target.rename(directory/'retained-response.sse');target.symlink_to(directory/'retained-response.sse');self.unknown(args)
        args,_,directory=fixture();raw=b'{"schema_version":1,"schema_version":1}\n'
        (directory/'parent-attempt-v1.json').write_bytes(raw);args['trusted_clean_commit_sha256']=subject.sha(raw)
        self.unknown(args)

    def test_regular_reader_growth_and_truncation_are_bounded(self):
        for mode in ('grow','truncate'):
            root=Path(tempfile.mkdtemp(prefix='shared-score-reader-draft-')).resolve();ROOTS.append(str(root))
            filename=root/'synthetic';filename.write_bytes(b'1234')
            original=subject.os.fdopen;requested=[]
            class Reader:
                def __init__(self,*args,**kwargs):self.handle=original(*args,**kwargs)
                def __enter__(self):return self
                def __exit__(self,*args):self.handle.close()
                def read(self,limit):
                    requested.append(limit)
                    filename.write_bytes(b'x'*4096 if mode=='grow' else b'x')
                    return self.handle.read(limit)
            with mock.patch.object(subject.os,'fdopen',Reader):
                with self.assertRaises(subject.PublicationUnknown):subject.regular(filename,32)
            self.assertEqual(requested,[5])


if __name__=='__main__':unittest.main()
