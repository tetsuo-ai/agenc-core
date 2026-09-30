#!/usr/bin/env python3
"""Linux-only synthetic fixtures for offline diagnostics; no subprocess or network."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

if sys.platform != 'linux':
    raise SystemExit('Offline diagnostic verification executes only on Linux')

spec = importlib.util.spec_from_file_location('analyze_gates', Path(__file__).with_name('analyze_gates.py'))
gates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gates)


class GateDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gate-diagnostics-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def json(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def sse(self, index, events, tail=''):
        (self.root / f'response-{index:03}.txt').write_text(''.join('data: ' + json.dumps(e) + '\n\n' for e in events) + tail)

    def setup_run(self, count, timeout=False):
        self.json('result.json', {'id': 'fixture', 'agent': 'light', 'model_calls': count,
                                 'check_pass': True, 'pass': True, 'exit_code': 0, 'timeout': timeout})
        for i in range(1, count + 1):
            self.json(f'wire-{i:03}.json', {'body': {'instructions': 'private-system', 'input': [], 'tools': []}})
            self.json(f'usage-{i:03}.json', {'input_tokens': 10 * i, 'cached_tokens': i,
                'uncached_tokens': 9 * i, 'output_tokens': i, 'usage_missing': False})

    def chat(self, text='', tools=None, finish='stop'):
        return {'choices': [{'index': 0, 'delta': {'content': text, 'tool_calls': tools or []}, 'finish_reason': finish}]}

    def test_chat_final_boundary_repeated_final_and_receipt_dedup(self):
        self.setup_run(4)
        tool = {'index': 0, 'id': 'call1', 'function': {'name': 'exec_command', 'arguments': '{"cmd":"private-command"}'}}
        self.sse(1, [self.chat('Working', [tool], 'tool_calls')])
        self.sse(2, [self.chat('private-answer')], 'data: [DONE]\n\n')
        self.sse(3, [self.chat('More work', [dict(tool, id='call2')], 'tool_calls')])
        self.sse(4, [self.chat('final')])
        receipt = {'type': 'tool_call_completed', 'payload': {'callId': 'call1', 'toolName': 'exec_command', 'isError': False}}
        self.json('agent.log', {'type': 'result', 'events': [receipt, receipt]})
        r = gates.analyze(self.root, True)
        self.assertEqual(r['final_answer_calls'], [2, 4])
        self.assertEqual(r['through_first_final']['tokens']['total_tokens'], 33)
        self.assertEqual(r['after_first_final']['tokens']['total_tokens'], 77)
        self.assertEqual(r['tool_calls_emitted_complete'], 2)
        self.assertEqual(r['execution_receipts_exact'], 1)
        self.assertEqual(r['calls'][0]['execution_receipts_matched'], 1)
        for secret in ('private-system', 'private-command', 'private-answer'):
            self.assertNotIn(secret, json.dumps(r))

    def test_responses_deltas_and_completed_snapshot_do_not_double_count(self):
        self.setup_run(2)
        item = {'id': 'fc1', 'call_id': 'call1', 'type': 'function_call', 'name': 'bash', 'arguments': ''}
        final = dict(item, arguments='{"command":"true"}')
        self.sse(1, [{'type': 'response.output_item.added', 'item': item},
                     {'type': 'response.function_call_arguments.delta', 'item_id': 'fc1', 'delta': '{"command":'},
                     {'type': 'response.function_call_arguments.delta', 'item_id': 'fc1', 'delta': '"true"}'},
                     {'type': 'response.output_item.done', 'item': final},
                     {'type': 'response.completed', 'response': {'status': 'completed', 'output': [final]}}])
        message = {'id': 'm1', 'type': 'message', 'content': [{'type': 'output_text', 'text': 'Done'}]}
        self.sse(2, [{'type': 'response.output_text.delta', 'delta': 'Done'},
                     {'type': 'response.output_item.done', 'item': message},
                     {'type': 'response.completed', 'response': {'status': 'completed', 'output': [message]}}])
        (self.root/'agent.log').write_text(json.dumps({'type': 'tool_execution_end', 'toolCallId': 'call1|fc1', 'toolName': 'bash', 'isError': False}) + '\n' + json.dumps({'type': 'agent_end'}) + '\n')
        r = gates.analyze(self.root, True)
        self.assertEqual(r['tool_calls_started_observed'], 1)
        self.assertEqual(r['tool_calls_emitted_complete'], 1)
        self.assertEqual(r['execution_receipts_exact'], 1)
        self.assertEqual(r['calls'][0]['execution_receipts_matched'], 1)
        self.assertEqual(r['calls'][1]['response']['assistant_text_chars'], 4)
        self.assertEqual(r['final_answer_calls'], [2])

    def test_incomplete_arguments_usage_and_timeout_are_unknown_not_zero(self):
        self.setup_run(1, timeout=True)
        self.sse(1, [{'type': 'response.output_item.added', 'item': {'id': 'fc', 'type': 'function_call', 'name': 'bash', 'arguments': ''}},
                     {'type': 'response.function_call_arguments.delta', 'item_id': 'fc', 'delta': '{"command":"true"   '}], 'data: {"unterminated\n')
        self.json('usage-001.json', {'input_tokens': 0, 'cached_tokens': 0, 'uncached_tokens': 0, 'output_tokens': 0, 'usage_missing': True})
        r = gates.analyze(self.root)
        self.assertFalse(r['effective_pass'])
        self.assertFalse(r['all_streams_complete'])
        self.assertIsNone(r['usage']['tokens'])
        self.assertIsNone(r['after_first_final'])
        self.assertIsNone(r['execution_receipts_exact'])
        self.assertEqual(r['tool_calls_started_observed'], 1)
        self.assertEqual(r['tool_calls_emitted_complete'], 0)

    def test_missing_earlier_capture_makes_observed_first_final_uncertain(self):
        self.setup_run(2)
        self.sse(2, [self.chat('Done')])
        r = gates.analyze(self.root)
        self.assertEqual(r['first_final_call'], 2)
        self.assertFalse(r['first_final_boundary_known'])
        self.assertIsNone(r['through_first_final'])
        self.assertIsNone(r['after_first_final'])

    def test_truncated_text_and_provider_incomplete_are_not_final(self):
        self.setup_run(2)
        self.sse(1, [self.chat('Incomplete answer', finish='length')])
        self.sse(2, [{'type': 'response.output_text.delta', 'delta': 'Almost'},
                     {'type': 'response.incomplete', 'response': {'status': 'incomplete'}}])
        r = gates.analyze(self.root)
        self.assertEqual(r['final_answer_calls'], [])
        self.assertFalse(r['all_streams_complete'])


if __name__ == '__main__':
    unittest.main()
