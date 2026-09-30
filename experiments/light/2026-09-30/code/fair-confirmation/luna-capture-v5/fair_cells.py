"""Offline receipt-to-score integration; no runner, provider or ledger access.

Only fixed parent adapter/grader and pinned binding sources are read. Their exact verified bytes
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
BINDING_PIN = '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6'
BRIDGE_PIN = 'd9076c9adf0f0529dd88e118a22ecefb191a5755387951c0e9f836658f840db5'
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
    'binding_source_sha256', 'binding_contract_sha256', 'initial_binding_verified',
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
    source_path = HERE / filename if filename == 'binding_bridge.py' else HERE.parent / filename
    fd = os.open(source_path, os.O_RDONLY | os.O_NOFOLLOW)
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
    source_path = HERE / filename if filename == 'binding_bridge.py' else HERE.parent / filename
    namespace = {'__name__': '_fair_' + filename[:-3], '__file__': str(source_path)}
    # Both compilation and execution use exactly the bytes just hashed, not an
    # already imported module nor a second path read that could have changed.
    exec(compile(raw, str(source_path), 'exec'), namespace)
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


def _verify(spec, receipt_raw, request_raw, response_raw, adapter_pin,
            contract_bytes, binding_expected, deployed_source_pins):
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
    require(type(receipt['schema_version']) is int and receipt['schema_version'] == 2, 'unsupported_receipt_schema')
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
    require(receipt['binding_source_sha256'] == BINDING_PIN
            and receipt['initial_binding_verified'] is True, 'missing_observer_binding')
    require(type(contract_bytes) is bytes and sha(contract_bytes) == receipt['binding_contract_sha256'],
            'binding_contract_receipt_mismatch')
    require(type(binding_expected) is dict and all(binding_expected.get(key) == spec[key]
            for key in ('protocol_id', 'run_id', 'root_turn_id', 'route', 'task_prompt_sha256')),
            'binding_cell_identity_mismatch')
    bridge = _load_pinned('binding_bridge.py', BRIDGE_PIN)
    bound = bridge['bind'](request_bytes=request_raw, contract_bytes=contract_bytes,
        expected=binding_expected, deployed_source_pins=deployed_source_pins,
        admission={key: receipt[key] for key in ('run_id', 'root_turn_id', 'admission_id',
            'call_ordinal', 'prior_root_generations', 'initial_request', 'request_role')})
    require(bound.get('binding_verified') is True, 'initial_binding_unverified')
    return route, bound


def score_fair_cell(*, spec, receipt_bytes, request_bytes, response_bytes, source_pins,
                    planning_required, code_artifact_pass, normal_exit, timed_out, budget_stopped,
                    contract_bytes=None, binding_expected=None, deployed_source_pins=None):
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
    result = {'schema_version': 2, **original, 'planning_required': planning_required if type(planning_required) is bool else None,
              'code_completion': None, 'visible_plan_format_pass': None, 'requested_format_contract_pass': None,
              'plan_semantic_quality': None, 'capture_verified': False, 'adapter_capture_complete': False,
              'adapter_sha256': None, 'grader_sha256': None, 'plan_reason': 'capture_not_verified',
              'evidence_unknown_reason': None, 'outcome_unknown_reason': 'invalid_original_outcome_type' if invalid_outcome else None}
    result.update(binding_verified=None, binding_profile_id=None, binding_contract_sha256=None,
                  binding_envelope_sha256=None, binding_source_sha256=None)
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
            route, bound = _verify(spec, receipt_bytes, request_bytes, response_bytes, pins['adapter_sha256'],
                contract_bytes, binding_expected, deployed_source_pins)
            result.update(binding_verified=True, binding_profile_id=bound['profile_id'],
                binding_contract_sha256=bound['contract_sha256'],
                binding_envelope_sha256=bound['envelope_sha256'], binding_source_sha256=BINDING_PIN)
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
