"""Independent current-profile/bridge negatives; synthetic bytes only."""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

ROOT = Path('/private/tmp/light-takeover/fair-confirmation')
CURRENT = ROOT / 'current-base-binding-v1'
PINS = {
    'binding.py': 'f2611ee08e1a3d42457f596582040bb5da04713f65213fe5fa8307981cf12fe2',
    'binding_test.py': '1acca9f8b3dc468568dad896f1091bfc7c1953c20646af9a781ca63fffd0a1ac',
    'bridge.py': 'df989de10a8a712771755b4ff0bf0140c8b1ab36b0925e95b272640d191ed0d3',
    'bridge_test.py': '9356888f44833e1c577bca2b154d3f292555992396fe7506d626186aac7ea50f',
}
for filename, pin in PINS.items():
    assert hashlib.sha256((CURRENT / filename).read_bytes()).hexdigest() == pin
fixtures = runpy.run_path(str(CURRENT / 'binding_test.py'))
bridge = runpy.run_path(str(CURRENT / 'bridge_test.py'))
subject = fixtures['subject']
canonical, sha = fixtures['canonical'], fixtures['sha']


class ReviewerCases(unittest.TestCase):
    def test_profile_namespace_and_selected_map_are_fresh_per_invocation(self):
        namespace, sources = subject['load']()
        self.assertEqual(set(namespace['PROFILES']), {subject['PROFILE']})
        namespace['PROFILES'].clear()
        sources.clear()
        self.assertIs(subject['bind_initial_request'](**fixtures['fixture']())['binding_verified'], True)
        historical = runpy.run_path(str(ROOT / 'prompt-binding-v2' / 'prompt_binding.py'))
        self.assertEqual(len(historical['PROFILES']), 6)
        self.assertNotIn(subject['PROFILE'], historical['PROFILES'])

    def test_strict_raw_json_survives_selector_reuse(self):
        original = fixtures['fixture']()['request_bytes']
        variants = [b'\xef\xbb\xbf' + original,
                    original.replace(b'"stream":true', b'"stream":true,"stream":true'),
                    original.replace(b'8192', b'1e9999'), original + b'{}']
        surrogate = json.loads(original)
        surrogate['input'][0]['content'][0]['text'] = '\ud800'
        variants.append(canonical(surrogate))
        extra = json.loads(original)
        extra['metadata'] = {'unreviewed': 'synthetic'}
        variants.append(canonical(extra))
        for raw in variants:
            args = fixtures['fixture'](); args['request_bytes'] = raw
            with self.subTest(size=len(raw)):
                result = subject['bind_initial_request'](**args)
                self.assertIsNone(result['binding_verified'])
                self.assertLess(len(json.dumps(result)), 4096)

    def test_source_selection_failure_has_only_static_unknown_output(self):
        bound = subject['bind_initial_request']
        def fail():
            raise OSError('synthetic diagnostic that must not escape')
        with patch.dict(bound.__globals__, {'load': fail}):
            result = bound(**fixtures['fixture']())
        self.assertEqual(result, {'binding_verified': None, 'unknown_reason': 'current_binding_selection_refused'})

    def test_later_or_noninteger_admissions_cannot_become_initial(self):
        for key, value in [('call_ordinal', True), ('call_ordinal', 1.0),
                           ('prior_root_generations', False), ('prior_root_generations', 1),
                           ('initial_request', 1), ('request_role', 'auxiliary')]:
            args = fixtures['fixture'](); args['admission'][key] = value
            with self.subTest(field=key, value=value):
                self.assertIsNone(subject['bind_initial_request'](**args)['binding_verified'])

    def test_bridge_large_preauthorized_synthetic_task_and_decoded_limit(self):
        # Author/seal the synthetic expected task before constructing its wire.
        task = 'Independent synthetic task. ' + 'a' * (900 * 1024)
        args = fixtures['fixture']()
        contract = json.loads(args['contract_bytes'])
        contract['task_prompt_sha256'] = sha(task.encode())
        args['expected']['task_prompt_sha256'] = contract['task_prompt_sha256']
        args['contract_bytes'] = canonical(contract)
        args['expected']['contract_sha256'] = sha(args['contract_bytes'])
        body = json.loads(args['request_bytes'])
        body['input'][0]['content'][0]['text'] = task
        args['request_bytes'] = canonical(body)
        import base64
        payload = copy.deepcopy(args)
        payload['request_base64'] = base64.b64encode(payload.pop('request_bytes')).decode()
        payload['contract_base64'] = base64.b64encode(payload.pop('contract_bytes')).decode()
        self.assertIs(bridge['invoke'](canonical(payload))['binding_verified'], True)
        payload['request_base64'] = base64.b64encode(b'x' * (1024 * 1024 + 1)).decode()
        self.assertEqual(bridge['invoke'](canonical(payload))['unknown_reason'], 'binding_size_limit')

    def test_bridge_refuses_nonstring_base64_without_echoing_input(self):
        for value in [None, True, 7, [], {'private': 'synthetic'}]:
            payload = bridge['payload'](); payload['request_base64'] = value
            with self.subTest(kind=type(value).__name__):
                result = bridge['invoke'](canonical(payload))
                self.assertEqual(result, {'binding_verified': None, 'unknown_reason': 'current_binding_bridge_refused'})


if __name__ == '__main__':
    unittest.main()
