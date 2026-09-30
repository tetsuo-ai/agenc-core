"""Pure synthetic two-arm score tests; no clients, providers or journal writes."""
import copy
import json
from pathlib import Path
import runpy
import unittest

import fair_cells as subject

FAIR = Path(__file__).resolve().parent.parent
fixtures = runpy.run_path(str(FAIR / 'shared-luna-binding-v1/binding_test.py'))
PLAN = '- [ ] Implement the change\n- [ ] Run tests\n'
sha = subject.sha


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def response(text=PLAN):
    part = {'type': 'output_text', 'text': text}
    item = {'type': 'message', 'id': 'm1', 'role': 'assistant', 'content': [part]}
    common = {'item_id': 'm1', 'output_index': 0, 'content_index': 0}
    events = [
        {'type': 'response.created', 'response': {'id': 'r1', 'status': 'in_progress', 'output': []}},
        {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': []}},
        {'type': 'response.content_part.added', **common, 'part': {'type': 'output_text', 'text': ''}},
        {'type': 'response.output_text.delta', **common, 'delta': text},
        {'type': 'response.output_text.done', **common, 'text': text},
        {'type': 'response.content_part.done', **common, 'part': part},
        {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
        {'type': 'response.completed', 'response': {'id': 'r1', 'status': 'completed', 'output': [item]}},
    ]
    return b''.join(b'data: ' + encoded({**event, 'sequence_number': n}) + b'\n\n'
                    for n, event in enumerate(events))


def fixture(client):
    sealed = fixtures['fixture'](client)
    wire, output = sealed['request_bytes'], response()
    contract = json.loads(sealed['contract_bytes'])
    pins = {'adapter_sha256': sha((FAIR / 'stream_adapters.py').read_bytes()),
            'grader_sha256': sha((FAIR / 'protocol.py').read_bytes())}
    receipt = dict(schema_version=2, protocol_id=contract['protocol_id'],
        run_id='synthetic', root_turn_id='root', request_role='root',
        admission_id='synthetic:1', call_ordinal=1, prior_root_generations=0,
        initial_request=True, route='openai-direct', source='provider_response_sse',
        request_body_sha256=sha(wire), task_prompt_sha256=contract['task_prompt_sha256'],
        response_bytes_sha256=sha(output), response_byte_count=len(output),
        http_status=200, response_content_type='text/event-stream', requested_stream=True,
        transport_outcome='eof', downstream_delivery_failed=False, capture_write_complete=True,
        observer_source_sha256='a' * 64, installed_adapter_sha256=pins['adapter_sha256'],
        binding_source_sha256=subject.BINDING_PIN, binding_contract_sha256=sha(sealed['contract_bytes']),
        initial_binding_verified=True, client=client, binding_profile_id=contract['profile_id'])
    raw = encoded(receipt)
    spec = {key: receipt[key] for key in ('client', 'binding_profile_id', 'protocol_id',
        'run_id', 'root_turn_id', 'route', 'task_prompt_sha256', 'observer_source_sha256', 'request_body_sha256')}
    spec['receipt_sha256'] = sha(raw)
    return dict(spec=spec, receipt_bytes=raw, request_bytes=wire, response_bytes=output,
        source_pins=pins, contract_bytes=sealed['contract_bytes'], binding_expected=sealed['expected'],
        deployed_source_pins=sealed['deployed_source_pins'], planning_required=True,
        code_artifact_pass=True, normal_exit=True, timed_out=False, budget_stopped=False)


def change_receipt(args, **changes):
    value = json.loads(args['receipt_bytes']); value.update(changes)
    args['receipt_bytes'] = encoded(value)
    args['spec']['receipt_sha256'] = sha(args['receipt_bytes'])


class ScoreTests(unittest.TestCase):
    def unknown(self, args):
        result = subject.score_fair_cell(**args)
        self.assertFalse(result['capture_verified'])
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertIs(result['code_completion'], True)
        return result

    def test_both_exact_profiles_score_visible_output(self):
        for client in ('light', 'pi'):
            with self.subTest(client=client):
                result = subject.score_fair_cell(**fixture(client))
                self.assertTrue(result['capture_verified'], result)
                self.assertTrue(result['binding_verified'])
                self.assertTrue(result['visible_plan_format_pass'])
                self.assertTrue(result['requested_format_contract_pass'])
                self.assertEqual(result['client'], client)
                self.assertEqual(result['binding_profile_id'], subject.PROFILES[client])
                self.assertIsNone(result['plan_semantic_quality'])
                self.assertNotIn(PLAN, str(result))

    def test_cross_arm_receipt_spec_and_contract_are_refused(self):
        for client in ('light', 'pi'):
            other = 'pi' if client == 'light' else 'light'
            for target in ('receipt', 'spec', 'expected', 'inventory'):
                args = fixture(client)
                if target == 'receipt': change_receipt(args, client=other, binding_profile_id=subject.PROFILES[other])
                elif target == 'spec': args['spec'].update(client=other, binding_profile_id=subject.PROFILES[other])
                elif target == 'expected': args['binding_expected']['client'] = other
                else: args['deployed_source_pins'] = fixture(other)['deployed_source_pins']
                with self.subTest(client=client, target=target): self.unknown(args)

    def test_old_missing_or_unknown_profile_is_refused(self):
        for profile in (None, 'light-luna-base-v2', 'unknown'):
            args = fixture('light'); args['spec']['binding_profile_id'] = profile
            self.unknown(args)
        args = fixture('pi'); receipt = json.loads(args['receipt_bytes']); del receipt['client']
        args['receipt_bytes'] = encoded(receipt); args['spec']['receipt_sha256'] = sha(args['receipt_bytes'])
        self.unknown(args)

    def test_request_or_contract_tampering_is_refused(self):
        for client in ('light', 'pi'):
            for key in ('request_bytes', 'contract_bytes', 'response_bytes'):
                args = fixture(client); args[key] += b' '
                self.unknown(args)

    def test_no_later_call_or_wrong_root_fallback(self):
        for fields in ({'call_ordinal': 2}, {'call_ordinal': True}, {'prior_root_generations': 1},
                       {'root_turn_id': 'other'}, {'initial_request': False}):
            args = fixture('pi'); change_receipt(args, **fields); self.unknown(args)

    def test_abort_write_and_delivery_failure_remain_unknown(self):
        for fields in ({'transport_outcome': 'aborted'}, {'downstream_delivery_failed': True},
                       {'capture_write_complete': False}, {'http_status': 503}):
            args = fixture('light'); change_receipt(args, **fields); self.unknown(args)

    def test_adapter_or_binding_pin_mismatch(self):
        args = fixture('pi'); args['source_pins']['adapter_sha256'] = '0' * 64; self.unknown(args)
        args = fixture('pi'); change_receipt(args, binding_source_sha256='0' * 64); self.unknown(args)

    def test_missing_grader_does_not_invent_completion(self):
        args = fixture('light'); args['source_pins']['grader_sha256'] = '0' * 64
        result = subject.score_fair_cell(**args)
        self.assertIsNone(result['code_completion']); self.assertIs(result['code_artifact_pass'], True)

    def test_duplicate_receipt_key_is_refused(self):
        args = fixture('pi'); args['receipt_bytes'] = args['receipt_bytes'][:-1] + b',"client":"pi"}'
        args['spec']['receipt_sha256'] = sha(args['receipt_bytes']); self.unknown(args)

    def test_code_only_completion_does_not_require_capture(self):
        args = fixture('light'); args.update(planning_required=False, receipt_bytes=None, response_bytes=None)
        result = subject.score_fair_cell(**args)
        self.assertTrue(result['code_completion']); self.assertFalse(result['capture_verified'])

    def test_code_failures_are_not_overridden_by_good_plan(self):
        for fields in ({'code_artifact_pass': False}, {'normal_exit': False}, {'timed_out': True}, {'budget_stopped': True}):
            args = fixture('pi'); args.update(fields); result = subject.score_fair_cell(**args)
            self.assertTrue(result['visible_plan_format_pass'])
            self.assertFalse(result['code_completion']); self.assertFalse(result['requested_format_contract_pass'])

    def test_no_plan_is_format_failure_not_code_failure(self):
        args = fixture('pi'); args['response_bytes'] = response('Done.')
        change_receipt(args, response_bytes_sha256=sha(args['response_bytes']), response_byte_count=len(args['response_bytes']))
        result = subject.score_fair_cell(**args)
        self.assertTrue(result['capture_verified']); self.assertTrue(result['code_completion'])
        self.assertFalse(result['visible_plan_format_pass'])


if __name__ == '__main__': unittest.main()
