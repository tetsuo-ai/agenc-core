"""Pinned offline binding seam. No provider, journal, or expected-hash generation."""
import base64
import hashlib
import os
from pathlib import Path
import stat
import sys

HERE = Path(__file__).resolve().parent
BINDING_PIN = '513a9eb249c593fb3bff7c2b69601ec5d2c6a141b9c2f5796b61b7144776c4e6'
MAX_PAYLOAD = 2 * 1024 * 1024
MAX_REQUEST = 1024 * 1024
MAX_CONTRACT = 256 * 1024


def load_binding():
    path = HERE.parent / 'prompt-binding-v2' / 'prompt_binding.py'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CONTRACT:
            raise ValueError('binding source invalid')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(MAX_CONTRACT + 1)
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest() != BINDING_PIN:
        raise ValueError('binding source mismatch')
    namespace = {'__file__': str(path), '__name__': '_capture_v5_binding'}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace


def bind(*, request_bytes, contract_bytes, expected, admission, deployed_source_pins):
    if (type(request_bytes) is not bytes or len(request_bytes) > MAX_REQUEST or
        type(contract_bytes) is not bytes or len(contract_bytes) > MAX_CONTRACT):
        return {'binding_verified': None, 'unknown_reason': 'binding_size_limit'}
    return load_binding()['bind_initial_request'](request_bytes=request_bytes,
        contract_bytes=contract_bytes, expected=expected, admission=admission,
        deployed_source_pins=deployed_source_pins)


def main():
    # The caller supplies preauthorized expectations, not text extracted from
    # this request. Bytes travel on stdin, never in argv or environment.
    try:
        payload = sys.stdin.buffer.read(MAX_PAYLOAD + 1)
        if len(payload) > MAX_PAYLOAD:
            raise ValueError('payload limit')
        value = load_binding()['parse'](payload)
        if set(value) != {'request_base64', 'contract_base64', 'expected',
                          'admission', 'deployed_source_pins'}:
            raise ValueError('payload inventory')
        result = bind(request_bytes=base64.b64decode(value['request_base64'], validate=True),
            contract_bytes=base64.b64decode(value['contract_base64'], validate=True),
            expected=value['expected'], admission=value['admission'],
            deployed_source_pins=value['deployed_source_pins'])
    except Exception:
        result = {'binding_verified': None, 'unknown_reason': 'binding_bridge_refused'}
    import json
    sys.stdout.write(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
