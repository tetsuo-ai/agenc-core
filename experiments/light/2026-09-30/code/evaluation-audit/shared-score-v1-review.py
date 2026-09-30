"""Pinned offline reviewer supplement; no clients, financial state or network."""
import hashlib
import json
from pathlib import Path
import runpy
import sys
import unittest

ROOT = Path('/private/tmp/light-takeover/fair-confirmation/shared-score-v1')
PINS = {
    ROOT / 'fair_cells.py': '73c3cf7ca4360a94f5ec334cf751573a15ee4af3863e3f1571ad5d84f549f780',
    ROOT / 'test_score.py': '36cc2b1370ea88442b3c9e0768f2d6018939007a8b8c702945399c05ba2a8049',
    ROOT.parent / 'protocol.py': '7f6cfcb6115ebf118497c8ae1611094e19c31526409552585658bdfc7274c933',
    ROOT.parent / 'stream_adapters.py': 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323',
}
for path, expected in PINS.items():
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, path.name
sys.path.insert(0, str(ROOT))
recipe = runpy.run_path(str(ROOT / 'test_score.py'))
subject = recipe['subject']
fixture, change_receipt, encoded = (recipe[name] for name in ('fixture', 'change_receipt', 'encoded'))


class Review(unittest.TestCase):
    def refused(self, args):
        result = subject.score_fair_cell(**args)
        self.assertFalse(result['capture_verified'])
        self.assertIsNone(result['binding_verified'])
        self.assertIsNone(result['visible_plan_format_pass'])
        self.assertIsNone(result['requested_format_contract_pass'])
        self.assertIs(result['code_completion'], True)
        self.assertIsNotNone(result['evidence_unknown_reason'])
        return result

    def test_repinning_artifacts_does_not_reauthorize_request(self):
        for client in ('light', 'pi'):
            for field in ('summary', 'output_cap', 'task', 'extra_control'):
                with self.subTest(client=client, field=field):
                    args = fixture(client)
                    body = json.loads(args['request_bytes'])
                    if field == 'summary': body['reasoning']['summary'] = 'concise'
                    elif field == 'output_cap': body['max_output_tokens'] = 8191
                    elif field == 'extra_control': body['previous_response_id'] = 'earlier'
                    else:
                        index = 0 if client == 'light' else 1
                        body['input'][index]['content'][0]['text'] += ' altered'
                    args['request_bytes'] = encoded(body)
                    digest = subject.sha(args['request_bytes'])
                    args['spec']['request_body_sha256'] = digest
                    change_receipt(args, request_body_sha256=digest)
                    self.refused(args)

    def test_repinning_contract_artifact_does_not_change_expectation(self):
        for client in ('light', 'pi'):
            args = fixture(client)
            contract = json.loads(args['contract_bytes'])
            contract['envelope_sha256'] = '0' * 64
            args['contract_bytes'] = encoded(contract)
            change_receipt(args, binding_contract_sha256=subject.sha(args['contract_bytes']))
            self.refused(args)

    def test_exact_receipt_scalars_and_inventory(self):
        for client in ('light', 'pi'):
            for fields in ({'schema_version': True}, {'response_byte_count': True},
                           {'requested_stream': 1}, {'capture_write_complete': 1},
                           {'initial_binding_verified': 1}, {'http_status': 200.0},
                           {'prior_root_generations': False}, {'extra': 'ignored?'}):
                with self.subTest(client=client, fields=fields):
                    args = fixture(client)
                    change_receipt(args, **fields)
                    self.refused(args)

    def test_flash_is_not_a_current_luna_profile(self):
        args = fixture('light')
        args['spec']['route'] = 'deepseek-proxy'
        change_receipt(args, route='deepseek-proxy')
        self.refused(args)

    def test_input_checklist_never_substitutes_for_visible_output(self):
        for client in ('light', 'pi'):
            args = fixture(client)
            # Keep the sealed request unchanged; only replace provider output.
            args['response_bytes'] = recipe['response']('Done.')
            change_receipt(args, response_bytes_sha256=subject.sha(args['response_bytes']),
                           response_byte_count=len(args['response_bytes']))
            result = subject.score_fair_cell(**args)
            self.assertTrue(result['capture_verified'])
            self.assertTrue(result['code_completion'])
            self.assertFalse(result['visible_plan_format_pass'])

    def test_invalid_outcomes_do_not_become_true(self):
        args = fixture('pi')
        args['normal_exit'] = 1
        result = subject.score_fair_cell(**args)
        self.assertIsNone(result['normal_exit'])
        self.assertIsNone(result['code_completion'])
        self.assertIsNone(result['requested_format_contract_pass'])
        self.assertEqual(result['outcome_unknown_reason'], 'invalid_original_outcome_type')


if __name__ == '__main__':
    unittest.main()
