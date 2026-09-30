"""Pure bridge repro: synthetic bytes only, no observer, ledger or provider."""
import base64
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest

ROOT = Path('/private/tmp/light-takeover/fair-confirmation')
POLICY = ROOT / 'all-call-policy-v1/policy.py'
BRIDGE = ROOT / 'luna-policy-v1/policy_bridge.py'
assert hashlib.sha256(POLICY.read_bytes()).hexdigest() == 'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf'
assert hashlib.sha256(BRIDGE.read_bytes()).hexdigest() == '0cc7f89c0a5a31b0b45e707350d751bfb744b3caca3ba65178140d634d76fa4a'
subject = runpy.run_path(str(POLICY))
controls = dict(model='gpt-6-luna', stream=True, store=False, max_output_tokens=8192,
                reasoning=dict(effort='low', summary='auto'), include=['reasoning.encrypted_content'])
policy = json.dumps(dict(schema_version=1, profile='fixed-luna-v1', route='openai-direct',
                         client='light', controls=controls), separators=(',', ':')).encode()
digest = hashlib.sha256(policy).hexdigest()


def check(size):
    request = json.dumps(dict(**controls, input=[
        dict(role='user', content='x' * size), dict(role='assistant', content='y' * size)
    ]), separators=(',', ':')).encode()
    pure = subject['check_request'](request_bytes=request, policy_bytes=policy,
        expected_policy_sha256=digest, route='openai-direct', client='light', call_ordinal=2)
    payload = json.dumps(dict(request=base64.b64encode(request).decode(),
        policy=base64.b64encode(policy).decode(), expected_sha256=digest, client='light', ordinal=2)).encode()
    result = subprocess.run([sys.executable, '-I', '-S', '-B', str(BRIDGE)], input=payload,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, env={})
    assert result.returncode == 0 and not result.stderr
    return pure, json.loads(result.stdout), len(request), len(payload)


class BridgeReview(unittest.TestCase):
    def test_small_valid_control(self):
        pure, bridge, _, _ = check(20)
        self.assertTrue(pure['policy_verified'])
        self.assertEqual(bridge, pure)

    def test_within_request_and_per_string_limits_matches_pure_predicate(self):
        pure, bridge, request_size, payload_size = check(450000)
        self.assertLess(request_size, 1024 * 1024)
        self.assertLess(payload_size, 6 * 1024 * 1024)
        self.assertTrue(pure['policy_verified'])
        self.assertEqual(bridge, pure,
            'base64 envelope inherits unrelated 1 Mi-character request-string cap')


if __name__ == '__main__':
    unittest.main()
