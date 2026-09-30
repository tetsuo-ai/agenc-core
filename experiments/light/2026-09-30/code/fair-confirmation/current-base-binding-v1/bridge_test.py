"""Synthetic stdin-only bridge checks; no Core client or observer execution."""
import base64
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
fixtures = runpy.run_path(str(HERE / 'binding_test.py'))


def payload():
    value = fixtures['fixture']()
    value['request_base64'] = base64.b64encode(value.pop('request_bytes')).decode('ascii')
    value['contract_base64'] = base64.b64encode(value.pop('contract_bytes')).decode('ascii')
    return value


def invoke(raw):
    result = subprocess.run([sys.executable, '-I', '-S', '-B', str(HERE / 'bridge.py')],
                            input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={}, timeout=5, check=True)
    if result.stderr:
        raise AssertionError('bridge wrote unexpected stderr')
    value = json.loads(result.stdout)
    if len(result.stdout) > 4096:
        raise AssertionError('unexpected result size')
    return value


class BridgeTests(unittest.TestCase):
    def test_valid_synthetic_contract(self):
        result = invoke(json.dumps(payload()).encode())
        self.assertIs(result['binding_verified'], True)
        self.assertEqual(result['profile_id'], 'light-luna-bd88-source-base-v1')

    def test_malformed_or_extra_input_refuses(self):
        valid = json.dumps(payload()).encode()
        extra = payload(); extra['unexpected'] = True
        for raw in (b'{', b'[]', b'\xff', b'{"duplicate":1,"duplicate":2}',
                    json.dumps(extra).encode(), valid + b' trailing', b'x' * (2 * 1024 * 1024 + 1)):
            with self.subTest(size=len(raw)):
                result = invoke(raw)
                self.assertEqual(result, {'binding_verified': None, 'unknown_reason': 'current_binding_bridge_refused'})

    def test_malformed_base64_and_contract_tamper_refuse(self):
        for field, value in [('request_base64', '!invalid!'), ('contract_base64', 'bad$')]:
            obj = payload(); obj[field] = value
            self.assertIsNone(invoke(json.dumps(obj).encode())['binding_verified'])
        obj = payload()
        obj['contract_base64'] = base64.b64encode(base64.b64decode(obj['contract_base64']) + b' ').decode()
        self.assertEqual(invoke(json.dumps(obj).encode())['unknown_reason'], 'contract_hash_mismatch')


if __name__ == '__main__':
    unittest.main()
