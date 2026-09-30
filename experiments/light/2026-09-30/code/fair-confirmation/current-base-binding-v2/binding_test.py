"""Synthetic contract tests plus exact archive/Git selected-source verification.

No captured request defines expected content, no source client/provider runs.
"""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import unittest

HERE = Path(__file__).resolve().parent
subject = runpy.run_path(str(HERE / 'binding.py'))
codec, SOURCES = subject['load']()
canonical, sha = codec['canonical'], codec['sha']
TASK, TAIL, INSTRUCTIONS = 'Synthetic fixed task.', 'Synthetic fixed workspace.', 'Synthetic fixed instructions.'
# Independent fixture declaration; NOT the actual current Core tool envelope.
ENVELOPE = {'model': 'gpt-6-luna', 'stream': True, 'store': False, 'tools': [],
            'max_output_tokens': 8192, 'reasoning': {'effort': 'low', 'summary': 'auto'},
            'include': ['reasoning.encrypted_content'], 'parallel_tool_calls': True,
            'prompt_cache_key': 'synthetic-fixed-session'}


def fixture():
    expected = dict(protocol_id='synthetic-current-profile', run_id='synthetic', root_turn_id='root',
                    client='light', route='openai-direct', task_prompt_sha256=sha(TASK.encode()),
                    client_artifact_sha256=sha(b'synthetic-source-selection-not-build'),
                    configuration_sha256=sha(b'synthetic-predeclared-config'))
    contract = dict(schema_version=2, profile_id=subject['PROFILE'],
                    **{k: expected[k] for k in ('protocol_id', 'run_id', 'root_turn_id',
                       'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256')},
                    task_index=0, source_inventory_sha256=sha(canonical(SOURCES)),
                    instructions_sha256=sha(INSTRUCTIONS.encode()),
                    auxiliary=[dict(index=1, slot='dynamic_system', origin='light.responses-dynamic-suffix', text_sha256=sha(TAIL.encode()))],
                    envelope_fields=sorted(ENVELOPE), envelope_sha256=sha(canonical(ENVELOPE)))
    contract_bytes = canonical(contract)
    expected['contract_sha256'] = sha(contract_bytes)
    # Only after independently sealing the declaration do we assemble synthetic wire.
    body = dict(copy.deepcopy(ENVELOPE), instructions=INSTRUCTIONS, input=[
        dict(type='message', role='user', content=[dict(type='input_text', text=TASK)]),
        dict(type='message', role='system', content=[dict(type='input_text', text=TAIL)])])
    admission = dict(run_id='synthetic', root_turn_id='root', admission_id='synthetic:1',
                     call_ordinal=1, prior_root_generations=0, initial_request=True, request_role='root')
    return dict(request_bytes=canonical(body), contract_bytes=contract_bytes, expected=expected,
                admission=admission, deployed_source_pins=dict(SOURCES))


class BindingTests(unittest.TestCase):
    def test_predecessor_profile_is_not_rewritten_or_reused(self):
        old = runpy.run_path(str(HERE.parent / 'current-base-binding-v1' / 'binding.py'))
        args = fixture()
        contract = json.loads(args['contract_bytes'])
        contract['profile_id'] = old['PROFILE']
        args['contract_bytes'] = canonical(contract)
        args['expected']['contract_sha256'] = sha(args['contract_bytes'])
        self.assertEqual(old['bind_initial_request'](**args)['unknown_reason'], 'deployed_source_pin_mismatch')
        self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'unknown_layout_profile')
        _, previous_sources = old['load']()
        self.assertEqual(set(SOURCES) - set(previous_sources), {'runtime/src/llm/client-session.ts'})
        self.assertEqual([name for name in previous_sources if previous_sources[name] != SOURCES[name]],
                         ['runtime/src/llm/providers/openai/adapter.ts'])

    def test_current_synthetic_base(self):
        result = subject['bind_initial_request'](**fixture())
        self.assertIs(result['binding_verified'], True)
        self.assertEqual(result['profile_id'], subject['PROFILE'])

    def test_selected_sources_match_exact_git_and_archive(self):
        archive = Path('/private/tmp/light-clean-responses-eof-RKsVUm/source')
        repo = '/private/tmp/light-takeover/startup-core'
        self.assertEqual(len(SOURCES), 60)
        for name, expected in SOURCES.items():
            with self.subTest(name=name):
                self.assertEqual(sha((archive / name).read_bytes()), expected)
                raw = subprocess.run(['/usr/bin/git', '-C', repo, 'show', subject['REVISION'] + ':' + name],
                                     check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5).stdout
                self.assertEqual(sha(raw), expected)

    def test_old_profile_still_refuses_honest_current_inventory(self):
        old = runpy.run_path(str(HERE.parent / 'prompt-binding-v2' / 'prompt_binding.py'))
        args = fixture()
        contract = json.loads(args['contract_bytes']); contract['profile_id'] = 'light-luna-base-v2'
        args['contract_bytes'] = canonical(contract)
        args['expected']['contract_sha256'] = sha(args['contract_bytes'])
        result = old['bind_initial_request'](**args)
        self.assertIsNone(result['binding_verified'])
        self.assertEqual(result['unknown_reason'], 'deployed_source_pin_mismatch')
        # New selector never falls back to any old profile either.
        self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'unknown_layout_profile')

    def test_source_inventory_is_exact_not_subset_or_adopted(self):
        for kind in ('missing', 'changed', 'extra'):
            with self.subTest(kind=kind):
                args = fixture(); sources = args['deployed_source_pins']; name = next(iter(sources))
                if kind == 'missing': del sources[name]
                elif kind == 'changed': sources[name] = '0' * 64
                else: sources['runtime/unreviewed.ts'] = '0' * 64
                self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'deployed_source_pin_mismatch')

    def test_request_mutations_cannot_reseal_contract(self):
        for kind in ('task', 'tail', 'instructions', 'envelope', 'extra-message', 'history-pointer'):
            with self.subTest(kind=kind):
                args = fixture(); body = json.loads(args['request_bytes'])
                if kind == 'task': body['input'][0]['content'][0]['text'] = 'Other task'
                elif kind == 'tail': body['input'][1]['content'][0]['text'] = 'Other tail'
                elif kind == 'instructions': body['instructions'] = 'Other instructions'
                elif kind == 'envelope': body['reasoning']['effort'] = 'high'
                elif kind == 'extra-message': body['input'].append(body['input'][0])
                else: body['previous_response_id'] = 'old-response'
                args['request_bytes'] = canonical(body)
                self.assertIsNone(subject['bind_initial_request'](**args)['binding_verified'])

    def test_noninitial_admission_and_changed_contract_refuse(self):
        for kind in ('ordinal', 'prior', 'root', 'contract'):
            with self.subTest(kind=kind):
                args = fixture()
                if kind == 'ordinal': args['admission']['call_ordinal'] = 2
                elif kind == 'prior': args['admission']['prior_root_generations'] = 1
                elif kind == 'root': args['admission']['root_turn_id'] = 'other'
                else: args['contract_bytes'] += b' '
                self.assertIsNone(subject['bind_initial_request'](**args)['binding_verified'])

    def test_bytes_and_size_limits_refuse(self):
        for field, value in [('request_bytes', 'text'), ('request_bytes', b'x' * (1024 * 1024 + 1)),
                             ('contract_bytes', b'x' * (256 * 1024 + 1))]:
            args = fixture(); args[field] = value
            self.assertEqual(subject['bind_initial_request'](**args)['unknown_reason'], 'binding_size_limit')


if __name__ == '__main__':
    unittest.main()
