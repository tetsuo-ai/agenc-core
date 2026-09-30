"""UNEXECUTED DRAFT. Gate the unchanged shared scorer with a trusted commit.

The digest must be retained from finalizeAttempt's successful clean return by
the trusted parent. Computing it from surviving files is expressly NOT allowed.
This module neither owns processes nor creates that authority.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat

HERE = Path(__file__).resolve().parent
SCORER = '73c3cf7ca4360a94f5ec334cf751573a15ee4af3863e3f1571ad5d84f549f780'
RECONCILE = 'dbc239d6d13f611143b473476a40ac2421eca0bb51277fb19375ea336a606dc9'
ADAPTER = 'fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323'
GRADER = '7f6cfcb6115ebf118497c8ae1611094e19c31526409552585658bdfc7274c933'
OBSERVER = '8f0c1702bcf45ce8f212b4e5181ad01e1bc9ca1754e8968f4d79fb4b4e8e163a'
BINDING = '9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112'
PROFILES = {'light': 'light-luna-44aed-source-base-v2', 'pi': 'pi-luna-v0731-shared-v1'}
EXPECTED_KEYS = {'run_id','root_turn_id','client','binding_profile_id','protocol_id','channel_id',
    'financial_policy_id','observer_source_sha256','installed_adapter_sha256','binding_source_sha256',
    'binding_contract_sha256','task_prompt_sha256','parent_source_sha256','finalizer_source_sha256',
    'owner_pid','task_pid','daemon_identity_sha256'}
OUTCOME_KEYS = {'normal_exit','timed_out','budget_stopped','code_artifact_pass','planning_required'}
INVENTORY_KEYS = {'schema_version','kind','expected','source_pins','artifact_directory_identity',
    'outcome','lifecycle','ledger','accounting','acknowledgments','artifacts',
    'terminal_accounting_complete','clean_publication_candidate','reasons'}


class PublicationUnknown(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise PublicationUnknown(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def digest(value):
    return type(value) is str and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def regular(filename, limit):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, 'artifact_type_or_size')
        with os.fdopen(os.dup(fd), 'rb') as handle:
            raw = handle.read(before.st_size + 1)
        after, named = os.fstat(fd), os.lstat(filename)
        require(len(raw) == before.st_size and
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                stat.S_ISREG(named.st_mode) and
                (named.st_dev, named.st_ino, named.st_size, named.st_mtime_ns, named.st_ctime_ns) ==
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns),
                'artifact_changed')
        return raw
    finally:
        os.close(fd)


def parse(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'duplicate_inventory_key')
            value[key] = item
        return value
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=unique,
            parse_constant=lambda _: require(False, 'nonfinite_inventory'))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise PublicationUnknown('malformed_inventory') from exc
    return value


def source_scorer():
    filename = HERE.parent / 'shared-score-v1' / 'fair_cells.py'
    raw = regular(filename, 256 * 1024)
    require(sha(raw) == SCORER, 'scorer_source_unverified')
    namespace = {'__name__': '_shared_finalizer_scorer', '__file__': str(filename)}
    exec(compile(raw, str(filename), 'exec'), namespace)
    return namespace['score_fair_cell']


def validate_expected(expected):
    require(type(expected) is dict and set(expected) == EXPECTED_KEYS, 'invalid_parent_expected')
    require(expected.get('client') in PROFILES and PROFILES[expected['client']] == expected['binding_profile_id'],
            'invalid_parent_arm')
    for key in EXPECTED_KEYS - {'owner_pid','task_pid','daemon_identity_sha256'}:
        value = expected[key]
        require(digest(value) if key.endswith('sha256') or key == 'financial_policy_id' else
                type(value) is str and re.fullmatch(r'[A-Za-z0-9_.-]{1,240}', value), 'invalid_parent_expected')
    require(expected['observer_source_sha256'] == OBSERVER and expected['installed_adapter_sha256'] == ADAPTER
            and expected['binding_source_sha256'] == BINDING, 'unsupported_current_sources')
    require(type(expected['owner_pid']) is int and expected['owner_pid'] > 0, 'invalid_owner_pid')
    require(expected['task_pid'] is None and expected['daemon_identity_sha256'] is None if expected['client'] == 'pi' else
            type(expected['task_pid']) is int and expected['task_pid'] > 0 and expected['task_pid'] != expected['owner_pid']
            and digest(expected['daemon_identity_sha256']), 'invalid_owned_task')


def check_directory(directory, selected):
    require(type(selected) is dict and set(selected) == {'dev','ino'} and
            all(type(v) is str and re.fullmatch('[0-9]{1,32}', v) for v in selected.values()), 'invalid_directory_identity')
    require(type(directory) is str and os.path.isabs(directory) and os.path.realpath(directory) == directory,
            'invalid_artifact_directory')
    st = os.lstat(directory)
    require(stat.S_ISDIR(st.st_mode) and selected == {'dev': str(st.st_dev), 'ino': str(st.st_ino)},
            'artifact_directory_changed')


def score_committed_attempt(*, directory, directory_identity, trusted_clean_commit_sha256,
                            expected, outcome, binding_expected, deployed_source_pins):
    """Trusted parent input only, not a command-line file-rescan recovery API.

    outcome is independently retained code/exit evidence; publication refusal
    leaves that evidence intact. No receipt later than call one can be selected.
    The accepted scorer still owns all request binding and grading semantics.
    """
    scorer = source_scorer()
    # Preserve the existing scorer's own treatment of malformed/unknown outcomes.
    original = outcome if type(outcome) is dict else {}
    spec = {key: expected.get(key) for key in ('client','binding_profile_id','protocol_id','run_id','root_turn_id',
            'task_prompt_sha256','observer_source_sha256')} if type(expected) is dict else {}
    spec['route'] = 'openai-direct'
    receipt = request = response = contract = None
    reason = None
    try:
        validate_expected(expected)
        require(type(outcome) is dict and set(outcome) == OUTCOME_KEYS and type(outcome['planning_required']) is bool
                and all(value is None or type(value) is bool for key,value in outcome.items() if key != 'planning_required'),
                'invalid_outcome')
        require(digest(trusted_clean_commit_sha256), 'missing_trusted_clean_commit')
        check_directory(directory, directory_identity)
        raw = regular(Path(directory) / 'parent-attempt-v1.json', 16 * 1024 * 1024)
        require(sha(raw) == trusted_clean_commit_sha256, 'parent_commit_hash_mismatch')
        inventory = parse(raw)
        require(type(inventory) is dict and set(inventory) == INVENTORY_KEYS and
                type(inventory['schema_version']) is int and inventory['schema_version'] == 1 and
                inventory['kind'] == 'shared-parent-attempt-v1', 'invalid_inventory_schema')
        require(inventory['expected'] == expected and inventory['outcome'] == outcome and
                inventory['artifact_directory_identity'] == directory_identity, 'inventory_selection_mismatch')
        require(inventory['source_pins'] == {'finalizer': expected['finalizer_source_sha256'],
                'parent': expected['parent_source_sha256'], 'reconcile': RECONCILE, 'scorer': SCORER},
                'inventory_source_mismatch')
        require(sha(regular(HERE / 'finalize.mjs', 256 * 1024)) == expected['finalizer_source_sha256'],
                'finalizer_source_mismatch')
        require(inventory['clean_publication_candidate'] is True and inventory['terminal_accounting_complete'] is True
                and inventory['reasons'] == [], 'parent_not_clean')
        accounting, acks, artifacts = inventory['accounting'], inventory['acknowledgments'], inventory['artifacts']
        require(type(accounting) is dict and accounting.get('completeUsage') is True and
                accounting.get('ackInventoryComplete') is True and accounting.get('finalizationAuthorized') is False,
                'accounting_not_complete')
        count = accounting.get('admittedCalls')
        require(type(count) is int and 1 <= count <= 10000 and type(acks) is list and type(artifacts) is list
                and len(acks) == len(artifacts) == len(accounting.get('calls', [])) == count, 'inventory_count_mismatch')
        for n, (call, ack, artifact) in enumerate(zip(accounting['calls'], acks, artifacts), 1):
            require(type(call) is dict and type(ack) is dict and type(artifact) is dict and
                    call.get('ordinal') == n and call.get('state') == 'known' and ack.get('call_ordinal') == n
                    and artifact.get('ordinal') == n and artifact.get('verified') is True and artifact.get('clean') is True,
                    'inventory_order_or_state_mismatch')
            capture = []
            for basename, suffix, limit, key in [('receipt','json',32768,'receipt_sha256'),
                    ('request','json',1024*1024,'request_body_sha256'), ('response','sse',64*1024*1024,'response_bytes_sha256')]:
                body = regular(Path(directory) / f'capture-{basename}-{n:03d}.{suffix}', limit)
                require(digest(ack.get(key)) and sha(body) == ack[key] == artifact.get(key), 'capture_changed_after_commit')
                capture.append(body)
            require(len(capture[2]) == ack.get('response_byte_count') == artifact.get('response_byte_count'), 'response_size_mismatch')
            if n == 1:
                receipt, request, response = capture
                spec.update(receipt_sha256=ack['receipt_sha256'], request_body_sha256=ack['request_body_sha256'])
        contract = regular(Path(directory) / 'contract.json', 2 * 1024 * 1024)
        require(sha(contract) == expected['binding_contract_sha256'], 'binding_contract_changed')
        check_directory(directory, directory_identity)
    except PublicationUnknown as exc:
        reason = str(exc)
    except Exception:
        reason = 'parent_publication_unverified'
    if reason is not None:
        receipt = request = response = contract = None
    result = scorer(spec=spec, receipt_bytes=receipt, request_bytes=request, response_bytes=response,
        source_pins={'adapter_sha256': ADAPTER, 'grader_sha256': GRADER},
        planning_required=original.get('planning_required'), code_artifact_pass=original.get('code_artifact_pass'),
        normal_exit=original.get('normal_exit'), timed_out=original.get('timed_out'), budget_stopped=original.get('budget_stopped'),
        contract_bytes=contract, binding_expected=binding_expected, deployed_source_pins=deployed_source_pins)
    result.update(parent_publication_verified=reason is None, parent_evidence_unknown_reason=reason)
    return result
