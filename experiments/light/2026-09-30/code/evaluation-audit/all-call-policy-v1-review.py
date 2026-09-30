"""Independent pure synthetic checks; no clients, transport or financial state."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

SOURCE = Path('/private/tmp/light-takeover/fair-confirmation/all-call-policy-v1/policy.py')
assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == 'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf'
spec = importlib.util.spec_from_file_location('reviewed_all_call_policy', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# Independent authored policy and request recipes, not imported implementation
# tables or values learned from an observed request. No real contract is emitted.
LUNA_POLICY = b'{"schema_version":1,"profile":"fixed-luna-v1","route":"openai-direct","client":"CLIENT","controls":{"model":"gpt-6-luna","stream":true,"store":false,"max_output_tokens":8192,"reasoning":{"effort":"low","summary":"auto"},"include":["reasoning.encrypted_content"]}}'
FLASH_POLICY = b'{"schema_version":1,"profile":"fixed-flash-v1","route":"deepseek-proxy","client":"CLIENT","controls":{"model":"deepseek-flash","stream":true,"max_tokens":8192,"reasoning_effort":"high","thinking":{"type":"enabled"},"stream_options":{"include_usage":true}}}'
LUNA_REQUEST = b'{"model":"gpt-6-luna","stream":true,"store":false,"max_output_tokens":8192,"reasoning":{"effort":"low","summary":"auto"},"include":["reasoning.encrypted_content"],"input":[{"role":"user","content":"Synthetic root"}]}'
FLASH_REQUEST = b'{"model":"deepseek-flash","stream":true,"max_tokens":8192,"reasoning_effort":"high","thinking":{"type":"enabled"},"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Synthetic root"}]}'


def encode(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii')


def fixture(luna=True, client='light'):
    policy = (LUNA_POLICY if luna else FLASH_POLICY).replace(b'CLIENT', client.encode('ascii'))
    # This expected digest is fixed from the authored declaration before any
    # request mutations. It is never recomputed from a request.
    args = dict(policy_bytes=policy, expected_policy_sha256=hashlib.sha256(policy).hexdigest(),
                route='openai-direct' if luna else 'deepseek-proxy', client=client, call_ordinal=2)
    body = json.loads(LUNA_REQUEST if luna else FLASH_REQUEST)
    return args, body


def check(args, body=None, raw=None):
    return module.check_request(request_bytes=encode(body) if raw is None else raw, **args)


class Review(unittest.TestCase):
    def refused(self, result):
        self.assertIs(result['policy_verified'], False)
        self.assertIs(type(result['reason']), str)
        self.assertLess(len(result['reason']), 80)
        self.assertEqual(set(result), {'policy_verified', 'reason', 'request_sha256', 'policy_sha256'})

    def test_four_profiles_later_drift_and_repeated_pure_calls(self):
        for luna in (True, False):
            for client in ('light', 'pi'):
                args, body = fixture(luna, client)
                for ordinal in (1, 2, 1000):
                    current = {**args, 'call_ordinal': ordinal}
                    self.assertTrue(check(current, body)['policy_verified'])
                    for field, value in list(body.items()):
                        if field in ('input', 'messages'):
                            continue
                        changed = copy.deepcopy(body)
                        changed[field] = None
                        self.refused(check(current, changed))
                    self.assertTrue(check(current, body)['policy_verified'])

    def test_numeric_lexemes_do_not_cross_required_integer_type(self):
        for luna in (True, False):
            args, body = fixture(luna)
            raw = encode(body)
            for alternate in (b'8192.0', b'8.192e3', b'8192e0', b'true', b'"8192"'):
                self.refused(check(args, raw=raw.replace(b'8192', alternate)))

    def test_decoded_equal_controls_preserve_exact_original_byte_digest(self):
        args, body = fixture()
        raw = encode(body).replace(b'gpt-6-luna', b'gpt-\\u0036-luna') + b' \n\t'
        result = check(args, raw=raw)
        self.assertTrue(result['policy_verified'])
        self.assertEqual(result['request_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertNotEqual(result['request_sha256'], hashlib.sha256(encode(body)).hexdigest())

    def test_policy_bytes_cannot_change_with_old_authorization_pin(self):
        args, body = fixture()
        changed = {**args, 'policy_bytes': args['policy_bytes'] + b' '}
        self.refused(check(changed, body))

    def test_supported_optional_is_explicitly_preauthorized_not_observed(self):
        args, body = fixture()
        declared = json.loads(args['policy_bytes'])
        declared['controls']['parallel_tool_calls'] = False
        policy = encode(declared)
        authorized = {**args, 'policy_bytes': policy, 'expected_policy_sha256': hashlib.sha256(policy).hexdigest()}
        self.refused(check(authorized, body))
        body['parallel_tool_calls'] = False
        self.assertTrue(check(authorized, body)['policy_verified'])
        for value in (0, 0.0, None, 'false', True):
            self.refused(check(authorized, {**body, 'parallel_tool_calls': value}))

    def test_unapproved_controls_cannot_hide_in_top_level(self):
        for luna in (True, False):
            for client in ('light', 'pi'):
                args, body = fixture(luna, client)
                for key in ('extra_body', 'generation_config', 'text', 'max_completion_tokens', 'budget',
                            'parallel_tool_calls', 'temperature', 'prompt_cache_retention', 'metadata'):
                    self.refused(check(args, {**body, key: None}))

    def test_history_is_variable_but_not_authorized_by_this_verdict(self):
        for luna in (True, False):
            for client in ('light', 'pi'):
                args, body = fixture(luna, client)
                field = 'input' if luna else 'messages'
                body[field] += [{'role': 'assistant', 'content': 'Synthetic later history'},
                                {'role': 'tool', 'content': 'Synthetic tool result'}]
                body['tools'] = [{'type': 'function', 'function': {'name': 'DifferentSyntheticTool'}}]
                self.assertTrue(check(args, body)['policy_verified'])
                # Deliberate scope characterization: nonempty valid-JSON data
                # is not full provider schema or tool/history authority proof.
                body[field] = [False]
                self.assertTrue(check(args, body)['policy_verified'])

    def test_malformed_in_variable_data_still_refuses(self):
        args, body = fixture()
        prefix = encode(body)[:-1] + b',"tools":['
        for payload in (b'{"a":1,"\\u0061":2}', b'{"nested":"\\udfff"}',
                        b'{"\\ud800":0}', b'{"number":1e9999}', b'{"number":NaN}',
                        b'{"text":"\xff"}'):
            self.refused(check(args, raw=prefix + payload + b']}'))

    def test_structure_string_and_integer_limits_inside_data(self):
        args, body = fixture()
        body['input'][0]['content'] = 'x' * (module.MAX_STRING_CHARS + 1)
        self.refused(check(args, body))
        base = encode(json.loads(LUNA_REQUEST))[:-1]
        self.refused(check(args, raw=base + b',"tools":[' + b'9' * 129 + b']}'))
        self.refused(check(args, raw=base + b',"tools":[' + b'[' * 65 + b'0' + b']' * 65 + b']}'))

    def test_malformed_policy_identity_types_are_bounded_refusals(self):
        args, body = fixture()
        declared = json.loads(args['policy_bytes'])
        for field in ('schema_version', 'profile', 'route', 'client', 'controls'):
            for value in (None, [], {}, True, 1.0):
                policy = encode({**declared, field: value})
                changed = {**args, 'policy_bytes': policy, 'expected_policy_sha256': hashlib.sha256(policy).hexdigest()}
                self.refused(check(changed, body))

    def test_no_refusal_text_or_values_leak(self):
        args, body = fixture()
        sentinel = 'SYNTHETIC_NOT_A_REAL_SECRET'
        for raw in (encode({**body, sentinel: sentinel}), encode(body) + sentinel.encode('ascii'),
                    encode({**body, 'reasoning': {'effort': sentinel}})):
            result = check(args, raw=raw)
            self.refused(result)
            self.assertNotIn(sentinel, json.dumps(result))


if __name__ == '__main__':
    unittest.main(verbosity=2)
