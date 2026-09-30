"""Offline fixed-policy subprocess. No credentials, ledgers or transport."""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import sys

PIN = 'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf'
MAX = 6 * 1024 * 1024

def envelope(raw):
    # This is a transport envelope, not request content. Base64 expands each
    # binary request; never apply the content-string cap to its encoded form.
    if len(raw) > MAX or raw.startswith(b'\xef\xbb\xbf'): raise ValueError()
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError()
            result[key] = value
        return result
    def constant(_): raise ValueError()
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    if type(value) is not dict or set(value) != {'request', 'policy', 'expected_sha256', 'client', 'ordinal'}: raise ValueError()
    for field, limit in [('request', 4 * ((4 * 1024 * 1024 + 2) // 3)), ('policy', 4 * ((64 * 1024 + 2) // 3))]:
        if type(value[field]) is not str or len(value[field]) > limit or not value[field].isascii(): raise ValueError()
    if type(value['expected_sha256']) is not str or not re.fullmatch('[a-f0-9]{64}', value['expected_sha256']): raise ValueError()
    if value['client'] not in ('light', 'pi'): raise ValueError()
    if type(value['ordinal']) is not int or not 1 <= value['ordinal'] <= 1000: raise ValueError()
    return value

def main():
    result = {"policy_verified": False, "reason": "policy_bridge_refused", "request_sha256": None, "policy_sha256": None}
    try:
        target = Path(__file__).resolve().parent.parent / 'all-call-policy-v1' / 'policy.py'
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode): raise ValueError()
            with os.fdopen(os.dup(fd), 'rb') as stream: source = stream.read(65537)
        finally: os.close(fd)
        if hashlib.sha256(source).hexdigest() != PIN: raise ValueError()
        scope = {'__file__': str(target), '__name__': '_fixed_policy'}
        exec(compile(source, str(target), 'exec'), scope)
        raw = sys.stdin.buffer.read(MAX + 1)
        value = envelope(raw)
        result = scope['check_request'](request_bytes=base64.b64decode(value['request'], validate=True),
            policy_bytes=base64.b64decode(value['policy'], validate=True), expected_policy_sha256=value['expected_sha256'],
            client=value['client'], route='openai-direct', call_ordinal=value['ordinal'])
    except Exception:
        pass
    print(json.dumps(result, separators=(',', ':'), allow_nan=False))

if __name__ == '__main__': main()
