import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import publication_gate as gate

HERE=Path(__file__).resolve().parent


class PublicationTests(unittest.TestCase):
    def run_fixture(self,fault='none',profile='light-luna-base-v2'):
        temp=tempfile.TemporaryDirectory(prefix='luna-parent-v5-');self.addCleanup(temp.cleanup)
        root=Path(temp.name)
        # Preserve a preexisting unsettled hold in every real subprocess probe.
        prefix=b'{"event":"admit","id":"historic:1","run":"historic","call":1,"reserve":100}\n'
        (root/'luna-api-ledger.jsonl').write_bytes(prefix)
        proc=subprocess.run(['node',str(HERE/'parent_fixture.mjs'),str(root),fault,profile],
            capture_output=True,timeout=20,env={'PATH':os.environ['PATH'],'HOME':str(root)})
        self.assertEqual(proc.returncode,0,proc.stderr.decode())
        observed=json.loads(proc.stdout)
        ledger=(root/'luna-api-ledger.jsonl').read_bytes();self.assertTrue(ledger.startswith(prefix))
        rows=[json.loads(line) for line in ledger.splitlines()][1:]
        self.assertEqual(sum(row['event']=='admit' for row in rows),1)
        if (root/'fixture-send-count.json').exists():
            self.assertEqual(json.loads((root/'fixture-send-count.json').read_bytes())['calls'],0 if fault=='legacy-open' else 1)
        return root,observed,rows

    def finalize(self,root,observed):
        return gate.finalize_parent_inventory(directory=root,acks=observed['acks'],expected=observed['expected'],
            child_exit_code=observed['child_exit_code'],ipc_closed=observed['ipc_closed'])

    def cell(self,root):
        def read(name):
            path=root/name
            return path.read_bytes() if path.exists() else None
        raw=read('capture-receipt-001.json')
        receipt=json.loads(raw) if raw else {}
        spec={key:receipt.get(key) for key in ('protocol_id','run_id','root_turn_id','route',
            'task_prompt_sha256','observer_source_sha256','request_body_sha256')}
        spec['receipt_sha256']=gate.sha(raw) if raw else None
        metadata=json.loads(read('runner-metadata.json'))
        return dict(spec=spec,receipt_bytes=raw,request_bytes=read('capture-request-001.json'),
            contract_bytes=read('binding-contract.json'), binding_expected=metadata['binding']['expected'],
            deployed_source_pins=metadata['binding']['deployed_source_pins'],
            response_bytes=read('capture-response-001.sse'),source_pins={
                'adapter_sha256':gate.sha((HERE.parent/'stream_adapters.py').read_bytes()),
                'grader_sha256':gate.sha((HERE.parent/'protocol.py').read_bytes())},
            planning_required=True,code_artifact_pass=True,normal_exit=True,timed_out=False,budget_stopped=False)

    def score(self,root,observed,commit=None,inventory_bytes=None):
        return gate.score_published_cell(inventory_bytes=inventory_bytes if inventory_bytes is not None else (commit or {}).get('inventory_bytes'),
            trusted_inventory_sha256=(commit or {}).get('trusted_inventory_sha256'),publication_expected=observed['expected'],
            fair_cell_kwargs=self.cell(root),expected_fair_cells_sha256=gate.FAIR_PIN)

    def assert_unknown(self,result):
        self.assertIsNone(result['publication_verified'])
        self.assertFalse(result['capture_verified'])
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertIs(result['code_completion'],True)

    def test_real_ipc_clean_publication_parent_commit_and_output_grader(self):
        root,observed,rows=self.run_fixture()
        self.assertEqual([r['event'] for r in rows],['admit','settle'])
        commit=self.finalize(root,observed)
        self.assertEqual((root/'parent-inventory.json').read_bytes(),commit['inventory_bytes'])
        result=self.score(root,observed,commit)
        self.assertIs(result['publication_verified'],True)
        self.assertIs(result['capture_verified'],True)
        self.assertIs(result['visible_plan_format_pass'],True)
        self.assertNotIn('- [ ]',str(result))

    def test_double_fault_surviving_clean_receipt_cannot_grade_without_ack(self):
        root,observed,rows=self.run_fixture('double-fault')
        self.assertEqual(observed['child_exit_code'],0)
        self.assertEqual(observed['acks'],[])
        self.assertEqual([r['event'] for r in rows],['admit','settle'])
        self.assertTrue(json.loads((root/'capture-receipt-001.json').read_bytes())['capture_write_complete'])
        self.assertFalse((root/'luna-api-stop.json').exists())
        with self.assertRaises(gate.PublicationUnknown):self.finalize(root,observed)
        self.assert_unknown(self.score(root,observed))

    def test_subprocess_crashes_at_all_publication_boundaries(self):
        for fault in ('crash-before-link','crash-after-link','crash-before-ack','crash-after-ack'):
            with self.subTest(fault=fault):
                root,observed,rows=self.run_fixture(fault)
                self.assertNotEqual(observed['child_exit_code'],0)
                self.assertEqual([r['event'] for r in rows],['admit','settle'])
                self.assertEqual(len(observed['acks']),1 if fault=='crash-after-ack' else 0)
                with self.assertRaises(gate.PublicationUnknown):self.finalize(root,observed)
                self.assert_unknown(self.score(root,observed))

    def test_forged_wronghash_and_duplicate_real_ipc_messages_refused(self):
        for fault in ('forged-channel','wrong-hash','duplicate-ack'):
            with self.subTest(fault=fault):
                root,observed,rows=self.run_fixture(fault)
                self.assertEqual([r['event'] for r in rows],['admit','settle'])
                with self.assertRaises(gate.PublicationUnknown):self.finalize(root,observed)
                self.assert_unknown(self.score(root,observed))

    def test_unfinalized_missing_or_mutated_parent_inventory_is_unknown(self):
        root,observed,_=self.run_fixture();commit=self.finalize(root,observed)
        self.assert_unknown(self.score(root,observed,inventory_bytes=commit['inventory_bytes']))
        broken={**commit,'inventory_bytes':commit['inventory_bytes']+b' '}
        self.assert_unknown(self.score(root,observed,broken))
        for field,value in [('finalized',False),('ipc_closed',False),('child_exit_code',True),
                            ('publication_count',True),('run_id','other')]:
            inventory=json.loads(commit['inventory_bytes']);inventory[field]=value
            raw=gate.encode(inventory)
            # A synthetic repin probes structure, never a real trusted commit.
            self.assert_unknown(self.score(root,observed,{'inventory_bytes':raw,'trusted_inventory_sha256':gate.sha(raw)}))

    def test_parent_final_sync_failure_leaves_file_but_no_commit_capability(self):
        root,observed,_=self.run_fixture()
        sync=gate.sync_directory;calls=0
        def fail_final(path):
            nonlocal calls
            calls+=1
            if calls==2:raise OSError('parent final directory fsync failure')
            return sync(path)
        with patch.object(gate,'sync_directory',fail_final):
            with self.assertRaises(OSError):self.finalize(root,observed)
        self.assertTrue((root/'parent-inventory.json').exists())
        self.assert_unknown(self.score(root,observed,inventory_bytes=(root/'parent-inventory.json').read_bytes()))

    def test_parent_crash_after_link_requires_absent_commit_not_file_scan(self):
        root,observed,_=self.run_fixture()
        # A real parent subprocess exits after link, before final directory fsync.
        program='''import json,os,sys
import publication_gate as g
observed=json.loads(sys.stdin.read())
link=g.os.link
def crash(*a,**k):
 link(*a,**k)
 os._exit(97)
g.os.link=crash
g.finalize_parent_inventory(directory=sys.argv[1],acks=observed['acks'],expected=observed['expected'],child_exit_code=0,ipc_closed=True)
'''
        proc=subprocess.run(['python3','-c',program,str(root)],input=json.dumps(observed),text=True,cwd=HERE,
            capture_output=True,timeout=10,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
        self.assertEqual(proc.returncode,97)
        self.assert_unknown(self.score(root,observed,inventory_bytes=(root/'parent-inventory.json').read_bytes()))

    def test_upstream_error_with_complete_usage_does_not_become_plan_proof(self):
        root,observed,rows=self.run_fixture('upstream-error');commit=self.finalize(root,observed)
        self.assertEqual(rows[-1]['error'],None);self.assertFalse(rows[-1]['usage_missing'])
        self.assertEqual(json.loads((root/'luna-api-stop.json').read_bytes())['reason'],'upstream_event')
        result=self.score(root,observed,commit)
        self.assertIs(result['publication_verified'],True)
        self.assertIsNone(result['visible_plan_format_pass'])

    def test_legacy_io_failures_keep_unsettled_hold_and_never_retry(self):
        for fault in ('legacy-open','legacy-close','settlement-append'):
            root,observed,rows=self.run_fixture(fault)
            self.assertEqual([r['event'] for r in rows],['admit'])
            self.assertNotEqual(observed['child_exit_code'],0)
            with self.assertRaises(gate.PublicationUnknown):self.finalize(root,observed)
            self.assert_unknown(self.score(root,observed))

    def test_changed_artifact_ack_call_and_inventory_identity_all_refuse(self):
        root,observed,_=self.run_fixture()
        for key,value in [('run_id','other'),('root_turn_id','other'),('call_ordinal',2),
                          ('publication_ordinal',True),('response_byte_count',False),('observer_source_sha256','a'*64)]:
            altered=copy.deepcopy(observed);altered['acks'][0][key]=value
            with self.assertRaises(gate.PublicationUnknown):self.finalize(root,altered)
        with (root/'capture-response-001.sse').open('ab') as out:out.write(b' ')
        with self.assertRaises(gate.PublicationUnknown):self.finalize(root,observed)

    def test_parent_source_pin_and_nonreplacing_inventory_are_required(self):
        root,observed,_=self.run_fixture()
        for key in ('parent_source_sha256','ipc_parent_source_sha256'):
            altered=copy.deepcopy(observed);altered['expected'][key]='a'*64
            with self.assertRaises(gate.PublicationUnknown):self.finalize(root,altered)
        (root/'parent-inventory.json').write_bytes(b'existing inventory')
        with self.assertRaises(FileExistsError):self.finalize(root,observed)
        self.assertEqual((root/'parent-inventory.json').read_bytes(),b'existing inventory')
        self.assert_unknown(self.score(root,observed))

    def test_parent_rejects_symlink_capture_artifact_and_missing_channel_finality(self):
        root,observed,_=self.run_fixture()
        changed=copy.deepcopy(observed);changed['ipc_closed']=False
        with self.assertRaises(gate.PublicationUnknown):self.finalize(root,changed)
        artifact=root/'capture-response-001.sse'
        artifact.rename(root/'response-alias-target.sse')
        artifact.symlink_to('response-alias-target.sse')
        with self.assertRaises(OSError):self.finalize(root,observed)

    def test_three_preselected_luna_layouts_bind_through_publication_and_output_grading(self):
        for profile in ('light-luna-base-v2','light-luna-one-setup-v2','pi-luna-v0731-v2'):
            root,observed,_=self.run_fixture(profile=profile)
            result=self.score(root,observed,self.finalize(root,observed))
            self.assertIs(result['publication_verified'],True)
            self.assertIs(result['capture_verified'],True)
            self.assertIs(result['binding_verified'],True)
            self.assertEqual(result['binding_profile_id'],profile)
            self.assertIs(result['visible_plan_format_pass'],True)
            self.assertEqual(result['binding_source_sha256'],gate.BINDING_PIN)
            self.assertTrue(all(type(value) in (str,int,bool,type(None)) for value in result.values()))

    def test_missing_contract_source_pins_expected_identity_and_mutated_envelope_never_grade(self):
        root,observed,_=self.run_fixture();commit=self.finalize(root,observed)
        changes=[lambda kw:kw.pop('contract_bytes'),
            lambda kw:kw.update(contract_bytes=kw['contract_bytes']+b' '),
            lambda kw:kw.pop('binding_expected'),
            lambda kw:kw.update(deployed_source_pins={}),
            lambda kw:kw['binding_expected'].update(configuration_sha256='a'*64),
            lambda kw:kw['binding_expected'].update(root_turn_id='other'),
            lambda kw:kw['binding_expected'].update(contract_sha256='a'*64)]
        for change in changes:
            kwargs=self.cell(root);change(kwargs)
            result=gate.score_published_cell(**commit,publication_expected=observed['expected'],
                fair_cell_kwargs=kwargs,expected_fair_cells_sha256=gate.FAIR_PIN)
            self.assertFalse(result['capture_verified'])
            self.assertIsNone(result['binding_verified'])
            self.assertIsNone(result['visible_plan_format_pass'])
            self.assertIs(result['code_completion'],True)

    def test_request_mutation_cannot_be_reauthorized_by_repinning_synthetic_receipt_inventory(self):
        root,observed,_=self.run_fixture();commit=self.finalize(root,observed)
        for mutation in ('task','auxiliary','envelope','unknown-context','task-position'):
            kwargs=self.cell(root);body=json.loads(kwargs['request_bytes'])
            if mutation=='task':body['input'][0]['content'][0]['text']+=' changed'
            elif mutation=='auxiliary':body['input'][1]['content'][0]['text']+=' changed'
            elif mutation=='envelope':body['reasoning']['summary']='detailed'
            elif mutation=='unknown-context':body['prompt']='not authorized'
            else:body['input'].reverse()
            # TEST ONLY adversarial recorder: recompute artifact publication
            # hashes, but never alter the independently minted task contract.
            kwargs['request_bytes']=gate.encode(body)
            receipt=json.loads(kwargs['receipt_bytes'])
            receipt['request_body_sha256']=gate.sha(kwargs['request_bytes'])
            kwargs['receipt_bytes']=gate.encode(receipt)
            kwargs['spec'].update(receipt_sha256=gate.sha(kwargs['receipt_bytes']),
                request_body_sha256=gate.sha(kwargs['request_bytes']))
            inventory=json.loads(commit['inventory_bytes'])
            inventory['publications'][0].update(receipt_sha256=gate.sha(kwargs['receipt_bytes']),
                request_body_sha256=gate.sha(kwargs['request_bytes']))
            raw=gate.encode(inventory)
            result=gate.score_published_cell(inventory_bytes=raw,trusted_inventory_sha256=gate.sha(raw),
                publication_expected=observed['expected'],fair_cell_kwargs=kwargs,
                expected_fair_cells_sha256=gate.FAIR_PIN)
            self.assertIs(result['publication_verified'],True)
            self.assertIsNone(result['binding_verified'])
            self.assertFalse(result['capture_verified'])
            self.assertIsNone(result['visible_plan_format_pass'])
            self.assertIs(result['code_completion'],True)

    def test_publication_binding_pins_and_old_receipt_schema_cannot_bypass_new_reducer(self):
        root,observed,_=self.run_fixture();commit=self.finalize(root,observed)
        for key in ('binding_source_sha256','binding_contract_sha256'):
            changed=copy.deepcopy(observed);changed['expected'][key]='a'*64
            self.assert_unknown(self.score(root,changed,commit))
        for changes in ({'schema_version':1},{'initial_binding_verified':False},
                        {'binding_source_sha256':'a'*64},{'binding_contract_sha256':'a'*64},
                        {'call_ordinal':2,'admission_id':'fixture:2','initial_request':False,
                         'prior_root_generations':1,'request_role':'continuation'}):
            kwargs=self.cell(root);receipt=json.loads(kwargs['receipt_bytes']);receipt.update(changes)
            kwargs['receipt_bytes']=gate.encode(receipt);kwargs['spec']['receipt_sha256']=gate.sha(kwargs['receipt_bytes'])
            inventory=json.loads(commit['inventory_bytes'])
            inventory['publications'][0]['receipt_sha256']=gate.sha(kwargs['receipt_bytes'])
            raw=gate.encode(inventory)
            result=gate.score_published_cell(inventory_bytes=raw,trusted_inventory_sha256=gate.sha(raw),
                publication_expected=observed['expected'],fair_cell_kwargs=kwargs,
                expected_fair_cells_sha256=gate.FAIR_PIN)
            self.assertFalse(result['capture_verified']);self.assertIsNone(result['visible_plan_format_pass'])
            self.assertIs(result['code_completion'],True)

    def test_original_exit_timeout_budget_and_code_only_facts_remain_separate(self):
        root,observed,_=self.run_fixture();commit=self.finalize(root,observed)
        for facts in ({'normal_exit':False},{'timed_out':True},{'budget_stopped':True},
                      {'code_artifact_pass':False},{'planning_required':False}):
            kwargs=self.cell(root);kwargs.update(facts)
            result=gate.score_published_cell(**commit,publication_expected=observed['expected'],
                fair_cell_kwargs=kwargs,expected_fair_cells_sha256=gate.FAIR_PIN)
            for key,value in facts.items():self.assertIs(result[key],value)
            if facts.get('planning_required') is False:
                self.assertFalse(result['capture_verified']);self.assertIsNone(result['binding_verified'])
                self.assertIsNone(result['visible_plan_format_pass']);self.assertIs(result['code_completion'],True)
            else:self.assertIs(result['code_completion'],False)


if __name__=='__main__':unittest.main()
