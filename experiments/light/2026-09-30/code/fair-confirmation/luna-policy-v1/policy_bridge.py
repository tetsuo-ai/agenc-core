"""Offline fixed-policy subprocess. No credentials, ledgers or transport."""
import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

PIN = 'c7472ec39758780d1fd0245af26ff81f05282047b3bf3befa130e50e9384a1bf'
MAX = 6 * 1024 * 1024

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
        value = scope['parse'](raw, MAX)
        if set(value) != {'request', 'policy', 'expected_sha256', 'client', 'ordinal'}: raise ValueError()
        result = scope['check_request'](request_bytes=base64.b64decode(value['request'], validate=True),
            policy_bytes=base64.b64decode(value['policy'], validate=True), expected_policy_sha256=value['expected_sha256'],
            client=value['client'], route='openai-direct', call_ordinal=value['ordinal'])
    except Exception:
        pass
    print(json.dumps(result, separators=(',', ':'), allow_nan=False))

if __name__ == '__main__': main()
