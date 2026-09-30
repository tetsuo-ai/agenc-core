import copy
import hashlib
import json
import pathlib
import unittest
from unittest.mock import patch

import fair_cells as subject
from test_stream_adapters import PLAN, chat, message, responses, sse

HERE = pathlib.Path(__file__).resolve().parent


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


class FairCellTests(unittest.TestCase):
    def fixture(self, route='deepseek-proxy', output=PLAN):
        prompt = 'Original task instructions; do not infer a plan from this input.'
        if route == 'deepseek-proxy':
            request = {'model':'deepseek-flash','stream':True,'messages':[
                {'role':'system','content':'Private system text.'},{'role':'user','content':prompt}]}
            response = sse([chat({'content':output},'stop')],done=True)
        else:
            request = {'model':'gpt-6-luna','stream':True,'instructions':'Private system text.',
                       'input':[{'role':'user','content':[{'type':'input_text','text':prompt}]}]}
            response = sse(responses([message('assistant-item',0,output)]),numbered=True)
        pins = {'adapter_sha256':subject.sha((HERE/'stream_adapters.py').read_bytes()),
                'grader_sha256':subject.sha((HERE/'protocol.py').read_bytes())}
        raw_request = encoded(request)
        spec = {'protocol_id':'fair-v2-synthetic','run_id':'fixture-run','root_turn_id':'root-turn-1',
                'route':route,'task_prompt_sha256':subject.sha(prompt.encode()),
                'observer_source_sha256':'b'*64,'request_body_sha256':subject.sha(raw_request)}
        receipt = {'schema_version':1, **spec, 'admission_id':'fixture-run:1','call_ordinal':1,
                   'prior_root_generations':0,'initial_request':True,'request_role':'root',
                   'source':'provider_response_sse','response_bytes_sha256':subject.sha(response),
                   'response_byte_count':len(response),'http_status':200,
                   'response_content_type':'text/event-stream; charset=utf-8','requested_stream':True,
                   'transport_outcome':'eof','downstream_delivery_failed':False,'capture_write_complete':True,
                   'installed_adapter_sha256':pins['adapter_sha256']}
        raw_receipt = encoded(receipt)
        spec['receipt_sha256'] = subject.sha(raw_receipt)
        return dict(spec=spec,receipt_bytes=raw_receipt,request_bytes=raw_request,response_bytes=response,
                    source_pins=pins,planning_required=True,code_artifact_pass=True,
                    normal_exit=True,timed_out=False,budget_stopped=False)

    def receipt_change(self, fixture, values=None, remove=None):
        receipt=json.loads(fixture['receipt_bytes'])
        receipt.update(values or {})
        if remove:del receipt[remove]
        fixture['receipt_bytes']=encoded(receipt)
        # Trusted inventory repin lets tests target structural checks rather
        # than merely proving that a mutated receipt has a different hash.
        fixture['spec']['receipt_sha256']=subject.sha(fixture['receipt_bytes'])

    def request_change(self, fixture, change):
        request=json.loads(fixture['request_bytes']);change(request)
        fixture['request_bytes']=encoded(request)
        fixture['spec']['request_body_sha256']=subject.sha(fixture['request_bytes'])
        self.receipt_change(fixture,{'request_body_sha256':fixture['spec']['request_body_sha256']})

    def response_change(self, fixture, raw):
        fixture['response_bytes']=raw
        self.receipt_change(fixture,{'response_bytes_sha256':subject.sha(raw),'response_byte_count':len(raw)})

    def unknown(self, fixture, reason=None):
        result=subject.score_fair_cell(**fixture)
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertIsNone(result['requested_format_contract_pass'])
        self.assertIs(result['code_completion'],True)
        if reason:self.assertEqual(result['evidence_unknown_reason'],reason)
        self.assertTrue(result['evidence_unknown_reason'])
        return result

    def test_both_routes_reach_adapter_grader_and_separate_code_score(self):
        for route in subject.ROUTES:
            with self.subTest(route=route):
                fixture=self.fixture(route);result=subject.score_fair_cell(**fixture)
                self.assertIs(result['capture_verified'],True)
                self.assertIs(result['adapter_capture_complete'],True)
                self.assertIs(result['visible_plan_format_pass'],True)
                self.assertIs(result['code_completion'],True)
                self.assertIs(result['requested_format_contract_pass'],True)
                self.assertIsNone(result['plan_semantic_quality'])
                self.assertEqual(result['adapter_sha256'],fixture['source_pins']['adapter_sha256'])

    def test_receipt_request_and_output_raw_hash_tampering(self):
        for field in ('receipt_bytes','request_bytes','response_bytes'):
            fixture=self.fixture();fixture[field]+=b' '
            self.unknown(fixture)

    def test_byte_count_integer_and_exact_value_required(self):
        for count in (0,-1,True,1.0,'123',None):
            fixture=self.fixture();self.receipt_change(fixture,{'response_byte_count':count})
            self.unknown(fixture,'response_byte_count_mismatch')

    def test_missing_receipt_fields_and_unknown_metadata_fail_closed(self):
        for key in subject.RECEIPT_FIELDS:
            fixture=self.fixture();self.receipt_change(fixture,remove=key)
            self.unknown(fixture,'missing_or_unknown_receipt_fields')
        fixture=self.fixture();self.receipt_change(fixture,{'unreviewed':'private value'})
        self.unknown(fixture,'missing_or_unknown_receipt_fields')

    def test_transport_cancel_read_error_write_failure_and_delivery_failure(self):
        for fields in ({'transport_outcome':'cancelled'},{'transport_outcome':'read_error'},
                       {'transport_outcome':'http_error'},{'transport_outcome':'incomplete'},
                       {'capture_write_complete':False},{'capture_write_complete':1},
                       {'downstream_delivery_failed':True},{'downstream_delivery_failed':0}):
            fixture=self.fixture();self.receipt_change(fixture,fields)
            self.unknown(fixture,'incomplete_transport_delivery_or_write')

    def test_http_sse_stream_origin_and_observer_are_required(self):
        for fields in ({'http_status':True},{'http_status':500},{'response_content_type':'application/json'},
                       {'requested_stream':False},{'requested_stream':1},{'source':'wire_input'},
                       {'source':'rendered_logs'},{'source':'replayed_history'},
                       {'observer_source_sha256':'c'*64},{'installed_adapter_sha256':'d'*64}):
            fixture=self.fixture();self.receipt_change(fixture,fields);self.unknown(fixture)

    def test_exact_first_root_admission_not_later_success_or_subagent(self):
        for fields in ({'call_ordinal':2,'admission_id':'fixture-run:2'}, {'call_ordinal':True},
                       {'admission_id':'other:1'},{'request_role':'subagent'},
                       {'prior_root_generations':1},{'prior_root_generations':False},
                       {'initial_request':False},{'root_turn_id':'another-root'},
                       {'run_id':'other-run'},{'protocol_id':'other-protocol'}, {'route':'openai-direct'}):
            fixture=self.fixture();self.receipt_change(fixture,fields);self.unknown(fixture)

    def test_exact_initial_prompt_hash_required_even_with_consistent_receipt(self):
        for route in subject.ROUTES:
            fixture=self.fixture(route);fixture['spec']['task_prompt_sha256']='c'*64
            self.receipt_change(fixture,{'task_prompt_sha256':'c'*64})
            self.unknown(fixture,'initial_root_prompt_mismatch')

    def test_input_plan_is_not_visible_output_proof(self):
        for route in subject.ROUTES:
            fixture=self.fixture(route,output='No visible checklist.')
            def replace(request):
                messages=request['messages' if route=='deepseek-proxy' else 'input']
                messages[-1]['content']=PLAN
            self.request_change(fixture,replace)
            fixture['spec']['task_prompt_sha256']=subject.sha(PLAN.encode())
            self.receipt_change(fixture,{'task_prompt_sha256':fixture['spec']['task_prompt_sha256']})
            result=subject.score_fair_cell(**fixture)
            self.assertIs(result['code_completion'],True)
            self.assertIs(result['visible_plan_format_pass'],False)
            self.assertIs(result['requested_format_contract_pass'],False)

    def test_history_tools_multiple_users_and_prior_response_pointers_are_unknown(self):
        for route in subject.ROUTES:
            key='messages' if route=='deepseek-proxy' else 'input'
            changes=[lambda body:body[key].insert(0,{'role':'assistant','content':PLAN}),
                     lambda body:body[key].insert(0,{'role':'tool','content':PLAN}),
                     lambda body:body[key].insert(0,{'type':'function_call_output','call_id':'prior','output':PLAN}),
                     lambda body:body[key].append({'role':'user','content':'another user turn'}),
                     lambda body:body.update(previous_response_id='prior-response'),
                     lambda body:body.update(conversation='prior-conversation')]
            for change in changes:
                fixture=self.fixture(route);self.request_change(fixture,change);self.unknown(fixture)

    def test_only_unambiguous_single_text_part_prompt_supported(self):
        fixture=self.fixture()
        self.request_change(fixture,lambda body:body['messages'][-1].update(content=[
            {'type':'text','text':body['messages'][-1]['content']}]))
        self.assertIs(subject.score_fair_cell(**fixture)['visible_plan_format_pass'],True)
        for content in ([],[{'type':'text','text':'task'},{'type':'text','text':'extra'}],
                        [{'type':'image_url','image_url':'unused'}],None):
            fixture=self.fixture();self.request_change(fixture,lambda body:body['messages'][-1].update(content=content))
            self.unknown(fixture)

    def test_request_route_model_stream_and_raw_body_envelope_are_verified(self):
        for route in subject.ROUTES:
            for values in ({'model':'other-model'},{'stream':False},{'stream':1}):
                fixture=self.fixture(route);self.request_change(fixture,lambda body:body.update(values))
                self.unknown(fixture,'unexpected_initial_request_route_or_stream')
        fixture=self.fixture();self.request_change(fixture,lambda body:body.update(messages=[]))
        self.unknown(fixture,'missing_initial_message_list')

    def test_no_capture_list_or_later_output_fallback_is_accepted(self):
        fixture=self.fixture();fixture['response_bytes']=[b'incomplete',fixture['response_bytes']]
        self.unknown(fixture,'response_hash_mismatch')
        fixture=self.fixture();fixture['receipt_bytes']=None
        self.unknown(fixture,'raw_evidence_bytes_required')

    def test_capture_eof_cannot_replace_provider_completion(self):
        for route in subject.ROUTES:
            fixture=self.fixture(route)
            truncated=(sse([chat({'content':PLAN})]) if route=='deepseek-proxy'
                       else sse(responses([message('m',0)])[:-1]))
            self.response_change(fixture,truncated)
            result=self.unknown(fixture,'adapter_capture_unknown')
            self.assertIs(result['capture_verified'],True)
            self.assertIs(result['adapter_capture_complete'],False)

    def test_ambiguous_chat_chunk_stays_unknown(self):
        fixture=self.fixture();self.response_change(fixture,sse([
            chat({'content':PLAN,'tool_calls':[{'index':0}]},'tool_calls')],done=True))
        self.unknown(fixture,'adapter_capture_unknown')

    def test_audited_adapter_negative_cases_stay_unknown_end_to_end(self):
        for raw in (sse([chat({'content':PLAN,'tool_calls':False},'stop')],done=True),
                    sse([chat({'content':PLAN},'tool_calls')],done=True)):
            fixture=self.fixture();self.response_change(fixture,raw)
            self.unknown(fixture,'adapter_capture_unknown')
        fixture=self.fixture('openai-direct')
        self.response_change(fixture,sse(responses([message('m',0)])[1:]))
        self.unknown(fixture,'adapter_capture_unknown')

    def test_adapter_source_tampering_does_not_erase_known_code_result(self):
        fixture=self.fixture();fixture['source_pins']['adapter_sha256']='0'*64
        self.unknown(fixture,'source_pin_mismatch')
        original=subject._read_source
        def changed(filename):
            raw=original(filename)
            return raw+b'\n# changed after review\n' if filename=='stream_adapters.py' else raw
        with patch.object(subject,'_read_source',changed):
            self.unknown(self.fixture(),'source_pin_mismatch')

    def test_unverified_grader_never_claims_graded_code_completion(self):
        fixture=self.fixture();fixture['source_pins']['grader_sha256']='0'*64
        result=subject.score_fair_cell(**fixture)
        self.assertIs(result['code_artifact_pass'],True)
        self.assertIs(result['normal_exit'],True)
        self.assertIsNone(result['code_completion'])
        self.assertEqual(result['evidence_unknown_reason'],'grader_source_unverified')

    def test_source_read_failure_and_malformed_receipts_are_unknown(self):
        original=subject._read_source
        def unreadable(filename):
            if filename=='stream_adapters.py':raise OSError('sensitive path suppressed')
            return original(filename)
        with patch.object(subject,'_read_source',unreadable):
            self.unknown(self.fixture(),'pinned_source_unavailable')
        for raw in (None,b'{broken',b'[]',b'{"schema_version":1,"schema_version":1}',b'\xff'):
            fixture=self.fixture();fixture['receipt_bytes']=raw
            self.unknown(fixture)

    def test_original_execution_outcomes_remain_separate(self):
        for fields in ({'code_artifact_pass':False},{'normal_exit':False},{'timed_out':True},{'budget_stopped':True}):
            fixture=self.fixture();fixture.update(fields)
            result=subject.score_fair_cell(**fixture)
            self.assertIs(result['visible_plan_format_pass'],True)
            self.assertIs(result['code_completion'],False)
            self.assertIs(result['requested_format_contract_pass'],False)
            for key,value in fields.items():self.assertIs(result[key],value)
        fixture=self.fixture();fixture['normal_exit']=None
        result=subject.score_fair_cell(**fixture)
        self.assertIsNone(result['code_completion']);self.assertIsNone(result['normal_exit'])

    def test_nonplanning_cell_needs_no_plan_capture_but_does_need_verified_grader(self):
        fixture=self.fixture();fixture.update(planning_required=False,receipt_bytes=None,response_bytes=None)
        result=subject.score_fair_cell(**fixture)
        self.assertIs(result['requested_format_contract_pass'],True)
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertEqual(result['plan_reason'],'planning_not_required')

    def test_invalid_boolean_inputs_not_coerced_to_success(self):
        fixture=self.fixture();fixture['normal_exit']=0
        result=subject.score_fair_cell(**fixture)
        self.assertIsNone(result['normal_exit']);self.assertIsNone(result['code_completion'])
        self.assertEqual(result['outcome_unknown_reason'],'invalid_original_outcome_type')
        fixture=self.fixture();fixture['planning_required']='yes'
        result=subject.score_fair_cell(**fixture)
        self.assertIsNone(result['requested_format_contract_pass'])
        self.assertIsNone(result['planning_required'])

    def test_result_contains_only_scalars_no_text_arguments_headers_or_events(self):
        fixture=self.fixture();before=copy.deepcopy(fixture)
        result=subject.score_fair_cell(**fixture)
        self.assertTrue(all(value is None or type(value) in (str,int,bool) for value in result.values()))
        serialized=json.dumps(result)
        for secret in (PLAN,'Private system text.','Original task instructions','events','normalized_text'):
            self.assertNotIn(secret,serialized)
        self.assertEqual(fixture,before)
        self.assertEqual(result,subject.score_fair_cell(**fixture))


if __name__ == '__main__':
    unittest.main()
