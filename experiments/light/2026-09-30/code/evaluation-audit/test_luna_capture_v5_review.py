"""Independent synthetic scoring probes; no process/provider/financial operations."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT=Path('/private/tmp/light-takeover/fair-confirmation/luna-capture-v5')
sys.path.insert(0,str(ROOT))
import fixture_builder
import publication_gate as gate

def sha(b):return hashlib.sha256(b).hexdigest()
def raw(value):return json.dumps(value,separators=(',',':'),allow_nan=False).encode()

class Review(unittest.TestCase):
    def fixture(self):
        self.assertEqual(sha((ROOT/'fair_cells.py').read_bytes()),gate.FAIR_PIN)
        f=fixture_builder.build({'task':'- [ ] Input checklist is not output evidence.','run_id':'review','protocol_id':'review-offline'})
        request=raw(f['body']);text='Done.';part={'type':'output_text','text':text};item={'type':'message','id':'m','role':'assistant','content':[part]};common={'item_id':'m','output_index':0,'content_index':0}
        events=[{'type':'response.created','response':{'id':'r','status':'in_progress','output':[]}},
            {'type':'response.output_item.added','output_index':0,'item':{**item,'content':[]}},
            {'type':'response.content_part.added',**common,'part':{'type':'output_text','text':''}},
            {'type':'response.output_text.delta',**common,'delta':text},
            {'type':'response.output_text.done',**common,'text':text},
            {'type':'response.content_part.done',**common,'part':part},
            {'type':'response.output_item.done','output_index':0,'item':item},
            {'type':'response.completed','response':{'id':'r','status':'completed','output':[item]}}]
        response=b''.join(b'data: '+raw(e)+b'\n\n' for e in events)
        observer=sha((ROOT/'direct.mjs').read_bytes());adapter=sha((ROOT.parent/'stream_adapters.py').read_bytes())
        receipt=dict(schema_version=2,protocol_id='review-offline',run_id='review',root_turn_id='root-1',request_role='root',admission_id='review:1',call_ordinal=1,prior_root_generations=0,initial_request=True,route='openai-direct',source='provider_response_sse',request_body_sha256=sha(request),task_prompt_sha256=f['expected']['task_prompt_sha256'],response_bytes_sha256=sha(response),response_byte_count=len(response),http_status=200,response_content_type='text/event-stream',requested_stream=True,transport_outcome='eof',downstream_delivery_failed=False,capture_write_complete=True,observer_source_sha256=observer,installed_adapter_sha256=adapter,binding_source_sha256=gate.BINDING_PIN,binding_contract_sha256=f['expected']['contract_sha256'],initial_binding_verified=True)
        receipt_bytes=raw(receipt)
        expected=dict(channel_id='review-channel',protocol_id='review-offline',run_id='review',root_turn_id='root-1',observer_source_sha256=observer,installed_adapter_sha256=adapter,publication_count=1,parent_source_sha256=sha((ROOT/'publication_gate.py').read_bytes()),ipc_parent_source_sha256=sha((ROOT/'parent_fixture.mjs').read_bytes()),binding_source_sha256=gate.BINDING_PIN,binding_contract_sha256=f['expected']['contract_sha256'])
        ack={k:expected[k] for k in ('channel_id','protocol_id','run_id','root_turn_id','observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256')}
        ack.update(kind='luna.capture.published.v5',schema_version=1,admission_id='review:1',call_ordinal=1,publication_ordinal=1,receipt_sha256=sha(receipt_bytes),request_body_sha256=sha(request),response_bytes_sha256=sha(response),response_byte_count=len(response))
        inventory=raw({**expected,'schema_version':1,'kind':'trusted-parent-publications-v5','finalized':True,'ipc_closed':True,'child_exit_code':0,'publications':[ack]})
        spec={k:receipt[k] for k in ('protocol_id','run_id','root_turn_id','route','task_prompt_sha256','observer_source_sha256','request_body_sha256')};spec['receipt_sha256']=sha(receipt_bytes)
        kwargs=dict(spec=spec,receipt_bytes=receipt_bytes,request_bytes=request,response_bytes=response,contract_bytes=base64.b64decode(f['contract_base64']),binding_expected=f['expected'],deployed_source_pins=f['deployed_source_pins'],source_pins={'adapter_sha256':adapter,'grader_sha256':sha((ROOT.parent/'protocol.py').read_bytes())},planning_required=True,code_artifact_pass=True,normal_exit=True,timed_out=False,budget_stopped=False)
        # Synthetic authority supplied explicitly; never claim a real parent commit.
        return dict(inventory_bytes=inventory,trusted_inventory_sha256=sha(inventory),publication_expected=expected,fair_cell_kwargs=kwargs,expected_fair_cells_sha256=gate.FAIR_PIN)

    def test_input_checklist_does_not_satisfy_output_plan(self):
        result=gate.score_published_cell(**self.fixture())
        self.assertIs(result['publication_verified'],True);self.assertIs(result['capture_verified'],True);self.assertIs(result['binding_verified'],True)
        self.assertIs(result['visible_plan_format_pass'],False);self.assertIs(result['code_completion'],True)

    def test_preflight_configuration_mismatch_keeps_code_independent(self):
        fixture=self.fixture();fixture['fair_cell_kwargs']['binding_expected']['configuration_sha256']='a'*64
        result=gate.score_published_cell(**fixture)
        self.assertIs(result['publication_verified'],True);self.assertFalse(result['capture_verified']);self.assertIsNone(result['binding_verified']);self.assertIsNone(result['visible_plan_format_pass']);self.assertIs(result['code_completion'],True)

if __name__=='__main__':unittest.main()
