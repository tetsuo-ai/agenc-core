"""Current bd88 base-layout reducer, not installation or closure attestation.

Uses the unchanged, pinned v2 reducer in a fresh private namespace, replacing
only its profile table with one current source-only profile. No historical
profile fallback. Expected contracts must be independently sealed by the owner.
"""
import hashlib
import os
from pathlib import Path
import stat

HERE = Path(__file__).resolve().parent
REVISION = 'bd88a251870c3f081997fbbecdf12fcfb4877d8d'
PROFILE = 'light-luna-bd88-source-base-v1'
REDUCER_PIN = '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6'
SELECTION_PIN = '8d90e6c628255fe5e4930359e3ba73d252fb6c4512cfeb834d235cc1fc638218'


def pinned_bytes(path, pin):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 256 * 1024:
            raise ValueError('invalid selected file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(256 * 1024 + 1)
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest() != pin:
        raise ValueError('selected file mismatch')
    return raw


def load():
    source = HERE.parent / 'prompt-binding-v2' / 'prompt_binding.py'
    raw = pinned_bytes(source, REDUCER_PIN)
    namespace = {'__file__': str(source), '__name__': '_current_base_binding_reducer'}
    exec(compile(raw, str(source), 'exec'), namespace)
    selected = namespace['parse'](pinned_bytes(
        HERE.parent / 'current-initial-preflight-v2' / 'source-pins.json', SELECTION_PIN))
    # The complete map is pinned above. This is the selected 59-file inventory,
    # explicitly not a transitive dependency or built-artifact closure.
    sources = {'runtime/' + name: digest for name, digest in selected.items()}
    namespace['PROFILES'] = {PROFILE: (
        'light', 'openai-direct', (namespace['TASK_L'], namespace['TAIL_L']), True, sources)}
    return namespace, sources


def bind_initial_request(*, request_bytes, contract_bytes, expected, admission, deployed_source_pins):
    if (type(request_bytes) is not bytes or len(request_bytes) > 1024 * 1024 or
            type(contract_bytes) is not bytes or len(contract_bytes) > 256 * 1024):
        return {'binding_verified': None, 'unknown_reason': 'binding_size_limit'}
    try:
        namespace, _ = load()
        return namespace['bind_initial_request'](
            request_bytes=request_bytes, contract_bytes=contract_bytes,
            expected=expected, admission=admission, deployed_source_pins=deployed_source_pins)
    except Exception:
        return {'binding_verified': None, 'unknown_reason': 'current_binding_selection_refused'}
