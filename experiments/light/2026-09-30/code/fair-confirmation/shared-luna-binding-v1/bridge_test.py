"""Same bounded subprocess bridge and refusal checks for both arms."""
import base64
import json
from pathlib import Path
import runpy
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent
fixtures = runpy.run_path(str(HERE / 'binding_test.py'))


def payload(client):
    value = fixtures['fixture'](client)
    value['request_base64'] = base64.b64encode(value.pop('request_bytes')).decode('ascii')
    value['contract_base64'] = base64.b64encode(value.pop('contract_bytes')).decode('ascii')
    return value


def invoke(raw):
    result = subprocess.run([sys.executable, '-I', '-S', '-B', str(HERE / 'bridge.py')],
                            input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={}, timeout=5, check=True)
    if result.stderr or len(result.stdout) > 4096:
        raise AssertionError('unexpected bridge output')
    return json.loads(result.stdout)


class BridgeTests(unittest.TestCase):
    def test_both_clients_use_same_bridge(self):
        for client in ('light', 'pi'):
            result = invoke(json.dumps(payload(client)).encode())
            self.assertIs(result['binding_verified'], True)
            self.assertEqual(result['client'], client)

    def test_malformed_input_refuses(self):
        for client in ('light', 'pi'):
            valid = json.dumps(payload(client)).encode()
            extra = payload(client); extra['unexpected'] = True
            for raw in (b'{', b'[]', b'\xff', b'{"duplicate":1,"duplicate":2}',
                        json.dumps(extra).encode(), valid + b' trailing', b'x' * (2 * 1024 * 1024 + 1)):
                with self.subTest(client=client, size=len(raw)):
                    self.assertEqual(invoke(raw), {'binding_verified': None, 'unknown_reason': 'shared_binding_bridge_refused'})

    def test_base64_contract_and_client_tamper_refuse(self):
        for client in ('light', 'pi'):
            for field in ('request_base64', 'contract_base64'):
                obj = payload(client); obj[field] = '!invalid!'
                self.assertIsNone(invoke(json.dumps(obj).encode())['binding_verified'])
            obj = payload(client)
            obj['contract_base64'] = base64.b64encode(base64.b64decode(obj['contract_base64']) + b' ').decode()
            self.assertEqual(invoke(json.dumps(obj).encode())['unknown_reason'], 'contract_hash_mismatch')
            obj = payload(client); obj['expected']['client'] = 'pi' if client == 'light' else 'light'
            self.assertEqual(invoke(json.dumps(obj).encode())['unknown_reason'], 'client_route_mismatch')


if __name__ == '__main__':
    unittest.main()
