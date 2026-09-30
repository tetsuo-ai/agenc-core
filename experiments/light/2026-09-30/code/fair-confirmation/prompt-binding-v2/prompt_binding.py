"""Offline, source-owned initial-request identity checks. Never scores input.

The caller supplies a trusted preflight contract and independently verified
deployment inventory. This reducer cannot authenticate that caller or generate
auxiliary-message provenance from the request it is checking.
"""
from __future__ import annotations

import hashlib
import json
import math
import re


LIGHT_COMMON = {
    'runtime/src/llm/providers/openai/adapter.ts': '5e4dbc50e5d55ca89ef2b01b945e6b10a3aff3736f814c9006e499a9addbe7b4',
    'runtime/src/llm/wire/capability-gating.ts': 'f0bc9b7c0bcbf94941599ba4e995e250f73215878839610c3dc645a56e428c89',
    'runtime/src/session/run-turn-messages.ts': '30694f9754ef2da39820ea07bb6a07eb7eb0f2ba71bea8d1181e99e62379adbb',
    'runtime/src/session/run-turn-attachments.ts': 'f4951388afc0cc2ef360ee4867e066d65530c0862fb1cda2b44331068f391faf',
    'runtime/src/prompts/attachments/messages.ts': '26564c3fd87aaa3a771d7ca9623a4fe3b86291954a7d85eaa8e2b18942c38eec',
}
PI_COMMON = {
    '@mariozechner/pi-ai/package.json': 'a0843d454ed489200148c5bde5f35b4a5b0e991e04056f6640022aabcb1471d3',
    '@mariozechner/pi-coding-agent/package.json': 'f8355b4a90ef7892ff7c8ddfc377fb20e6703e843b78e9a87b77d619d76d6d56',
    '@mariozechner/pi-coding-agent/dist/core/agent-session.js': '84687393bb0db810b93b6e632815ae5e54e1e0ebc17690ec1c4419791c73619f',
    '@mariozechner/pi-ai/dist/providers/transform-messages.js': '2601ac1c657643dc4f2f1cb55785a3ef435077345457d973fb0a018dfcefa469',
    '@mariozechner/pi-ai/dist/utils/sanitize-unicode.js': '77cb844b43f502cc24b25ef284ec5a6f6ac375ac994bcf688275848e1475bc80',
}
LIGHT_RESPONSES = {**LIGHT_COMMON,
    'runtime/src/llm/wire/responses-openai.ts': 'be64f8dbf6331ee4a27c5f4f96db2ddb834655002650bcaf0773618f66b12fbd'}
LIGHT_CHAT = {**LIGHT_COMMON,
    'runtime/src/llm/wire/chat-completions.ts': 'a0c25c5e53c0ee583ad5c9f8f174dda32a6e751ce271341e24ea34cfaa1d4ab9',
    'runtime/src/llm/wire/shared-prefix-tail.ts': '18e5d88357e6363ca1e7bd4f060b2343edd7e07e70711f5566005998a9877558'}
PI_RESPONSES = {**PI_COMMON,
    '@mariozechner/pi-ai/dist/providers/openai-responses.js': 'f7dd3f18db02e202bdacbf47b58732933bf16ccc8306a3991d67d43e5e04cbd4',
    '@mariozechner/pi-ai/dist/providers/openai-responses-shared.js': 'f66c9784c84338c9bb4560eab7a690974ad11ffaf3ad1b164b257354d0972018'}
PI_CHAT = {**PI_COMMON,
    '@mariozechner/pi-ai/dist/providers/openai-completions.js': '8c03f377889ce735959b1b0229b511337cda9f7386a74fb7e51673eb2612b07e'}

# A slot is (name, role, exact content form, explicit message type or None).
# Profiles are explicit, never discovered by examining matching task text.
TASK_L = ('task', 'user', 'input_text', 'message')
SETUP_L = ('setup_attachment', 'user', 'input_text', 'message')
TAIL_L = ('dynamic_system', 'system', 'input_text', 'message')
STATIC_C = ('static_system', 'system', 'string', None)
SETUP_C = ('setup_attachment', 'user', 'string', None)
TAIL_C = ('session_tail', 'user', 'string', None)
TASK_C = ('task', 'user', 'string', None)
PROFILES = {
    'light-luna-base-v2': ('light', 'openai-direct', (TASK_L, TAIL_L), True, LIGHT_RESPONSES),
    'light-luna-one-setup-v2': ('light', 'openai-direct', (SETUP_L, TASK_L, TAIL_L), True, LIGHT_RESPONSES),
    'light-flash-base-v2': ('light', 'deepseek-proxy', (STATIC_C, TAIL_C, TASK_C), False, LIGHT_CHAT),
    'light-flash-one-setup-v2': ('light', 'deepseek-proxy', (STATIC_C, SETUP_C, TAIL_C, TASK_C), False, LIGHT_CHAT),
    'pi-luna-v0731-v2': ('pi', 'openai-direct',
        (('static_system', 'developer', 'string', None), ('task', 'user', 'input_text', None)), False, PI_RESPONSES),
    'pi-flash-v0731-v2': ('pi', 'deepseek-proxy',
        (STATIC_C, ('task', 'user', 'text', None)), False, PI_CHAT),
}
ORIGINS = {
    'setup_attachment': 'light.attachment-projection',
    'dynamic_system': 'light.responses-dynamic-suffix',
    'session_tail': 'light.shared-prefix-session-tail',
}
CONTRACT_FIELDS = {'schema_version', 'profile_id', 'protocol_id', 'run_id', 'root_turn_id',
    'task_index', 'task_prompt_sha256', 'auxiliary', 'instructions_sha256',
    'source_inventory_sha256', 'client_artifact_sha256', 'configuration_sha256',
    'envelope_fields', 'envelope_sha256'}
ADMISSION_FIELDS = {'run_id', 'root_turn_id', 'admission_id', 'call_ordinal',
                    'prior_root_generations', 'initial_request', 'request_role'}
EXPECTED_FIELDS = {'contract_sha256', 'protocol_id', 'run_id', 'root_turn_id',
    'client', 'route', 'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256'}


# Bounded source-derived subset, not an extension wildcard or provider schema.
# Every admitted field/value is additionally bound by the trusted exact envelope
# digest. Other builder branches remain unsupported until separately reviewed.
ENVELOPE_FIELDS = {
    ('light', 'openai-direct'): {
        'model', 'stream', 'store', 'tools', 'tool_choice', 'parallel_tool_calls',
        'prompt_cache_key', 'service_tier', 'temperature', 'max_output_tokens',
        'include', 'reasoning', 'text'},
    ('pi', 'openai-direct'): {
        'model', 'stream', 'store', 'tools', 'prompt_cache_key',
        'prompt_cache_retention', 'service_tier', 'temperature',
        'max_output_tokens', 'include', 'reasoning'},
    ('light', 'deepseek-proxy'): {
        'model', 'stream', 'max_tokens', 'tools', 'tool_choice',
        'parallel_tool_calls', 'temperature', 'stop', 'thinking',
        'reasoning_effort', 'response_format', 'stream_options'},
    ('pi', 'deepseek-proxy'): {
        'model', 'stream', 'max_tokens', 'tools', 'tool_choice',
        'temperature', 'thinking', 'reasoning_effort', 'stream_options'},
}


class Unknown(ValueError):
    pass


def require(value, reason):
    if not value:
        raise Unknown(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def identity(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,240}', value) is not None


def parse(raw):
    require(type(raw) is bytes, 'raw_bytes_required')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    try:
        result = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
            parse_constant=lambda _: require(False, 'nonfinite_json'))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise Unknown('malformed_json') from exc
    # json.loads permits overflow floats and escaped lone surrogates. Validate
    # the entire tree, including fields that will subsequently be refused.
    def strict(value, depth=0):
        require(depth <= 256, 'json_depth_limit')
        if type(value) is str:
            require(not any(0xD800 <= ord(ch) <= 0xDFFF for ch in value),
                    'invalid_unicode_text')
        elif type(value) is float:
            require(math.isfinite(value), 'nonfinite_json')
        elif type(value) is dict:
            for key, child in value.items():
                strict(key, depth + 1)
                strict(child, depth + 1)
        elif type(value) is list:
            for child in value:
                strict(child, depth + 1)
    strict(result)
    require(type(result) is dict, 'object_required')
    return result


def text_at(message, slot):
    _, role, form, message_type = slot
    fields = {'role', 'content'} | ({'type'} if message_type else set())
    require(type(message) is dict and set(message) == fields, 'message_field_inventory_mismatch')
    require(message['role'] == role and (message_type is None or message['type'] == message_type),
            'message_role_or_type_mismatch')
    value = message['content']
    if form != 'string':
        require(type(value) is list and len(value) == 1 and type(value[0]) is dict,
                'message_content_shape_mismatch')
        require(set(value[0]) == {'type', 'text'} and value[0]['type'] == form,
                'message_part_inventory_mismatch')
        value = value[0]['text']
    require(type(value) is str, 'message_text_required')
    try:
        return value.encode('utf-8')
    except UnicodeError as exc:
        raise Unknown('invalid_unicode_text') from exc


def bind_initial_request(*, request_bytes, contract_bytes, expected, admission, deployed_source_pins):
    """Return scalar identity evidence or unknown; never return text or a plan score.

    `expected` and auxiliary contract must be minted outside the captured request.
    `deployed_source_pins` must come from verified installation bytes, not the model.
    Unknown is None (not False): no claim of task failure follows from refusal.
    """
    result = {'binding_verified': None, 'unknown_reason': None}
    try:
        require(type(expected) is dict and set(expected) == EXPECTED_FIELDS, 'invalid_expected_inventory')
        for key in ('protocol_id', 'run_id', 'root_turn_id'):
            require(identity(expected[key]), 'invalid_expected_identity')
        for key in ('contract_sha256', 'task_prompt_sha256', 'client_artifact_sha256', 'configuration_sha256'):
            require(digest(expected[key]), 'invalid_expected_digest')
        contract = parse(contract_bytes)
        require(sha(contract_bytes) == expected['contract_sha256'], 'contract_hash_mismatch')
        require(set(contract) == CONTRACT_FIELDS and type(contract['schema_version']) is int
                and contract['schema_version'] == 2, 'contract_schema_mismatch')
        profile_id = contract['profile_id']
        require(type(profile_id) is str and profile_id in PROFILES, 'unknown_layout_profile')
        client, route, slots, instructions, sources = PROFILES[profile_id]
        require(expected['client'] == client and expected['route'] == route, 'client_route_mismatch')
        for key in ('protocol_id', 'run_id', 'root_turn_id', 'task_prompt_sha256',
                    'client_artifact_sha256', 'configuration_sha256'):
            require(contract[key] == expected[key], 'contract_identity_mismatch')
        require(type(deployed_source_pins) is dict and deployed_source_pins == sources,
                'deployed_source_pin_mismatch')
        source_hash = sha(canonical(sources))
        require(contract['source_inventory_sha256'] == source_hash, 'source_inventory_hash_mismatch')
        require(type(admission) is dict and set(admission) == ADMISSION_FIELDS, 'invalid_admission_inventory')
        require(admission['run_id'] == expected['run_id'] and admission['root_turn_id'] == expected['root_turn_id']
            and admission['admission_id'] == expected['run_id'] + ':1'
            and type(admission['call_ordinal']) is int and admission['call_ordinal'] == 1
            and type(admission['prior_root_generations']) is int and admission['prior_root_generations'] == 0
            and admission['initial_request'] is True and admission['request_role'] == 'root',
            'not_first_root_admission')
        task_index = next(index for index, slot in enumerate(slots) if slot[0] == 'task')
        require(type(contract['task_index']) is int and contract['task_index'] == task_index, 'task_index_mismatch')
        body = parse(request_bytes)
        require(body.get('model') == ('gpt-6-luna' if route == 'openai-direct' else 'deepseek-flash')
                and body.get('stream') is True, 'request_route_or_stream_mismatch')
        require(not any(key in body for key in ('previous_response_id', 'conversation')),
                'prior_conversation_pointer')
        key = 'input' if route == 'openai-direct' else 'messages'
        require(('messages' if key == 'input' else 'input') not in body, 'ambiguous_message_envelope')
        allowed = ENVELOPE_FIELDS[(client, route)] | {key}
        if instructions:
            allowed |= {'instructions'}
        require(set(body) <= allowed, 'unreviewed_request_field')
        envelope = {name: value for name, value in body.items()
                    if name not in {key, 'instructions'}}
        fields = contract['envelope_fields']
        require(type(fields) is list and all(type(name) is str for name in fields)
                and fields == sorted(envelope), 'envelope_field_inventory_mismatch')
        envelope_hash = sha(canonical(envelope))
        require(digest(contract['envelope_sha256'])
                and envelope_hash == contract['envelope_sha256'],
                'envelope_hash_mismatch')
        messages = body.get(key)
        require(type(messages) is list and len(messages) == len(slots), 'message_count_mismatch')
        # Read only the fixed profile indices; never select by searching content.
        hashes = [sha(text_at(message, slot)) for message, slot in zip(messages, slots)]
        require(hashes[task_index] == expected['task_prompt_sha256'], 'task_prompt_hash_mismatch')
        require(len(set(hashes)) == len(hashes), 'duplicate_or_ambiguous_message_text')
        auxiliary = contract['auxiliary']
        require(type(auxiliary) is list and len(auxiliary) == len(slots) - 1, 'auxiliary_inventory_mismatch')
        aux_index = 0
        for index, slot in enumerate(slots):
            if index == task_index:
                continue
            entry = auxiliary[aux_index]
            origin = ORIGINS.get(slot[0], client + '.static-system')
            require(type(entry) is dict and set(entry) == {'index', 'slot', 'origin', 'text_sha256'},
                    'auxiliary_inventory_mismatch')
            require(type(entry['index']) is int and entry['index'] == index and entry['slot'] == slot[0]
                    and entry['origin'] == origin and digest(entry['text_sha256']), 'auxiliary_origin_or_index_mismatch')
            require(entry['text_sha256'] == hashes[index], 'auxiliary_text_hash_mismatch')
            aux_index += 1
        if instructions:
            require(type(body.get('instructions')) is str and digest(contract['instructions_sha256']),
                    'instructions_inventory_mismatch')
            instruction_hash = sha(body['instructions'].encode('utf-8'))
            require(instruction_hash == contract['instructions_sha256'], 'instructions_hash_mismatch')
            require(instruction_hash not in hashes, 'duplicate_or_ambiguous_message_text')
        else:
            require('instructions' not in body and contract['instructions_sha256'] is None,
                    'unexpected_instructions')
        result.update(binding_verified=True, profile_id=profile_id, client=client, route=route,
            protocol_id=expected['protocol_id'], run_id=expected['run_id'], root_turn_id=expected['root_turn_id'],
            call_ordinal=1, task_index=task_index, task_prompt_sha256=hashes[task_index],
            request_body_sha256=sha(request_bytes), contract_sha256=sha(contract_bytes),
            source_inventory_sha256=source_hash, client_artifact_sha256=expected['client_artifact_sha256'],
            configuration_sha256=expected['configuration_sha256'], auxiliary_count=len(auxiliary),
            envelope_sha256=envelope_hash, envelope_field_count=len(envelope))
    except Unknown as exc:
        result['unknown_reason'] = str(exc)
    except (UnicodeError, TypeError, ValueError, KeyError, RecursionError):
        result['unknown_reason'] = 'malformed_binding_evidence'
    return result

