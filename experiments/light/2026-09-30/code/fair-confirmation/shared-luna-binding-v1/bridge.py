"""Bounded stdin bridge shared by both explicit Luna client profiles."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

HERE = Path(__file__).resolve().parent
BINDING_PIN = '9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112'
MAX_PAYLOAD = 2 * 1024 * 1024


def load_binding():
    path = HERE / 'binding.py'
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 256 * 1024:
            raise ValueError('binding source invalid')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            raw = stream.read(256 * 1024 + 1)
    finally:
        os.close(fd)
    if hashlib.sha256(raw).hexdigest() != BINDING_PIN:
        raise ValueError('binding source mismatch')
    namespace = {'__file__': str(path), '__name__': '_shared_binding_bridge'}
    exec(compile(raw, str(path), 'exec'), namespace)
    return namespace


def main():
    try:
        payload = sys.stdin.buffer.read(MAX_PAYLOAD + 1)
        if len(payload) > MAX_PAYLOAD:
            raise ValueError('payload limit')
        binding = load_binding()
        codec, _ = binding['load']()
        value = codec['parse'](payload)
        if set(value) != {'request_base64', 'contract_base64', 'expected',
                          'admission', 'deployed_source_pins'}:
            raise ValueError('payload inventory')
        result = binding['bind_initial_request'](
            request_bytes=base64.b64decode(value['request_base64'], validate=True),
            contract_bytes=base64.b64decode(value['contract_base64'], validate=True),
            expected=value['expected'], admission=value['admission'],
            deployed_source_pins=value['deployed_source_pins'])
    except Exception:
        result = {'binding_verified': None, 'unknown_reason': 'shared_binding_bridge_refused'}
    sys.stdout.write(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n')


if __name__ == '__main__':
    main()
