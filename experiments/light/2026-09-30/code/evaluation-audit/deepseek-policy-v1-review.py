"""Pure policy-guard review. No Proxy, Owner, journals, transport or socket."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path('/private/tmp/light-takeover/fair-confirmation/deepseek-policy-v1')
for name, pin in {
    'policy_guard.py': '1d9c85f4e4bff33384e1d554858911406c712b4d1e660ca3167c653ea077f1fd',
    'capture.py': '142cd2195109adf7d9a0af0c483b53f4ead79ec905a4656a1a5eb667ed421e00',
}.items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == pin
sys.path.insert(0, str(ROOT))
from policy_guard import check_policy
from capture import Unknown

CONTROLS = dict(model='deepseek-flash', stream=True, max_tokens=8192,
    reasoning_effort='high', thinking=dict(type='enabled'), stream_options=dict(include_usage=True))


def encode(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


class GuardReview(unittest.TestCase):
    def setUp(self):
        self.body = dict(copy.deepcopy(CONTROLS), messages=[dict(role='user', content='Synthetic ☃')])

    def check(self, incoming, forwarded, client='light', ordinal=1, policy=None, pin=None):
        if policy is None:
            policy = encode(dict(schema_version=1, profile='fixed-flash-v1', route='deepseek-proxy',
                                 client=client, controls=CONTROLS))
        return check_policy(incoming, forwarded, policy,
                            hashlib.sha256(policy).hexdigest() if pin is None else pin, client, ordinal)

    def test_independent_representations_and_later_histories(self):
        for client in ['light', 'pi']:
            for ordinal in [1, 2, 1000]:
                with self.subTest(client=client, ordinal=ordinal):
                    body=copy.deepcopy(self.body)
                    if ordinal > 1:
                        body['messages'].append(dict(role='assistant', content='Later synthetic history'))
                    incoming=encode(body);forwarded=json.dumps(body).encode()
                    self.assertNotEqual(incoming, forwarded)
                    self.assertIsNone(self.check(incoming, forwarded, client, ordinal))

    def test_drift_on_either_side_cannot_be_normalized_into_acceptance(self):
        for client in ['light', 'pi']:
            for ordinal in [1, 2]:
                for field, value in [('reasoning_effort','low'), ('max_tokens',8191),
                    ('max_tokens',True), ('stream',False), ('temperature',0),
                    ('thinking', {'type':'disabled'}), ('stream_options', {'include_usage':False})]:
                    bad=copy.deepcopy(self.body);bad[field]=value
                    for incoming, forwarded in [(encode(bad),encode(self.body)), (encode(self.body),encode(bad))]:
                        with self.subTest(client=client, ordinal=ordinal, field=field):
                            with self.assertRaisesRegex(Unknown, '^fixed_policy_refused$'):
                                self.check(incoming, forwarded, client, ordinal)

    def test_strict_raw_json_refuses_duplicate_nonfinite_unicode_and_extra_controls(self):
        valid=encode(self.body)
        malformed=[b'\xef\xbb\xbf'+valid, valid[:-1]+b',"stream":true}',
                   valid[:-1]+b',"temperature":NaN}',
                   valid.replace(b'Synthetic \xe2\x98\x83',b'\\ud800'),
                   valid[:-1]+b',"secret_extra":"SYNTHETIC_PRIVATE"}']
        for bad in malformed:
            for incoming, forwarded in [(bad,valid),(valid,bad)]:
                with self.assertRaisesRegex(Unknown, '^fixed_policy_refused$'):
                    self.check(incoming, forwarded, ordinal=2)

    def test_policy_and_ordinal_authority_is_not_derived_from_request(self):
        valid=encode(self.body)
        for ordinal in [0,True,2.0,1001]:
            with self.assertRaisesRegex(Unknown, '^fixed_policy_refused$'):
                self.check(valid,valid,ordinal=ordinal)
        with self.assertRaisesRegex(Unknown, '^fixed_policy_refused$'):
            self.check(valid,valid,pin='0'*64)
        changed=copy.deepcopy(CONTROLS);changed['max_tokens']=8191
        unauthorized=encode(dict(schema_version=1,profile='fixed-flash-v1',route='deepseek-proxy',
                                 client='light',controls=changed))
        body=copy.deepcopy(self.body);body['max_tokens']=8191
        with self.assertRaisesRegex(Unknown, '^fixed_policy_refused$'):
            self.check(encode(body),encode(body),policy=unauthorized)


if __name__ == '__main__':
    unittest.main()
