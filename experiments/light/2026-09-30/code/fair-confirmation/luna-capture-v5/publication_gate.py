"""Trusted-parent fixture inventory and offline gate, not a paid runner.

Only a successfully returned finalization digest is authorized for downstream
scoring. Never derive that digest by scanning surviving inventory files.
"""
import hashlib
import json
import os
from pathlib import Path
import stat

HERE = Path(__file__).resolve().parent
FAIR_PIN = 'c87768d477dd3b3ca815021ad1dafb0a4220fdd80135d0ea9e2f6cd9de24c7b7'
BINDING_PIN = '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6'
ACK_FIELDS = {'kind','schema_version','channel_id','protocol_id','run_id','root_turn_id',
    'admission_id','call_ordinal','publication_ordinal','receipt_sha256','request_body_sha256',
    'response_bytes_sha256','response_byte_count','observer_source_sha256','installed_adapter_sha256',
    'binding_source_sha256','binding_contract_sha256'}
EXPECTED_FIELDS = {'channel_id','protocol_id','run_id','root_turn_id','observer_source_sha256',
    'installed_adapter_sha256','publication_count','parent_source_sha256','ipc_parent_source_sha256',
    'binding_source_sha256','binding_contract_sha256'}
INVENTORY_FIELDS = {'schema_version','kind','finalized','ipc_closed','child_exit_code',
                    'publications'} | EXPECTED_FIELDS


class PublicationUnknown(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise PublicationUnknown(reason)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()+b'\n'


def parse(raw):
    require(type(raw) is bytes, 'inventory_bytes_required')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_inventory_key'); result[key] = value
        return result
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
            parse_constant=lambda _: require(False, 'nonfinite_inventory'))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise PublicationUnknown('malformed_inventory') from exc


def digest(value):
    return type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def regular(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'nonregular_artifact')
        with os.fdopen(os.dup(fd), 'rb') as handle:
            return handle.read()
    finally:
        os.close(fd)


def validate_expected(expected):
    require(type(expected) is dict and set(expected) == EXPECTED_FIELDS, 'invalid_parent_expected')
    for key in ('channel_id','protocol_id','run_id','root_turn_id'):
        value = expected[key]
        require(type(value) is str and 1 <= len(value) <= 240
                and all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-' for c in value),
                'invalid_parent_identity')
    for key in ('observer_source_sha256','installed_adapter_sha256','parent_source_sha256','ipc_parent_source_sha256',
                'binding_source_sha256','binding_contract_sha256'):
        require(digest(expected[key]), 'invalid_parent_pin')
    require(expected['binding_source_sha256'] == BINDING_PIN, 'binding_source_pin_mismatch')
    require(type(expected['publication_count']) is int and expected['publication_count'] > 0,
            'invalid_publication_count')


def validate_acks(acks, expected):
    validate_expected(expected)
    require(type(acks) is list and len(acks) == expected['publication_count'], 'missing_or_extra_publication_ack')
    for index, ack in enumerate(acks, 1):
        require(type(ack) is dict and set(ack) == ACK_FIELDS, 'invalid_publication_ack')
        require(type(ack['schema_version']) is int and ack['schema_version'] == 1
                and ack['kind'] == 'luna.capture.published.v5', 'invalid_publication_ack')
        for key in ('channel_id','protocol_id','run_id','root_turn_id','observer_source_sha256','installed_adapter_sha256',
                    'binding_source_sha256','binding_contract_sha256'):
            require(ack[key] == expected[key], 'publication_identity_mismatch')
        require(type(ack['call_ordinal']) is int and ack['call_ordinal'] == index
                and type(ack['publication_ordinal']) is int and ack['publication_ordinal'] == index
                and ack['admission_id'] == expected['run_id']+':'+str(index), 'publication_order_mismatch')
        for key in ('receipt_sha256','request_body_sha256','response_bytes_sha256'):
            require(digest(ack[key]), 'invalid_publication_hash')
        require(type(ack['response_byte_count']) is int and ack['response_byte_count'] >= 0,
                'invalid_publication_size')


def verify_artifacts(ack, receipt_bytes, request_bytes, response_bytes):
    for raw, key in ((receipt_bytes,'receipt_sha256'), (request_bytes,'request_body_sha256'),
                     (response_bytes,'response_bytes_sha256')):
        require(type(raw) is bytes and sha(raw) == ack[key], 'publication_artifact_hash_mismatch')
    require(len(response_bytes) == ack['response_byte_count'], 'publication_artifact_size_mismatch')
    receipt = parse(receipt_bytes)
    require(type(receipt) is dict, 'invalid_capture_receipt')
    for key in ('protocol_id','run_id','root_turn_id','admission_id','call_ordinal',
                'request_body_sha256','response_bytes_sha256','response_byte_count',
                'observer_source_sha256','installed_adapter_sha256','binding_source_sha256','binding_contract_sha256'):
        require(type(receipt.get(key)) is type(ack[key]) and receipt[key] == ack[key], 'publication_receipt_mismatch')


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def finalize_parent_inventory(*, directory, acks, expected, child_exit_code, ipc_closed):
    """Called ONLY by trusted parent with its own IPC/exit observations.

    Successful return is the commit capability (digest) to keep in trusted run
    inventory. An exception means no capability, even if files survived a fault.
    This never reads or modifies financial journals or launch controls.
    """
    require(type(child_exit_code) is int and child_exit_code == 0 and ipc_closed is True,
            'parent_channel_not_cleanly_finalized')
    validate_acks(acks, expected)
    require(expected['parent_source_sha256'] == sha(regular(HERE/'publication_gate.py')), 'parent_source_pin_mismatch')
    require(expected['ipc_parent_source_sha256'] == sha(regular(HERE/'parent_fixture.mjs')), 'ipc_parent_source_pin_mismatch')
    directory = Path(directory)
    for ack in acks:
        suffix = f"{ack['call_ordinal']:03}"
        verify_artifacts(ack, regular(directory/f'capture-receipt-{suffix}.json'),
                         regular(directory/f'capture-request-{suffix}.json'),
                         regular(directory/f'capture-response-{suffix}.sse'))
    inventory = {**expected, 'schema_version':1, 'kind':'trusted-parent-publications-v5',
        'finalized':True, 'ipc_closed':True, 'child_exit_code':0, 'publications':acks}
    raw = encode(inventory)
    pending = directory/'parent-inventory.json.pending'
    final = directory/'parent-inventory.json'
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        offset = 0
        while offset < len(raw):
            count = os.write(fd, raw[offset:]); require(count > 0, 'parent_inventory_write_failed'); offset += count
        os.fsync(fd)
    finally:
        os.close(fd)
    sync_directory(directory)
    os.link(pending, final, follow_symlinks=False)
    sync_directory(directory)
    # No catch/withdraw/scan fallback. A failed sync never returns this digest.
    return {'inventory_bytes':raw, 'trusted_inventory_sha256':sha(raw)}


def publication_verified(*, inventory_bytes, trusted_inventory_sha256, expected, receipt_bytes,
                         request_bytes, response_bytes):
    validate_expected(expected)
    require(digest(trusted_inventory_sha256) and type(inventory_bytes) is bytes
            and sha(inventory_bytes) == trusted_inventory_sha256, 'missing_or_untrusted_parent_commit')
    inventory = parse(inventory_bytes)
    require(type(inventory) is dict and set(inventory) == INVENTORY_FIELDS, 'invalid_parent_inventory')
    require(type(inventory['schema_version']) is int and inventory['schema_version'] == 1
            and inventory['kind'] == 'trusted-parent-publications-v5'
            and inventory['finalized'] is True and inventory['ipc_closed'] is True
            and type(inventory['child_exit_code']) is int and inventory['child_exit_code'] == 0,
            'unfinalized_parent_inventory')
    for key in EXPECTED_FIELDS:
        require(type(inventory[key]) is type(expected[key]) and inventory[key] == expected[key], 'parent_inventory_identity_mismatch')
    validate_acks(inventory['publications'], expected)
    # Explicit first-root publication, never a scan for later successful text.
    verify_artifacts(inventory['publications'][0], receipt_bytes, request_bytes, response_bytes)
    return True


def score_published_cell(*, inventory_bytes, trusted_inventory_sha256, publication_expected,
                         fair_cell_kwargs, expected_fair_cells_sha256):
    """Mandatory prospective entry point; never call fair_cells directly for v5."""
    source = regular(HERE/'fair_cells.py')
    require(expected_fair_cells_sha256 == FAIR_PIN and sha(source) == FAIR_PIN, 'fair_cells_source_pin_mismatch')
    namespace = {'__file__':str(HERE/'fair_cells.py'), '__name__':'_publication_fair_cells'}
    exec(compile(source, namespace['__file__'], 'exec'), namespace)
    kwargs = dict(fair_cell_kwargs)
    reason = None
    try:
        publication_verified(inventory_bytes=inventory_bytes, trusted_inventory_sha256=trusted_inventory_sha256,
            expected=publication_expected, receipt_bytes=kwargs.get('receipt_bytes'),
            request_bytes=kwargs.get('request_bytes'), response_bytes=kwargs.get('response_bytes'))
        require(publication_expected['parent_source_sha256'] == sha(regular(HERE/'publication_gate.py')),
                'parent_source_pin_mismatch')
        require(publication_expected['ipc_parent_source_sha256'] == sha(regular(HERE/'parent_fixture.mjs')),
                'ipc_parent_source_pin_mismatch')
        spec = kwargs.get('spec')
        require(type(spec) is dict and all(spec.get(key) == publication_expected[key]
                for key in ('protocol_id','run_id','root_turn_id','observer_source_sha256')),
                'parent_cell_identity_mismatch')
        binding_expected = kwargs.get('binding_expected')
        require(type(binding_expected) is dict
                and binding_expected.get('contract_sha256') == publication_expected['binding_contract_sha256'],
                'parent_binding_contract_mismatch')
    except (PublicationUnknown, OSError, TypeError, KeyError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, PublicationUnknown) else 'malformed_publication_evidence'
        # Preserve original code/exit/timeout/budget facts, but make capture
        # impossible to verify even if a failed publication left a valid file.
        kwargs['receipt_bytes'] = None
    result = namespace['score_fair_cell'](**kwargs)
    result['publication_verified'] = True if reason is None else None
    result['publication_unknown_reason'] = reason
    return result
