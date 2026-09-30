"""Offline synthetic declarations only; no Pi execution or provider requests."""
import copy
import json
from pathlib import Path
import runpy
import unittest

HERE = Path(__file__).resolve().parent
subject = runpy.run_path(str(HERE / 'binding.py'))
codec, light_sources = subject['load']()
canonical, sha = codec['canonical'], codec['sha']
TASK = 'Same predeclared synthetic task for both arms.'
SYSTEM = 'Predeclared synthetic client context.'
INSTRUCTIONS = 'Predeclared synthetic Light instructions.'
ENVELOPE = {'model': 'gpt-6-luna', 'stream': True, 'store': False,
            'tools': [], 'max_output_tokens': 8192,
            'reasoning': {'effort': 'low', 'summary': 'auto'},
            'include': ['reasoning.encrypted_content']}


def fixture(client):
    light = client == 'light'
    sources = light_sources if light else codec['PI_RESPONSES']
    contract = dict(schema_version=2,
        profile_id=subject['LIGHT_PROFILE'] if light else subject['PI_PROFILE'],
        protocol_id='synthetic-shared-luna', run_id='synthetic', root_turn_id='root',
        task_index=0 if light else 1, task_prompt_sha256=sha(TASK.encode()),
        client_artifact_sha256=sha(('synthetic-' + client).encode()),
        configuration_sha256=sha(b'synthetic-config'),
        source_inventory_sha256=sha(canonical(sources)),
        instructions_sha256=sha(INSTRUCTIONS.encode()) if light else None,
        auxiliary=[dict(index=1 if light else 0,
            slot='dynamic_system' if light else 'static_system',
            origin='light.responses-dynamic-suffix' if light else 'pi.static-system',
            text_sha256=sha(SYSTEM.encode()))],
        envelope_fields=sorted(ENVELOPE), envelope_sha256=sha(canonical(ENVELOPE)))
    sealed = canonical(contract)
    expected = {k: contract[k] for k in ('protocol_id', 'run_id', 'root_turn_id',
        'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256')}
    expected.update(client=client, route='openai-direct', contract_sha256=sha(sealed))
    # Build synthetic wire only after sealing the independently declared contract.
    task = dict(role='user', content=[dict(type='input_text', text=TASK)])
    if light:
        task['type'] = 'message'
        messages = [task, dict(type='message', role='system',
            content=[dict(type='input_text', text=SYSTEM)])]
    else:
        messages = [dict(role='developer', content=SYSTEM), task]
    body = dict(copy.deepcopy(ENVELOPE), input=messages)
    if light:
        body['instructions'] = INSTRUCTIONS
    admission = dict(run_id='synthetic', root_turn_id='root', admission_id='synthetic:1',
        call_ordinal=1, prior_root_generations=0, initial_request=True, request_role='root')
    return dict(request_bytes=canonical(body), contract_bytes=sealed, expected=expected,
        admission=admission, deployed_source_pins=dict(sources))


def reseal(args, **changes):
    contract = json.loads(args['contract_bytes'])
    contract.update(changes)
    args['contract_bytes'] = canonical(contract)
    args['expected']['contract_sha256'] = sha(args['contract_bytes'])


class SharedBindingTests(unittest.TestCase):
    def test_exact_two_profiles_with_distinct_fixed_indices(self):
        self.assertEqual(set(codec['PROFILES']), {subject['LIGHT_PROFILE'], subject['PI_PROFILE']})
        self.assertEqual(len(light_sources), 60)
        self.assertEqual(len(codec['PI_RESPONSES']), 7)
        for client, index in [('light', 0), ('pi', 1)]:
            result = subject['bind_initial_request'](**fixture(client))
            self.assertIs(result['binding_verified'], True)
            self.assertEqual(result['task_index'], index)
            self.assertEqual(result['client'], client)
            self.assertNotIn(TASK, json.dumps(result))

    def test_light_result_unchanged_from_accepted_selector(self):
        old = runpy.run_path(str(HERE.parent / 'current-base-binding-v2' / 'binding.py'))
        self.assertEqual(subject['bind_initial_request'](**fixture('light')),
                         old['bind_initial_request'](**fixture('light')))
        self.assertIsNone(old['bind_initial_request'](**fixture('pi'))['binding_verified'])

    def test_client_or_profile_substitution_refused(self):
        for client in ('light', 'pi'):
            for mutation in ('client', 'profile', 'inventory', 'index'):
                with self.subTest(client=client, mutation=mutation):
                    args = fixture(client)
                    other = 'pi' if client == 'light' else 'light'
                    if mutation == 'client': args['expected']['client'] = other
                    elif mutation == 'profile':
                        reseal(args, profile_id=subject['PI_PROFILE'] if other == 'pi' else subject['LIGHT_PROFILE'])
                    elif mutation == 'inventory': args['deployed_source_pins'] = fixture(other)['deployed_source_pins']
                    else: reseal(args, task_index=1 if client == 'light' else 0)
                    self.assertIsNone(subject['bind_initial_request'](**args)['binding_verified'])

    def test_historical_profiles_not_fallbacks(self):
        for name in ('pi-luna-v0731-v2', 'light-luna-base-v2', 'light-flash-base-v2', 'pi-flash-v0731-v2'):
            args = fixture('pi'); reseal(args, profile_id=name)
            self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'unknown_layout_profile')

    def test_wire_mutations_and_unknown_sources_refused_for_both(self):
        for client in ('light', 'pi'):
            for mutation in ('text', 'role', 'order', 'reasoning', 'extra-source', 'missing-source', 'changed-source'):
                with self.subTest(client=client, mutation=mutation):
                    args = fixture(client); body = json.loads(args['request_bytes'])
                    index = 0 if client == 'light' else 1
                    if mutation == 'text': body['input'][index]['content'][0]['text'] += ' '
                    elif mutation == 'role': body['input'][index]['role'] = 'developer'
                    elif mutation == 'order': body['input'].reverse()
                    elif mutation == 'reasoning': body['reasoning']['effort'] = 'high'
                    elif mutation == 'extra-source': args['deployed_source_pins']['extra'] = '0' * 64
                    elif mutation == 'missing-source': args['deployed_source_pins'].pop(next(iter(args['deployed_source_pins'])))
                    else: args['deployed_source_pins'][next(iter(args['deployed_source_pins']))] = '0' * 64
                    args['request_bytes'] = canonical(body)
                    self.assertIsNone(subject['bind_initial_request'](**args)['binding_verified'])

    def test_noninitial_admission_and_size_limits(self):
        for client in ('light', 'pi'):
            args = fixture(client); args['admission']['call_ordinal'] = 2
            self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'not_first_root_admission')
            args = fixture(client); args['request_bytes'] = b'x' * (1024 * 1024 + 1)
            self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'binding_size_limit')


if __name__ == '__main__':
    unittest.main()
