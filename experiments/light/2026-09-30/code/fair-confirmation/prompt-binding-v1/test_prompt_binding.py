import copy
import json
import unittest

import prompt_binding as subject


TASK = 'Synthetic coding task. λ\n- [ ] This input is never planning proof.\n'


def fixture(profile_id):
    client, route, slots, instructions, sources = subject.PROFILES[profile_id]
    messages, auxiliary = [], []
    for index, (name, role, form, message_type) in enumerate(slots):
        text = TASK if name == 'task' else f'Synthetic {client} {name} context, slot {index}.'
        message = {'role': role, 'content': text if form == 'string' else [{'type': form, 'text': text}]}
        if message_type:
            message['type'] = message_type
        messages.append(message)
        if name != 'task':
            auxiliary.append({'index': index, 'slot': name,
                'origin': subject.ORIGINS.get(name, client + '.static-system'),
                'text_sha256': subject.sha(text.encode())})
    task_index = next(index for index, slot in enumerate(slots) if slot[0] == 'task')
    body = {'model': 'gpt-6-luna' if route == 'openai-direct' else 'deepseek-flash',
            'stream': True, 'input' if route == 'openai-direct' else 'messages': messages}
    if instructions:
        body['instructions'] = 'Synthetic stable Light instruction envelope.'
    contract = {'schema_version': 1, 'profile_id': profile_id, 'protocol_id': 'synthetic-fair-v3',
        'run_id': 'fixture-1', 'root_turn_id': 'root-1', 'task_index': task_index,
        'task_prompt_sha256': subject.sha(TASK.encode()), 'auxiliary': auxiliary,
        'instructions_sha256': subject.sha(body['instructions'].encode()) if instructions else None,
        'source_inventory_sha256': subject.sha(subject.canonical(sources)),
        'client_artifact_sha256': 'b'*64, 'configuration_sha256': 'c'*64}
    expected = {key: contract[key] for key in ('protocol_id', 'run_id', 'root_turn_id',
        'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256')}
    expected.update(client=client, route=route, contract_sha256=subject.sha(subject.canonical(contract)))
    admission = {'run_id': 'fixture-1', 'root_turn_id': 'root-1', 'admission_id': 'fixture-1:1',
        'call_ordinal': 1, 'prior_root_generations': 0, 'initial_request': True, 'request_role': 'root'}
    return dict(request_bytes=subject.canonical(body), contract_bytes=subject.canonical(contract),
        expected=expected, admission=admission, deployed_source_pins=copy.deepcopy(sources))


def change_body(f, fn):
    body = json.loads(f['request_bytes']); fn(body); f['request_bytes'] = subject.canonical(body)


def change_contract(f, fn, repin=True):
    contract = json.loads(f['contract_bytes']); fn(contract); f['contract_bytes'] = subject.canonical(contract)
    if repin:
        # Synthetic reviewed-inventory changes test structure, not production authorization.
        f['expected']['contract_sha256'] = subject.sha(f['contract_bytes'])


def messages(body):
    return body['input' if 'input' in body else 'messages']


def set_text(message, text):
    if type(message['content']) is str:
        message['content'] = text
    else:
        message['content'][0]['text'] = text


class BindingTests(unittest.TestCase):
    def unknown(self, f, reason=None):
        result = subject.bind_initial_request(**f)
        self.assertIsNone(result['binding_verified'])
        self.assertTrue(result['unknown_reason'])
        if reason:
            self.assertEqual(result['unknown_reason'], reason)
        self.assertEqual(set(result), {'binding_verified', 'unknown_reason'})
        return result

    def test_six_source_derived_layouts_bind_exact_fixed_indices(self):
        expected_indices = [0, 1, 2, 3, 1, 1]
        for profile_id, index in zip(subject.PROFILES, expected_indices):
            with self.subTest(profile=profile_id):
                result = subject.bind_initial_request(**fixture(profile_id))
                self.assertIs(result['binding_verified'], True)
                self.assertEqual(result['task_index'], index)
                self.assertEqual(result['profile_id'], profile_id)
                self.assertEqual(result['task_prompt_sha256'], subject.sha(TASK.encode()))
                self.assertTrue(all(type(value) in (str, int, bool, type(None)) for value in result.values()))
                self.assertNotIn(TASK, json.dumps(result))
                self.assertNotIn('visible_plan', json.dumps(result))

    def test_mutated_task_bytes_whitespace_unicode_no_substring_or_normalization(self):
        for profile in subject.PROFILES:
            task_index = json.loads(fixture(profile)['contract_bytes'])['task_index']
            for text in (TASK+' ', TASK.strip(), 'prefix'+TASK, TASK+'suffix', TASK.replace('λ', 'l')):
                f = fixture(profile)
                change_body(f, lambda b: set_text(messages(b)[task_index], text))
                self.unknown(f, 'task_prompt_hash_mismatch')

    def test_same_shape_task_and_aux_swapped_is_not_relocated_by_hash_search(self):
        for profile in ('light-luna-one-setup-v1', 'light-flash-base-v1', 'light-flash-one-setup-v1'):
            f = fixture(profile); index = json.loads(f['contract_bytes'])['task_index']
            def swap(b):
                values = messages(b); values[index-1], values[index] = values[index], values[index-1]
            change_body(f, swap)
            self.unknown(f, 'task_prompt_hash_mismatch')

    def test_task_index_cannot_be_reconfigured_even_with_repinned_contract(self):
        for value in (True, False, -1, 1, 2, '0', 0.0):
            f = fixture('light-luna-base-v1')
            change_contract(f, lambda c: c.update(task_index=value))
            self.unknown(f, 'task_index_mismatch')

    def test_each_auxiliary_content_is_exactly_hashed_not_just_role_or_marker(self):
        for profile in subject.PROFILES:
            f = fixture(profile)
            for entry in json.loads(f['contract_bytes'])['auxiliary']:
                changed = copy.deepcopy(f)
                change_body(changed, lambda b: set_text(messages(b)[entry['index']], '<system-reminder>unknown payload</system-reminder>'))
                self.unknown(changed, 'auxiliary_text_hash_mismatch')

    def test_duplicate_task_in_aux_is_unknown_even_if_aux_hash_is_repinned(self):
        for profile in subject.PROFILES:
            f = fixture(profile); entry = json.loads(f['contract_bytes'])['auxiliary'][0]
            change_body(f, lambda b: set_text(messages(b)[entry['index']], TASK))
            change_contract(f, lambda c: c['auxiliary'][0].update(text_sha256=subject.sha(TASK.encode())))
            self.unknown(f, 'duplicate_or_ambiguous_message_text')

    def test_duplicate_auxiliary_text_is_conservatively_unknown(self):
        f = fixture('light-flash-one-setup-v1')
        change_body(f, lambda b: set_text(messages(b)[2], messages(b)[1]['content']))
        self.unknown(f, 'duplicate_or_ambiguous_message_text')

    def test_extra_missing_and_reordered_roles_or_types_are_unknown(self):
        for profile in subject.PROFILES:
            for change in (lambda b: messages(b).append(copy.deepcopy(messages(b)[-1])),
                           lambda b: messages(b).pop(0),
                           lambda b: messages(b).reverse(),
                           lambda b: messages(b)[0].update(role='assistant'),
                           lambda b: messages(b)[0].update(type='function_call_output'),
                           lambda b: messages(b)[0].update(call_id='prior'),
                           lambda b: messages(b)[0].update(tool_calls=[])):
                f = fixture(profile); change_body(f, change); self.unknown(f)

    def test_content_form_and_single_part_inventory_not_coerced(self):
        f = fixture('pi-luna-v0731-v1')
        changes = [lambda b: messages(b)[1].update(content=TASK),
                   lambda b: messages(b)[1]['content'].append({'type':'input_text','text':''}),
                   lambda b: messages(b)[1]['content'][0].update(type='text'),
                   lambda b: messages(b)[1]['content'][0].update(extra=True),
                   lambda b: messages(b)[1]['content'][0].update(text=None)]
        for change in changes:
            changed = copy.deepcopy(f); change_body(changed, change); self.unknown(changed)

    def test_aux_inventory_requires_exact_order_slot_origin_index_and_digest(self):
        for change in (lambda c: c['auxiliary'].reverse(),
                       lambda c: c['auxiliary'].pop(),
                       lambda c: c['auxiliary'][0].update(index=True),
                       lambda c: c['auxiliary'][0].update(slot='task'),
                       lambda c: c['auxiliary'][0].update(origin='captured-request'),
                       lambda c: c['auxiliary'][0].update(text_sha256='x'),
                       lambda c: c['auxiliary'][0].update(extra='unreviewed')):
            f = fixture('light-flash-one-setup-v1'); change_contract(f, change); self.unknown(f)

    def test_luna_light_instructions_are_separate_exact_inventory_not_unchecked_context(self):
        for value in ('changed', TASK, None):
            f = fixture('light-luna-base-v1'); change_body(f, lambda b: b.update(instructions=value))
            self.unknown(f)
        f = fixture('light-luna-base-v1'); change_body(f, lambda b: b.update(instructions=TASK))
        change_contract(f, lambda c: c.update(instructions_sha256=subject.sha(TASK.encode())))
        self.unknown(f, 'duplicate_or_ambiguous_message_text')
        for profile in ('light-flash-base-v1', 'pi-luna-v0731-v1', 'pi-flash-v0731-v1'):
            f = fixture(profile); change_body(f, lambda b: b.update(instructions='hidden context'))
            self.unknown(f, 'unexpected_instructions')

    def test_root_call_one_is_exact_and_never_later_success(self):
        for fields in ({'call_ordinal':2}, {'call_ordinal':True}, {'call_ordinal':1.0},
            {'prior_root_generations':1}, {'prior_root_generations':False},
            {'initial_request':1}, {'initial_request':False}, {'request_role':'subagent'},
            {'root_turn_id':'other'}, {'run_id':'other'}, {'admission_id':'fixture-1:2'}):
            f = fixture('light-luna-base-v1'); f['admission'].update(fields)
            self.unknown(f, 'not_first_root_admission')

    def test_all_source_pins_must_match_source_review_and_exact_set(self):
        for profile in subject.PROFILES:
            base = fixture(profile)
            for path in base['deployed_source_pins']:
                f = copy.deepcopy(base); f['deployed_source_pins'][path] = 'f'*64
                self.unknown(f, 'deployed_source_pin_mismatch')
            f = copy.deepcopy(base); f['deployed_source_pins']['unreviewed'] = 'a'*64
            self.unknown(f, 'deployed_source_pin_mismatch')
            f = copy.deepcopy(base); f['deployed_source_pins'].pop(next(iter(f['deployed_source_pins'])))
            self.unknown(f, 'deployed_source_pin_mismatch')
            f = copy.deepcopy(base); change_contract(f, lambda c: c.update(source_inventory_sha256='a'*64))
            self.unknown(f, 'source_inventory_hash_mismatch')

    def test_contract_hash_and_identity_binding_including_artifact_configuration(self):
        f = fixture('pi-luna-v0731-v1'); f['contract_bytes'] += b' '
        self.unknown(f, 'contract_hash_mismatch')
        for key in ('protocol_id','run_id','root_turn_id','task_prompt_sha256','client_artifact_sha256','configuration_sha256'):
            f = fixture('pi-luna-v0731-v1')
            change_contract(f, lambda c: c.update({key:'d'*64}))
            self.unknown(f, 'contract_identity_mismatch')
        f = fixture('pi-luna-v0731-v1'); f['expected']['client'] = 'light'
        self.unknown(f, 'client_route_mismatch')

    def test_unknown_profiles_wrong_models_streams_and_conversation_fields(self):
        f = fixture('light-luna-base-v1'); change_contract(f, lambda c: c.update(profile_id='guessed-new-layout'))
        self.unknown(f, 'unknown_layout_profile')
        for fields in ({'model':'other'}, {'stream':False}, {'stream':1},
                       {'conversation':None}, {'previous_response_id':None}, {'messages':[]}):
            f = fixture('light-luna-base-v1'); change_body(f, lambda b: b.update(fields)); self.unknown(f)

    def test_strict_json_and_raw_bytes(self):
        for value in (None, 'text', b'{', b'{"model":1,"model":2}', b'{"x":NaN}', b'\xff', b'[]'):
            f = fixture('light-luna-base-v1'); f['request_bytes'] = value; self.unknown(f)
        f = fixture('light-luna-base-v1'); change_body(f, lambda b: set_text(messages(b)[0], '\ud800'))
        self.unknown(f, 'invalid_unicode_text')

    def test_missing_extra_and_wrong_types_in_contract_expected_and_admission(self):
        for container in ('expected','admission'):
            f = fixture('pi-flash-v0731-v1')
            for key in list(f[container]):
                changed = copy.deepcopy(f); del changed[container][key]; self.unknown(changed)
            f[container]['unexpected'] = 'private-marker'; self.unknown(f)
        for key in subject.CONTRACT_FIELDS:
            f = fixture('pi-flash-v0731-v1'); change_contract(f, lambda c: c.pop(key)); self.unknown(f)
        for value in (True, 1.0, 2, None):
            f = fixture('pi-flash-v0731-v1'); change_contract(f, lambda c: c.update(schema_version=value)); self.unknown(f)

    def test_code_execution_and_planning_facts_are_not_inferred_from_identity(self):
        result = subject.bind_initial_request(**fixture('light-luna-base-v1'))
        for key in ('code_completion','planning_required','visible_plan_format_pass','normal_exit','paid','usage_complete'):
            self.assertNotIn(key, result)


if __name__ == '__main__':
    unittest.main()
