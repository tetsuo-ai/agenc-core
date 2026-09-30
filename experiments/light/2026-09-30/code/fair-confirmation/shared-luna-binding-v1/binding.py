"""Explicit two-arm selector; synthetic validation is not deployment attestation.

Both arms load the same pinned reducer and Light inventory. Pi retains its
separate reviewed developer/user layout and selected seven-source inventory.
No profile is inferred from wire bytes and no historical Light fallback exists.
"""
import hashlib
import os
from pathlib import Path
import stat

HERE = Path(__file__).resolve().parent
BASE_PIN = '3815c1fbbbbc9b2aaf23a9adcd469d5f5b0a2c4bb38ca42dfed9e826a491f87c'
LIGHT_PROFILE = 'light-luna-44aed-source-base-v2'
PI_PROFILE = 'pi-luna-v0731-shared-v1'


def load():
    path = HERE.parent / 'current-base-binding-v2' / 'binding.py'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 256 * 1024:
            raise ValueError('invalid base selector')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(256 * 1024 + 1)
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest() != BASE_PIN:
        raise ValueError('base selector mismatch')
    base = {'__file__': str(path), '__name__': '_shared_luna_base'}
    exec(compile(raw, str(path), 'exec'), base)
    codec, sources = base['load']()
    codec['PROFILES'][PI_PROFILE] = (
        'pi', 'openai-direct',
        (('static_system', 'developer', 'string', None),
         ('task', 'user', 'input_text', None)), False, codec['PI_RESPONSES'])
    if set(codec['PROFILES']) != {LIGHT_PROFILE, PI_PROFILE}:
        raise ValueError('unexpected profile inventory')
    return codec, sources


def bind_initial_request(*, request_bytes, contract_bytes, expected, admission, deployed_source_pins):
    if (type(request_bytes) is not bytes or len(request_bytes) > 1024 * 1024 or
            type(contract_bytes) is not bytes or len(contract_bytes) > 256 * 1024):
        return {'binding_verified': None, 'unknown_reason': 'binding_size_limit'}
    try:
        codec, _ = load()
        return codec['bind_initial_request'](
            request_bytes=request_bytes, contract_bytes=contract_bytes,
            expected=expected, admission=admission, deployed_source_pins=deployed_source_pins)
    except Exception:
        return {'binding_verified': None, 'unknown_reason': 'shared_binding_selection_refused'}
