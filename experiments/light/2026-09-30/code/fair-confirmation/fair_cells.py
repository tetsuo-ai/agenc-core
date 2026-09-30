"""Offline receipt-to-score integration; no runner, provider or ledger access.

Only fixed sibling adapter/grader sources are read. Their exact verified bytes
are executed in memory, avoiding an import-cache/source-hash mismatch. Pins and
receipt inventories must come from a trusted future harness, not the agent.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import stat

HERE = pathlib.Path(__file__).resolve().parent
ROUTES = {'deepseek-proxy': ('deepseek-flash', 'adapt_chat_completions'),
          'openai-direct': ('gpt-6-luna', 'adapt_openai_responses')}
RECEIPT_FIELDS = {
    'schema_version', 'protocol_id', 'run_id', 'root_turn_id', 'request_role',
    'admission_id', 'call_ordinal', 'prior_root_generations', 'initial_request',
    'route', 'source', 'request_body_sha256', 'task_prompt_sha256',
    'response_bytes_sha256', 'response_byte_count', 'http_status',
    'response_content_type', 'requested_stream', 'transport_outcome',
    'downstream_delivery_failed', 'capture_write_complete',
    'observer_source_sha256', 'installed_adapter_sha256',
}


class EvidenceUnknown(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise EvidenceUnknown(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def identity(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,240}', value) is not None


def _read_source(filename):
    # No arbitrary import/file path supplied through capture evidence.
    fd = os.open(HERE / filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'source_not_regular')
        with os.fdopen(os.dup(fd), 'rb') as handle:
            return handle.read()
    finally:
        os.close(fd)


def _load_pinned(filename, expected):
    require(digest(expected), 'missing_source_pin')
    try:
        raw = _read_source(filename)
    except OSError as error:
        raise EvidenceUnknown('pinned_source_unavailable') from error
    require(sha(raw) == expected, 'source_pin_mismatch')
    namespace = {'__name__': '_fair_' + filename[:-3], '__file__': str(HERE / filename)}
    # Both compilation and execution use exactly the bytes just hashed, not an
    # already imported module nor a second path read that could have changed.
    exec(compile(raw, str(HERE / filename), 'exec'), namespace)
    return namespace


def _json(raw):
    require(type(raw) is bytes, 'raw_evidence_bytes_required')
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate_json_key')
            value[key] = item
        return value
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
                           parse_constant=lambda _: require(False, 'nonfinite_json'))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise EvidenceUnknown('malformed_evidence_json') from error
    require(isinstance(value, dict), 'object_evidence_required')
    return value


def _prompt_from_initial_request(body, route):
    require(body.get('model') == ROUTES[route][0] and body.get('stream') is True,
            'unexpected_initial_request_route_or_stream')
    require(body.get('previous_response_id') is None and body.get('conversation') is None,
            'prior_conversation_pointer')
    messages = body.get('messages' if route == 'deepseek-proxy' else 'input')
    require(isinstance(messages, list) and bool(messages), 'missing_initial_message_list')
    users = []
    for index, message in enumerate(messages):
        require(isinstance(message, dict), 'invalid_initial_message')
        require(message.get('role') in ('system', 'developer', 'user')
                and message.get('type', 'message') == 'message'
                and not any(key in message for key in ('tool_calls', 'tool_call_id', 'call_id', 'function_call')),
                'prior_or_ambiguous_generation_history')
        if message['role'] == 'user':
            users.append((index, message.get('content')))
    require(len(users) == 1 and users[0][0] == len(messages) - 1, 'ambiguous_initial_user_message')
    content = users[0][1]
    if isinstance(content, str):
        return content
    part_type = 'text' if route == 'deepseek-proxy' else 'input_text'
    require(isinstance(content, list) and len(content) == 1 and isinstance(content[0], dict)
            and set(content[0]) == {'type', 'text'} and content[0]['type'] == part_type
            and isinstance(content[0]['text'], str), 'unsupported_or_ambiguous_user_content')
    return content[0]['text']


def _verify(spec, receipt_raw, request_raw, response_raw, adapter_pin):
    require(isinstance(spec, dict), 'missing_cell_specification')
    for key in ('protocol_id', 'run_id', 'root_turn_id'):
        require(identity(spec.get(key)), 'invalid_expected_identity')
    route = spec.get('route')
    require(route in ROUTES, 'unsupported_expected_route')
    for key in ('task_prompt_sha256', 'observer_source_sha256', 'receipt_sha256', 'request_body_sha256'):
        require(digest(spec.get(key)), 'missing_expected_evidence_pin')
    receipt = _json(receipt_raw)
    require(sha(receipt_raw) == spec['receipt_sha256'], 'receipt_hash_mismatch')
    require(set(receipt) == RECEIPT_FIELDS, 'missing_or_unknown_receipt_fields')
    require(type(receipt['schema_version']) is int and receipt['schema_version'] == 1, 'unsupported_receipt_schema')
    for key in ('protocol_id', 'run_id', 'root_turn_id', 'route', 'task_prompt_sha256', 'observer_source_sha256'):
        require(receipt[key] == spec[key], 'receipt_identity_or_source_mismatch')
    require(receipt['installed_adapter_sha256'] == adapter_pin, 'receipt_adapter_pin_mismatch')
    require(type(receipt['call_ordinal']) is int and receipt['call_ordinal'] == 1
            and receipt['admission_id'] == spec['run_id'] + ':1'
            and receipt['request_role'] == 'root' and receipt['initial_request'] is True
            and type(receipt['prior_root_generations']) is int and receipt['prior_root_generations'] == 0,
            'not_unambiguous_first_root_admission')
    require(receipt['source'] == 'provider_response_sse', 'output_sse_origin_required')
    require(type(receipt['http_status']) is int and receipt['http_status'] == 200
            and isinstance(receipt['response_content_type'], str)
            and receipt['response_content_type'].split(';', 1)[0].strip().lower() == 'text/event-stream'
            and receipt['requested_stream'] is True, 'not_successful_streaming_response')
    require(receipt['transport_outcome'] == 'eof' and receipt['downstream_delivery_failed'] is False
            and receipt['capture_write_complete'] is True, 'incomplete_transport_delivery_or_write')
    require(type(request_raw) is bytes and receipt['request_body_sha256'] == sha(request_raw)
            and receipt['request_body_sha256'] == spec['request_body_sha256'], 'request_hash_mismatch')
    require(type(response_raw) is bytes and digest(receipt['response_bytes_sha256'])
            and sha(response_raw) == receipt['response_bytes_sha256'], 'response_hash_mismatch')
    require(type(receipt['response_byte_count']) is int and receipt['response_byte_count'] == len(response_raw),
            'response_byte_count_mismatch')
    body = _json(request_raw)
    prompt = _prompt_from_initial_request(body, route)
    require(sha(prompt.encode('utf-8')) == spec['task_prompt_sha256'], 'initial_root_prompt_mismatch')
    return route


def score_fair_cell(*, spec, receipt_bytes, request_bytes, response_bytes, source_pins,
                    planning_required, code_artifact_pass, normal_exit, timed_out, budget_stopped):
    """Score one supplied call-1 capture; never enumerate/search later attempts.

    spec/receipt digests must be trusted harness inventory assertions. Validation
    cannot establish a filesystem write, root ownership or EOF independently of
    that trusted recorder. Input text is used ONLY to bind the initial request.
    """
    pins = source_pins if isinstance(source_pins, dict) else {}
    original = dict(code_artifact_pass=code_artifact_pass, normal_exit=normal_exit,
                    timed_out=timed_out, budget_stopped=budget_stopped)
    invalid_outcome = any(value is not None and type(value) is not bool for value in original.values())
    original = {key: value if value is None or type(value) is bool else None for key, value in original.items()}
    result = {'schema_version': 1, **original, 'planning_required': planning_required if type(planning_required) is bool else None,
              'code_completion': None, 'visible_plan_format_pass': None, 'requested_format_contract_pass': None,
              'plan_semantic_quality': None, 'capture_verified': False, 'adapter_capture_complete': False,
              'adapter_sha256': None, 'grader_sha256': None, 'plan_reason': 'capture_not_verified',
              'evidence_unknown_reason': None, 'outcome_unknown_reason': 'invalid_original_outcome_type' if invalid_outcome else None}
    for key in ('protocol_id', 'run_id', 'root_turn_id', 'route', 'task_prompt_sha256', 'observer_source_sha256'):
        value = spec.get(key) if isinstance(spec, dict) else None
        if key.endswith('sha256'):
            valid = digest(value)
        elif key == 'route':
            valid = isinstance(value, str) and value in ROUTES
        else:
            valid = identity(value)
        result[key] = value if valid else None
    for key, raw in (('receipt_sha256',receipt_bytes), ('request_body_sha256',request_bytes), ('response_sse_sha256',response_bytes)):
        result[key] = sha(raw) if type(raw) is bytes else None
    try:
        grader = _load_pinned('protocol.py', pins.get('grader_sha256'))
        result['grader_sha256'] = pins['grader_sha256']
    except Exception:
        result['evidence_unknown_reason'] = 'grader_source_unverified'
        return result
    plan = None
    if planning_required is True:
        try:
            adapter = _load_pinned('stream_adapters.py', pins.get('adapter_sha256'))
            result['adapter_sha256'] = pins['adapter_sha256']
            route = _verify(spec, receipt_bytes, request_bytes, response_bytes, pins['adapter_sha256'])
            result['capture_verified'] = True
            capture = adapter[ROUTES[route][1]](response_bytes, adapter_sha256=pins['adapter_sha256'],
                                               capture_complete=True, source='provider_response_sse')
            result['adapter_capture_complete'] = capture.get('complete') is True and capture.get('stream_order_preserved') is True
            plan = grader['visible_plan_score'](capture)
            reason = plan.get('reason')
            result['plan_reason'] = reason if isinstance(reason,str) and re.fullmatch('[a-z0-9_]+',reason) else 'unknown_grader_reason'
            if not result['adapter_capture_complete']:
                result['evidence_unknown_reason'] = 'adapter_capture_unknown'
        except EvidenceUnknown as error:
            result['evidence_unknown_reason'] = str(error)
        except Exception:
            result['evidence_unknown_reason'] = 'malformed_or_unsupported_capture_evidence'
    elif planning_required is False:
        result['plan_reason'] = 'planning_not_required'
    else:
        result['evidence_unknown_reason'] = 'invalid_planning_required_flag'
    try:
        scores = grader['score_cell'](**original, planning_required=planning_required is True, plan=plan)
        result.update(scores)
        if type(planning_required) is not bool:
            result['requested_format_contract_pass'] = None
    except Exception:
        result['evidence_unknown_reason'] = 'grader_failed_closed'
    return result
