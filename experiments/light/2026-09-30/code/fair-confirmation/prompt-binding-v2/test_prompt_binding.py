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
    contract = {'schema_version': 2, 'profile_id': profile_id, 'protocol_id': 'synthetic-fair-v3',
        'run_id': 'fixture-1', 'root_turn_id': 'root-1', 'task_index': task_index,
        'task_prompt_sha256': subject.sha(TASK.encode()), 'auxiliary': auxiliary,
        'instructions_sha256': subject.sha(body['instructions'].encode()) if instructions else None,
        'source_inventory_sha256': subject.sha(subject.canonical(sources)),
        'client_artifact_sha256': 'b'*64, 'configuration_sha256': 'c'*64}
    envelope = {key: value for key, value in body.items() if key not in ('input', 'messages', 'instructions')}
    contract.update(envelope_fields=sorted(envelope), envelope_sha256=subject.sha(subject.canonical(envelope)))
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


def authorize_synthetic_envelope(f):
    # Test-only stand-in for an independent trusted preflight producer.
    # Production must never derive this expectation from captured wire input.
    body = json.loads(f['request_bytes'])
    envelope = {key: value for key, value in body.items()
                if key not in ('input', 'messages', 'instructions')}
    change_contract(f, lambda c: c.update(envelope_fields=sorted(envelope),
        envelope_sha256=subject.sha(subject.canonical(envelope))))


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
        for profile in ('light-luna-one-setup-v2', 'light-flash-base-v2', 'light-flash-one-setup-v2'):
            f = fixture(profile); index = json.loads(f['contract_bytes'])['task_index']
            def swap(b):
                values = messages(b); values[index-1], values[index] = values[index], values[index-1]
            change_body(f, swap)
            self.unknown(f, 'task_prompt_hash_mismatch')

    def test_task_index_cannot_be_reconfigured_even_with_repinned_contract(self):
        for value in (True, False, -1, 1, 2, '0', 0.0):
            f = fixture('light-luna-base-v2')
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
        f = fixture('light-flash-one-setup-v2')
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
        f = fixture('pi-luna-v0731-v2')
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
            f = fixture('light-flash-one-setup-v2'); change_contract(f, change); self.unknown(f)

    def test_luna_light_instructions_are_separate_exact_inventory_not_unchecked_context(self):
        for value in ('changed', TASK, None):
            f = fixture('light-luna-base-v2'); change_body(f, lambda b: b.update(instructions=value))
            self.unknown(f)
        f = fixture('light-luna-base-v2'); change_body(f, lambda b: b.update(instructions=TASK))
        change_contract(f, lambda c: c.update(instructions_sha256=subject.sha(TASK.encode())))
        self.unknown(f, 'duplicate_or_ambiguous_message_text')
        for profile in ('light-flash-base-v2', 'pi-luna-v0731-v2', 'pi-flash-v0731-v2'):
            f = fixture(profile); change_body(f, lambda b: b.update(instructions='hidden context'))
            self.unknown(f, 'unreviewed_request_field')

    def test_root_call_one_is_exact_and_never_later_success(self):
        for fields in ({'call_ordinal':2}, {'call_ordinal':True}, {'call_ordinal':1.0},
            {'prior_root_generations':1}, {'prior_root_generations':False},
            {'initial_request':1}, {'initial_request':False}, {'request_role':'subagent'},
            {'root_turn_id':'other'}, {'run_id':'other'}, {'admission_id':'fixture-1:2'}):
            f = fixture('light-luna-base-v2'); f['admission'].update(fields)
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
        f = fixture('pi-luna-v0731-v2'); f['contract_bytes'] += b' '
        self.unknown(f, 'contract_hash_mismatch')
        for key in ('protocol_id','run_id','root_turn_id','task_prompt_sha256','client_artifact_sha256','configuration_sha256'):
            f = fixture('pi-luna-v0731-v2')
            change_contract(f, lambda c: c.update({key:'d'*64}))
            self.unknown(f, 'contract_identity_mismatch')
        f = fixture('pi-luna-v0731-v2'); f['expected']['client'] = 'light'
        self.unknown(f, 'client_route_mismatch')

    def test_unknown_profiles_wrong_models_streams_and_conversation_fields(self):
        f = fixture('light-luna-base-v2'); change_contract(f, lambda c: c.update(profile_id='guessed-new-layout'))
        self.unknown(f, 'unknown_layout_profile')
        for fields in ({'model':'other'}, {'stream':False}, {'stream':1},
                       {'conversation':None}, {'previous_response_id':None}, {'messages':[]}):
            f = fixture('light-luna-base-v2'); change_body(f, lambda b: b.update(fields)); self.unknown(f)

    def test_strict_json_and_raw_bytes(self):
        for value in (None, 'text', b'{', b'{"model":1,"model":2}', b'{"x":NaN}', b'\xff', b'[]'):
            f = fixture('light-luna-base-v2'); f['request_bytes'] = value; self.unknown(f)
        f = fixture('light-luna-base-v2'); change_body(f, lambda b: set_text(messages(b)[0], '\ud800'))
        self.unknown(f, 'invalid_unicode_text')

    def test_missing_extra_and_wrong_types_in_contract_expected_and_admission(self):
        for container in ('expected','admission'):
            f = fixture('pi-flash-v0731-v2')
            for key in list(f[container]):
                changed = copy.deepcopy(f); del changed[container][key]; self.unknown(changed)
            f[container]['unexpected'] = 'private-marker'; self.unknown(f)
        for key in subject.CONTRACT_FIELDS:
            f = fixture('pi-flash-v0731-v2'); change_contract(f, lambda c: c.pop(key)); self.unknown(f)
        for value in (True, 2.0, 1, None):
            f = fixture('pi-flash-v0731-v2'); change_contract(f, lambda c: c.update(schema_version=value)); self.unknown(f)

    def test_code_execution_and_planning_facts_are_not_inferred_from_identity(self):
        result = subject.bind_initial_request(**fixture('light-luna-base-v2'))
        for key in ('code_completion','planning_required','visible_plan_format_pass','normal_exit','paid','usage_complete'):
            self.assertNotIn(key, result)

    def test_overflow_and_constants_are_rejected_recursively_in_all_json(self):
        for raw_value in (b'1e999', b'-1e999', b'NaN', b'Infinity', b'-Infinity'):
            for nested in (raw_value, b'{"nested":[' + raw_value + b']}'):
                f = fixture('light-luna-base-v2')
                f['request_bytes'] = f['request_bytes'][:-1] + b',"unreviewed":' + nested + b'}'
                self.unknown(f, 'nonfinite_json')
                f = fixture('light-luna-base-v2')
                f['contract_bytes'] = f['contract_bytes'][:-1] + b',"unreviewed":' + nested + b'}'
                self.unknown(f, 'nonfinite_json')

    def test_lone_surrogate_values_and_keys_rejected_everywhere(self):
        for escape in (b'\\ud800', b'\\udfff', b'\\ud800x', b'\\udc00\\ud800'):
            for fragment in (b'"unreviewed":"' + escape + b'"',
                b'"tools":[{"parameters":{"description":"' + escape + b'"}}]',
                b'"tools":[{"parameters":{"' + escape + b'":"value"}}]'):
                f = fixture('light-luna-base-v2')
                f['request_bytes'] = f['request_bytes'][:-1] + b',' + fragment + b'}'
                self.unknown(f, 'invalid_unicode_text')
            f = fixture('light-luna-base-v2')
            f['contract_bytes'] = f['contract_bytes'][:-1] + b',"' + escape + b'":0}'
            self.unknown(f, 'invalid_unicode_text')

    def test_valid_surrogate_pair_decodes_to_scalar_without_normalization(self):
        f = fixture('pi-luna-v0731-v2')
        text = TASK + '\U0001f600'
        change_body(f, lambda b: set_text(messages(b)[1], text))
        task_hash = subject.sha(text.encode())
        change_contract(f, lambda c: c.update(task_prompt_sha256=task_hash))
        f['expected']['task_prompt_sha256'] = task_hash
        self.assertIn(b'\\ud83d\\ude00', f['request_bytes'])
        self.assertIs(subject.bind_initial_request(**f)['binding_verified'], True)

    def test_unknown_context_fields_rejected_even_with_repinned_envelope(self):
        for profile in subject.PROFILES:
            for field in ('prompt', 'context', 'history', 'metadata', 'extra_body',
                          'extensions', 'developer', 'system', 'user', 'background'):
                f = fixture(profile)
                change_body(f, lambda b: b.update({field: {'text': 'unreviewed context'}}))
                authorize_synthetic_envelope(f)
                self.unknown(f, 'unreviewed_request_field')

    def test_route_specific_source_envelope_cannot_borrow_other_client_fields(self):
        for profile, field, value in (
            ('pi-luna-v0731-v2', 'parallel_tool_calls', True),
            ('light-luna-base-v2', 'prompt_cache_retention', '24h'),
            ('pi-flash-v0731-v2', 'response_format', {'type': 'json_object'}),
            ('light-flash-base-v2', 'max_output_tokens', 8192),
            ('pi-flash-v0731-v2', 'store', False)):
            f = fixture(profile)
            change_body(f, lambda b: b.update({field: value}))
            authorize_synthetic_envelope(f)
            self.unknown(f, 'unreviewed_request_field')

    def test_preapproved_envelope_binds_nested_tools_settings_and_field_presence(self):
        for profile in subject.PROFILES:
            f = fixture(profile)
            change_body(f, lambda b: b.update(tools=[{'type': 'function',
                'name': 'synthetic', 'parameters': {'type': 'object',
                'properties': {'value': {'description': 'trusted synthetic schema'}}}}]))
            authorize_synthetic_envelope(f)
            good = subject.bind_initial_request(**f)
            self.assertIs(good['binding_verified'], True)
            self.assertEqual(good['envelope_sha256'], json.loads(f['contract_bytes'])['envelope_sha256'])
            for replacement in (None, [], [{'type': 'function', 'name': 'other'}]):
                changed = copy.deepcopy(f)
                change_body(changed, lambda b: b.update(tools=replacement))
                self.unknown(changed, 'envelope_hash_mismatch')
            changed = copy.deepcopy(f); change_body(changed, lambda b: b.pop('tools'))
            self.unknown(changed, 'envelope_field_inventory_mismatch')

    def test_nested_tool_description_mutation_not_hidden_by_matching_task(self):
        f = fixture('light-luna-base-v2')
        change_body(f, lambda b: b.update(tools=[{'description':'preauthorized'}],
            reasoning={'effort':'low','summary':'auto'}, max_output_tokens=8192))
        authorize_synthetic_envelope(f)
        for fn in (lambda b: b['tools'][0].update(description='different context'),
                   lambda b: b['reasoning'].update(effort='medium'),
                   lambda b: b['reasoning'].update(prompt='extra'),
                   lambda b: b.update(max_output_tokens=8193)):
            changed = copy.deepcopy(f); change_body(changed, fn)
            self.unknown(changed, 'envelope_hash_mismatch')

    def test_missing_versus_null_not_coalesced(self):
        f = fixture('pi-luna-v0731-v2')
        change_body(f, lambda b: b.update(temperature=None))
        self.unknown(f, 'envelope_field_inventory_mismatch')
        authorize_synthetic_envelope(f)
        self.assertIs(subject.bind_initial_request(**f)['binding_verified'], True)
        # Identity binding does not assert this null is semantically allowed by
        # a provider. Exact trusted policy validation remains a separate gate.
        change_body(f, lambda b: b.pop('temperature'))
        self.unknown(f, 'envelope_field_inventory_mismatch')

    def test_envelope_inventory_exact_sorted_unique_fields_and_digest(self):
        for value in (None, [], ['stream','model'], ['model','stream','stream'],
                      ['model','stream', 'tools'], [True, 'stream']):
            f = fixture('pi-luna-v0731-v2')
            change_contract(f, lambda c: c.update(envelope_fields=value))
            self.unknown(f, 'envelope_field_inventory_mismatch')
        for value in (None, 'x', 'a'*64, 12):
            f = fixture('pi-luna-v0731-v2')
            change_contract(f, lambda c: c.update(envelope_sha256=value))
            self.unknown(f, 'envelope_hash_mismatch')

    def test_bom_nested_duplicate_escape_and_depth_are_unknown(self):
        for raw in (b'\xef\xbb\xbf{}', b'{"tools":[{"x":1,"\\u0078":2}]}',
                    b'{"x":' + b'['*258 + b'0' + b']'*258 + b'}'):
            f = fixture('light-luna-base-v2'); f['request_bytes'] = raw
            self.unknown(f)

    def test_v1_contract_cannot_silently_activate_v2(self):
        f = fixture('light-luna-base-v2')
        change_contract(f, lambda c: c.update(schema_version=1))
        self.unknown(f, 'contract_schema_mismatch')
        f = fixture('light-luna-base-v2')
        change_contract(f, lambda c: c.update(profile_id='light-luna-base-v1'))
        self.unknown(f, 'unknown_layout_profile')


if __name__ == '__main__':
    unittest.main()
